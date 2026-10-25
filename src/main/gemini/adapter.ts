import { GoogleGenAI, type GenerateContentParameters } from '@google/genai';
import { Usage, UsageRecord, UpscaleFactor } from '../../shared/types';
import { settingsManager } from '../settings';
import * as fs from 'fs';
import * as path from 'path';
import { sanitizeFilename } from '../ffmpeg';
import { parseOffset } from './transcript-timing';


export class GeminiAdapter {
	private client: GoogleGenAI;
	private apiKey: string;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
		this.client = new GoogleGenAI({
			apiKey,
			apiVersion: 'v1beta' // required for gemini-3.1-flash-image-preview
		});
	}

	/**
	 * Static factory method to create an instance with an API key from settings.
	 */
	static create(): GeminiAdapter {
		const apiKey = settingsManager.getGeminiApiKey();
		if (!apiKey) {
			throw new Error('Gemini API key not found in settings. Please provide it in the API Key page.');
		}
		return new GeminiAdapter(apiKey);
	}

	private extractUsage(response: any): Usage {
		if (!response) {
			return { promptTokens: 0, candidatesTokens: 0, thinkingTokens: 0, totalTokens: 0 };
		}
		const usage = response.usageMetadata || { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0, thoughtsTokenCount: 0 };
		return {
			promptTokens: usage.promptTokenCount || 0,
			candidatesTokens: usage.candidatesTokenCount || 0,
			thinkingTokens: usage.thoughtsTokenCount || 0,
			totalTokens: usage.totalTokenCount || 0
		};
	}

	private extractResultText(response: any): string {
		const candidate = response.candidates?.[0];
		if (!candidate || !candidate.content || !candidate.content.parts) {
			return '';
		}

		// Filter out parts that are explicitly marked as thoughts
		const resultParts = candidate.content.parts.filter((p: any) => !p.thought && p.text);
		
		// If no non-thought text parts found, but there are text parts, 
		// it might be that the SDK didn't mark them but we have multiple.
		// Usually the last text part is the result.
		if (resultParts.length === 0) {
			const allTextParts = candidate.content.parts.filter((p: any) => p.text);
			return allTextParts.length > 0 ? allTextParts[allTextParts.length - 1].text : '';
		}

		return resultParts.map((p: any) => p.text).join('\n');
	}

	private async withRetry<T>(
		operation: () => Promise<T>,
		signal?: AbortSignal,
		maxRetries: number = 3
	): Promise<T> {
		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				return await operation();
			} catch (error: any) {
				if (signal?.aborted) throw error;

				const isTransient = this.isTransientError(error);
				if (!isTransient || attempt === maxRetries) {
					throw error;
				}

				const delay = Math.pow(2, attempt) * 1000;
				console.warn(`[GEMINI ADAPTER] Attempt ${attempt} failed. Retrying in ${delay}ms... Status: ${error.status || 'Unknown'}. Message: ${error.message}`);

				await new Promise(resolve => {
					const timer = setTimeout(resolve, delay);
					if (signal) {
						signal.addEventListener('abort', () => {
							clearTimeout(timer);
							resolve(null);
						}, { once: true });
					}
				});

				if (signal?.aborted) throw new Error('Operation aborted during retry backoff');
			}
		}
		throw new Error('Unexpected fallback in withRetry');
	}

	private isTransientError(error: any): boolean {
		const message = (error.message || '').toLowerCase();
		const status = (error.status || (error.error && error.error.code) || '').toString();
		const code = (error.code || error.cause?.code || '').toString();

		const transientStatuses = ['503', '429', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'DEADLINE_EXCEEDED'];
		if (transientStatuses.includes(status)) return true;

		const transientCodes = ['UND_ERR_HEADERS_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
		if (transientCodes.includes(code)) return true;

		if (
			message.includes('503') ||
			message.includes('429') ||
			message.includes('high demand') ||
			message.includes('too many requests') ||
			message.includes('service unavailable') ||
			message.includes('deadline exceeded') ||
			message.includes('fetch failed') ||
			message.includes('timeout')
		) {
			return true;
		}

		return false;
	}

	/**
	 * Generates a non-structured result from Gemini.
	 */
	async generateText(
		modelName: string,
		userPrompt: string,
		systemInstruction?: string,
		signal?: AbortSignal,
		imagePaths?: string[]
	): Promise<{ text: string, record: UsageRecord }> {
		const parts: any[] = []

		// Add image parts if provided
		const validImagePaths: string[] = []
		if (imagePaths && imagePaths.length > 0) {
			for (const imgPath of imagePaths) {
				if (fs.existsSync(imgPath)) {
					const data = fs.readFileSync(imgPath).toString('base64')
					parts.push({
						inlineData: {
							data,
							mimeType: 'image/jpeg'
						}
					})
					validImagePaths.push(imgPath)
				}
			}
		}

		// Add text part LAST
		parts.push({ text: userPrompt })

		const request: any = {
			model: modelName,
			contents: [{ role: 'user', parts }]
		};

		// The SDK only reads systemInstruction from request.config; a top-level
		// field is silently dropped.
		if (systemInstruction) {
			request.config = { ...request.config, systemInstruction };
		}

		try {
			const response = await this.withRetry(
				() => (this.client as any).models.generateContent(request, { signal }),
				signal
			);
			const usage = this.extractUsage(response);
			const cost = GeminiAdapter.calculateCost(modelName, usage, 0, validImagePaths.length);

			return {
				text: this.extractResultText(response),
				record: { usage, cost }
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			console.error(`[GEMINI ADAPTER] generateText failed:`, error);
			throw error;
		}
	}

	/**
	 * Generates a structured result (JSON) from Gemini based on a schema.
	 */
	async generateStructuredText<T>(
		modelName: string,
		userPrompt: string,
		schema: any,
		systemInstruction?: string,
		signal?: AbortSignal,
		imagePaths?: string[],
		options?: {
			includeThinking?: boolean
			maxOutputTokens?: number
			thinkingBudget?: number
			thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH'
			temperature?: number
			/**
			 * Fired as soon as usage is known, BEFORE the JSON parse — a response
			 * that dies on MAX_TOKENS still billed for its tokens, and callers that
			 * account per-call (editor turns) must not lose that spend.
			 */
			onUsage?: (record: UsageRecord) => void
		}
	): Promise<{ data: T, record: UsageRecord }> {
		const parts: any[] = []

		// Add image parts if provided
		const validImagePaths: string[] = []
		if (imagePaths && imagePaths.length > 0) {
			for (const imgPath of imagePaths) {
				if (fs.existsSync(imgPath)) {
					const data = fs.readFileSync(imgPath).toString('base64')
					parts.push({
						inlineData: {
							data,
							mimeType: 'image/jpeg'
						}
					})
					validImagePaths.push(imgPath)
				}
			}
		}

		// Add text part LAST
		parts.push({ text: userPrompt })

		const request: GenerateContentParameters = {
			model: modelName,
			contents: [{ role: 'user', parts }],
			config: {
				responseMimeType: 'application/json',
				responseSchema: schema
			}
		};

		if (systemInstruction) {
			request.config!.systemInstruction = systemInstruction;
		}

		if (options?.includeThinking) {
			(request.config as any).thinkingConfig = {
				includeThoughts: true,
				thinkingBudget: 8000
			};
		}

		// Explicit generation limits. Thinking draws from the SAME output budget on
		// Gemini 3, so an unbounded thinking pass can starve the JSON body — the
		// truncated body then fails to parse below with no hint of the cause.
		// Thinking tokens also bill at the OUTPUT rate (see calculateCost).
		if (options?.maxOutputTokens != null) {
			(request.config as any).maxOutputTokens = options.maxOutputTokens;
		}
		if (options?.temperature != null) {
			(request.config as any).temperature = options.temperature;
		}
		if (options?.thinkingLevel || options?.thinkingBudget != null) {
			const thinkingConfig = (request.config as any).thinkingConfig || {};
			if (options.thinkingLevel) thinkingConfig.thinkingLevel = options.thinkingLevel;
			if (options.thinkingBudget != null) thinkingConfig.thinkingBudget = options.thinkingBudget;
			(request.config as any).thinkingConfig = thinkingConfig;
		}

		const response = await this.withRetry(
			() => (this.client.models as any).generateContent(request, { signal }) as Promise<any>,
			signal
		);

		const usage = this.extractUsage(response);
		const cost = GeminiAdapter.calculateCost(modelName, usage, 0, validImagePaths.length);
		const text = this.extractResultText(response);
		options?.onUsage?.({ usage, cost });

		try {
			return {
				data: JSON.parse(text) as T,
				record: { usage, cost }
			};
		} catch (parseError: any) {
			const finishReason = response?.candidates?.[0]?.finishReason;
			console.error(`[GEMINI ADAPTER] Failed to parse structured response (finishReason: ${finishReason}):`, text);
			// MAX_TOKENS is by far the most common cause on long structured outputs —
			// surface it instead of a bare "Unexpected end of JSON input".
			throw new Error(
				`Model response was not valid JSON${finishReason ? ` (finishReason: ${finishReason})` : ''}: ${parseError?.message || parseError}`
			);
		}
	}

	/**
	 * Uploads a file to the Gemini File API.
	 */
	async uploadFile(filePath: string, mimeType: string): Promise<string> {
		console.log('--- [DEBUG] uploadFile starting ---');
		const rawName = path.basename(filePath);

		const isASCII = /^[\x00-\x7F]*$/.test(filePath);
		let uploadPath = filePath;
		let isTemp = false;

		// If path is not ASCII, create a temporary safe copy
		if (!isASCII) {
			const safeName = sanitizeFilename(rawName);
			const tempPath = path.join(path.dirname(filePath), `gemini_upload_tmp_${Date.now()}_${safeName}`);
			fs.copyFileSync(filePath, tempPath);
			uploadPath = tempPath;
			isTemp = true;
		}

		// Sanitize displayName to ASCII only to avoid terminal TypeError: Cannot convert argument to a ByteString
		const sanitizedName = sanitizeFilename(rawName);

		try {
			const response = await this.withRetry(
				() => this.client.files.upload({
					file: uploadPath,
					config: {
						mimeType,
						displayName: sanitizedName
					}
				}),
				undefined // upload doesn't support signal directly in our usage context here, but we could add it if needed
			);
			return response.uri || '';
		} finally {
			if (isTemp && fs.existsSync(uploadPath)) {
				try { fs.unlinkSync(uploadPath); } catch (e) { console.error('Failed to remove temp upload file:', e); }
			}
		}
	}


	/**
	 * Generates a text result from Gemini using files.
	 */
	async generateTextFromFiles(
		modelName: string,
		userPrompt: string,
		fileUris: string[],
		systemInstruction?: string,
		audioDuration: number = 0,
		signal?: AbortSignal,
		options?: { maxOutputTokens?: number; temperature?: number }
	): Promise<{ text: string, record: UsageRecord, finishReason?: string }> {
		const contents = [
			{
				role: 'user',
				parts: [
					...fileUris.map((uri) => ({ fileData: { fileUri: uri, mimeType: 'audio/mpeg' } })),
					{ text: userPrompt }
				]
			}
		];

		const request: GenerateContentParameters = {
			model: modelName,
			contents
		};

		if (systemInstruction) {
			request.config = {
				systemInstruction: systemInstruction
			};
		}

		// A long transcript is a LOT of output tokens. Without an explicit ceiling
		// the model stops at its default and returns a transcript that looks
		// well-formed but covers only the first few minutes of the audio.
		if (options?.maxOutputTokens != null || options?.temperature != null) {
			const config = (request.config || {}) as any;
			if (options.maxOutputTokens != null) config.maxOutputTokens = options.maxOutputTokens;
			if (options.temperature != null) config.temperature = options.temperature;
			request.config = config;
		}

		try {
			const response = await this.withRetry(
				() => (this.client.models as any).generateContent(request, { signal }) as Promise<any>,
				signal
			);
			const usage = this.extractUsage(response);
			const cost = GeminiAdapter.calculateCost(modelName, usage, audioDuration);
			const finishReason = response?.candidates?.[0]?.finishReason;
			if (finishReason && finishReason !== 'STOP') {
				console.warn(`[GEMINI ADAPTER] generateTextFromFiles finished with ${finishReason} — output may be incomplete`);
			}

			return {
				text: this.extractResultText(response),
				record: { usage, cost },
				// Callers need this: MAX_TOKENS means the text is a PREFIX of the
				// real answer, which for a transcript looks perfectly well-formed.
				finishReason
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			console.error(`[GEMINI ADAPTER] generateTextFromFiles failed:`, error);
			throw error;
		}
	}

	/**
	 * Rate limits that name their own wait ("Please retry in 20s" — the free
	 * tier allows gemini-3.5-transcribe 3 calls a minute) outlast withRetry's
	 * short backoff. Wait as long as the server asks, a few times, up to a minute each.
	 */
	private async withServerDelay<T>(operation: () => Promise<T>, signal?: AbortSignal, attempts = 4): Promise<T> {
		for (let attempt = 1; ; attempt++) {
			try {
				return await operation();
			} catch (error: any) {
				const wait = String(error?.message || '').match(/retry in ([\d.]+)\s*s/i);
				if (signal?.aborted || !wait || attempt >= attempts) throw error;
				const ms = Math.min(65_000, Math.ceil(parseFloat(wait[1]) * 1000) + 1000);
				console.warn(`[GEMINI ADAPTER] rate limited — waiting ${Math.round(ms / 1000)}s as the server asks`);
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, ms);
					signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
				});
				if (signal?.aborted) throw error;
			}
		}
	}

	/**
	 * Speech-to-text with word timestamps, through a dedicated transcribe model
	 * (gemini-3.5-transcribe). These models are served by the Interactions API,
	 * not generateContent, and return each word with measured start/end offsets
	 * — the times come from the audio, not from text the model writes.
	 * Limit: 30 minutes of audio per call with word timestamps on.
	 */
	async transcribeWords(
		modelName: string,
		fileUri: string,
		audioDuration: number,
		signal?: AbortSignal,
		options?: { languageCodes?: string[] }
	): Promise<{ words: { start: number; end: number; text: string }[]; text: string; record: UsageRecord }> {
		const transcriptionConfig: Record<string, unknown> = {
			mode: { type: 'verbatim', timestamp_granularities: ['word'] }
		};
		if (options?.languageCodes?.length) transcriptionConfig.language_codes = options.languageCodes;

		const body = {
			model: modelName,
			input: [{ type: 'audio', uri: fileUri, mime_type: 'audio/mp3' }],
			generation_config: { transcription_config: transcriptionConfig }
		};

		const response: any = await this.withServerDelay(() => this.withRetry(async () => {
			const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
				method: 'POST',
				headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal
			});
			const json: any = await res.json().catch(() => ({}));
			if (!res.ok) {
				const error: any = new Error(json?.error?.message || `Transcription failed (HTTP ${res.status})`);
				error.status = res.status;
				throw error;
			}
			return json;
		}, signal), signal);

		if (response?.status && response.status !== 'completed') {
			throw new Error(`Transcription did not complete (status: ${response.status}).`);
		}

		const words: { start: number; end: number; text: string }[] = [];
		const texts: string[] = [];
		for (const step of response?.steps || []) {
			for (const part of step?.content || []) {
				if (typeof part?.text === 'string') texts.push(part.text);
				for (const a of part?.annotations || []) {
					if (a?.type !== 'word_info' || !a.text) continue;
					const start = parseOffset(a.start_offset);
					const end = parseOffset(a.end_offset);
					if (Number.isFinite(start) && Number.isFinite(end)) words.push({ start, end: Math.max(start, end), text: a.text });
				}
			}
		}

		const u = response?.usage || {};
		const usage: Usage = {
			promptTokens: u.total_input_tokens || 0,
			candidatesTokens: u.total_output_tokens || 0,
			thinkingTokens: u.total_thought_tokens || 0,
			totalTokens: u.total_tokens || 0
		};
		const cost = GeminiAdapter.calculateCost(modelName, usage, audioDuration);
		return { words, text: texts.join('\n'), record: { usage, cost } };
	}

	/**
	 * Generates a structured result (JSON) from Gemini based on files and a prompt.
	 */
	async generateStructuredFromFiles<T>(
		modelName: string,
		userPrompt: string,
		fileUris: string[],
		schema: any,
		systemInstruction?: string,
		audioDuration: number = 0,
		signal?: AbortSignal
	): Promise<{ data: T, record: UsageRecord }> {
		const contents = [
			{
				role: 'user',
				parts: [
					...fileUris.map(uri => ({ fileData: { fileUri: uri, mimeType: 'audio/mpeg' } })),
					{ text: userPrompt }
				]
			}
		];

		const request: GenerateContentParameters = {
			model: modelName,
			contents,
			config: {
				responseMimeType: 'application/json',
				responseSchema: schema
			}
		};

		if (systemInstruction) {
			request.config!.systemInstruction = systemInstruction;
		}

		const response = await this.withRetry(
			() => (this.client.models as any).generateContent(request, { signal }) as Promise<any>,
			signal
		);

		const usage = this.extractUsage(response);
		const cost = GeminiAdapter.calculateCost(modelName, usage, audioDuration);
		const text = this.extractResultText(response);

		try {
			return {
				data: JSON.parse(text) as T,
				record: { usage, cost }
			};
		} catch (parseError) {
			console.error(`[GEMINI ADAPTER] Failed to parse structured response:`, text);
			throw parseError;
		}

		throw new Error('Unexpected fallthrough in generateStructuredFromFiles');
	}

	/**
	 * Generates a text description from an image file.
	 */
	async generateDescriptionFromImage(
		modelName: string,
		prompt: string,
		imageUri: string,
		signal?: AbortSignal
	): Promise<{ text: string, record: UsageRecord }> {
		const contents = [
			{
				role: 'user',
				parts: [
					{ fileData: { fileUri: imageUri, mimeType: 'image/jpeg' } },
					{ text: prompt }
				]
			}
		];

		const request: GenerateContentParameters = {
			model: modelName,
			contents
		};

		try {
			const response = await this.withRetry(
				() => (this.client.models as any).generateContent(request, { signal }) as Promise<any>,
				signal
			);
			const usage = this.extractUsage(response);
			const cost = GeminiAdapter.calculateCost(modelName, usage, 0, 1);

			return {
				text: this.extractResultText(response),
				record: { usage, cost }
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			console.error(`[GEMINI ADAPTER] generateDescriptionFromImage failed:`, error);
			throw error;
		}
	}

	/**
	 * Generates a structured result (JSON) from Gemini based on multiple images and a prompt.
	 */
	async generateStructuredFromImages<T>(
		modelName: string,
		userPrompt: string,
		imageUris: string[],
		schema: any,
		signal?: AbortSignal,
		options?: {
			includeThinking?: boolean
			/**
			 * One label per image, emitted as a text part immediately BEFORE it, so
			 * the model can COPY an identifier back rather than counting positions.
			 */
			labels?: string[]
			maxOutputTokens?: number
			/**
			 * Called with the usage record BEFORE the body is parsed — a response
			 * that comes back malformed still billed for the tokens it burned.
			 */
			onUsage?: (record: UsageRecord) => void
		}
	): Promise<{ data: T, record: UsageRecord, finishReason?: string }> {
		const parts: any[] = [];
		imageUris.forEach((uri, i) => {
			const label = options?.labels?.[i];
			if (label) parts.push({ text: label });
			parts.push({ fileData: { fileUri: uri, mimeType: 'image/jpeg' } });
		});
		parts.push({ text: userPrompt });

		const contents = [{ role: 'user', parts }];

		const request: GenerateContentParameters = {
			model: modelName,
			contents,
			config: {
				responseMimeType: 'application/json',
				responseSchema: schema
			}
		};

		// Thinking draws from the SAME output budget on Gemini 3, so an unbounded
		// thinking pass can starve the JSON body — which then fails to parse below
		// with no hint of the cause. finishReason (returned) is the other tell.
		if (options?.maxOutputTokens != null) {
			(request.config as any).maxOutputTokens = options.maxOutputTokens;
		}

		const response = await this.withRetry(
			() => (this.client.models as any).generateContent(request, { signal }) as Promise<any>,
			signal
		);

		const usage = this.extractUsage(response);
		const cost = GeminiAdapter.calculateCost(modelName, usage, 0, imageUris.length);
		const text = this.extractResultText(response);
		const finishReason = response?.candidates?.[0]?.finishReason;

		// Bank the usage BEFORE parsing: the call is paid for either way.
		options?.onUsage?.({ usage, cost });

		try {
			return {
				data: JSON.parse(text) as T,
				record: { usage, cost },
				finishReason
			};
		} catch (parseError: any) {
			console.error(`[GEMINI ADAPTER] Failed to parse structured response (finishReason: ${finishReason}):`, text);
			throw new Error(
				`Model response was not valid JSON${finishReason ? ` (finishReason: ${finishReason})` : ''}: ` +
				`${parseError?.message || parseError}`
			);
		}
	}

	/**
	 * MOCK: Generates an image based on a prompt.
	 * In a real scenario, this would call the Imagen/Gemini V6 API.
	 */
	async generateImage(
		modelName: string,
		prompt: string,
		outputPath: string,
		imagePaths: string[] = [],
		systemInstruction?: string,
		signal?: AbortSignal,
		options?: { includeThinking?: boolean }
	): Promise<{ path: string, text?: string, record: UsageRecord }> {
		try {
			// Prepare parts: Image parts FIRST, then text prompt
			const parts: any[] = []

			for (const imgPath of imagePaths) {
				if (fs.existsSync(imgPath)) {
					const data = fs.readFileSync(imgPath).toString('base64')
					parts.push({
						inlineData: {
							data,
							mimeType: 'image/jpeg'
						}
					})
				}
			}

			parts.push({ text: prompt })

			// For gemini-3.1-flash-image-preview, we use generateContent
			const requestConfig: any = systemInstruction ? { systemInstruction: systemInstruction } : {};
			
			if (options?.includeThinking) {
				requestConfig.thinkingConfig = {
					includeThoughts: true,
					thinkingBudget: 8000
				};
			}

			const response = await this.withRetry(
				() => (this.client.models as any).generateContent({
					model: modelName,
					contents: [{ role: 'user', parts }],
					config: requestConfig
				}, { signal }) as Promise<any>,
				signal
			);

			if (!response.candidates || response.candidates.length === 0) {
				throw new Error('No candidates returned from the model.');
			}

			// Extract the image from candidates (inlineData part) and text part
			let base64Data: string | undefined;
			let modelText: string | undefined;
			
			for (const part of response.candidates[0].content?.parts || []) {
				if (part.inlineData) {
					base64Data = part.inlineData.data;
				} else if (part.text && !part.thought) {
					modelText = part.text;
				}
			}

			if (!base64Data) {
				const candidate = response.candidates[0];
				const finishReason = candidate.finishReason || 'UNKNOWN';
				const text = this.extractResultText(response);

				if (text) {
					throw new Error(text);
				}

				throw new Error(`Image Model did not generate image. Reason: ${finishReason}, Prompt: ${prompt}`);
			}

			const buffer = Buffer.from(base64Data, 'base64');

			// Ensure directory exists
			const dir = path.dirname(outputPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

			// Save to specified path
			fs.writeFileSync(outputPath, buffer);

			// Calculate cost
			const usage = this.extractUsage(response);
			const cost = GeminiAdapter.calculateCost(modelName, usage);

			return {
				path: outputPath,
				text: modelText,
				record: { usage, cost }
			};
		} catch (error: any) {
			if (signal?.aborted) throw error;
			console.error('Gemini image generation failed:', error);
			// ... existing error parsing logic ...
			let message = 'Image generation failed.';

			// Try to extract a clean message from common error formats
			let rawError = error.message;
			if (typeof rawError === 'string' && rawError.startsWith('{')) {
				try {
					const parsed = JSON.parse(rawError);
					if (parsed.error && parsed.error.message) {
						rawError = parsed.error.message;
					} else if (parsed.message) {
						rawError = parsed.message;
					}
				} catch (e) { /* ignore parse error */ }
			}

			if (error.status === 'NOT_FOUND' || (rawError && rawError.toLowerCase().includes('not found'))) {
				message = `Model '${modelName}' not found. Please verify your Imagen model settings. Note: 'gemini-3.1-flash-image-preview' is recommended for Gemini 3.`;
			} else if (rawError) {
				message = `Gemini Error: ${rawError}`;
			}

			throw new Error(message);
		}
	}

	/**
	 * Upscales an image using the Imagen Upscale API.
	 */
	async upscaleImage(
		modelName: string,
		inputPath: string,
		upscaleFactor: UpscaleFactor,
		outputPath: string,
		signal?: AbortSignal
	): Promise<{ path: string, record: UsageRecord }> {
		try {
			if (!fs.existsSync(inputPath)) {
				throw new Error(`Input image file not found: ${inputPath}`);
			}

			const data = fs.readFileSync(inputPath).toString('base64');
			const mimeType = 'image/jpeg'; // Default for our snapshots

			// Creative Upscaling using generateContent (AI Studio compatible)
			// This uses the existing image as a reference and reconstructs it at higher resolution.
			const response = await this.withRetry(
				() => (this.client.models as any).generateContent({
					model: modelName,
					contents: [
						{
							role: 'user',
							parts: [
								{ text: "Regenerate this image at high resolution, preserving all details, textures, and composition exactly as shown. Output the result as an image." },
								{ inlineData: { data, mimeType } }
							]
						}
					],
					config: {
						responseModalities: ['IMAGE'],
						imageConfig: {
							imageSize: upscaleFactor === 'x2' ? '2K' : '4K'
						}
					}
				}, { signal }) as Promise<any>,
				signal
			);

			if (!response.candidates || response.candidates.length === 0) {
				throw new Error('No candidates returned from the model.');
			}

			// Extract the image from candidates (inlineData part)
			let base64Data: string | undefined;
			for (const part of response.candidates[0].content?.parts || []) {
				if (part.inlineData) {
					base64Data = part.inlineData.data;
					break;
				}
			}

			if (!base64Data) {
				const candidate = response.candidates[0];
				const finishReason = candidate.finishReason || 'UNKNOWN';
				throw new Error(`Image Model did not generate high-res image. Reason: ${finishReason}`);
			}

			const buffer = Buffer.from(base64Data, 'base64');

			// Ensure directory exists
			const dir = path.dirname(outputPath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

			// Save to specified path
			fs.writeFileSync(outputPath, buffer);

			// Calculate cost - using 1 image count since it's an image generation task
			const usage = this.extractUsage(response);
			const cost = GeminiAdapter.calculateCost(modelName, usage, 0, 1);

			return {
				path: outputPath,
				record: { usage, cost }
			};
		} catch (error: any) {
			if (signal?.aborted) throw error;
			console.error('Gemini creative upscaling failed:', error);
			// Wrap and re-throw with clearer message
			let message = error.message || 'Creative upscaling failed.';
			if (message.includes('supported by the Vertex AI')) {
				message = 'The native upscaling method is Vertex-only. Retrying with Creative Re-rendering... (Something went wrong with the fallback)';
			}
			throw new Error(message);
		}
	}

	/**
	 * Calculates the cost of a request based on usage and model.
	 * @param audioDuration Duration of audio in seconds if multimodal call.
	 * @param imageCount Number of images if multimodal call.
	 */
	static calculateCost(model: string, usage: Usage, audioDuration: number = 0, imageCount: number = 0): number {
		const modelSettings = settingsManager.getModelSettings();
		const pricing = modelSettings.pricing[model];
		if (!pricing) return 0;

		let inputCost = 0;
		let outputCost = 0;

		if (pricing.input.threshold !== undefined) {
			// Pro pricing (threshold based)
			const inputPro = pricing.input;
			const outputPro = pricing.output;
			const isLongContext = usage.promptTokens > (inputPro.threshold || 200000);

			const inputRate = isLongContext ? (inputPro.longContext || inputPro.standard) : inputPro.standard;
			const outputRate = isLongContext ? (outputPro.longContext || outputPro.standard) : outputPro.standard;

			inputCost = (usage.promptTokens / 1000000) * inputRate;
			// Output price applies to both candidates and thinking tokens
			const totalOutputTokens = usage.candidatesTokens + (usage.thinkingTokens || 0);
			outputCost = (totalOutputTokens / 1000000) * outputRate;
		} else {
			// Flash pricing (type based breakdown)
			const flashInput = pricing.input;

			// According to official docs: 1 second of audio = 33 tokens
			const audioTokens = audioDuration > 0 ? Math.min(usage.promptTokens, Math.round(audioDuration * 33)) : 0;
			const textTokens = usage.promptTokens - audioTokens;

			const audioRate = flashInput.audio ?? flashInput.standard;
			const textRate = flashInput.text ?? flashInput.standard;

			inputCost = (audioTokens / 1000000 * audioRate) + (textTokens / 1000000 * textRate);

			// Output price applies to both candidates and thinking tokens
			const totalOutputTokens = usage.candidatesTokens + (usage.thinkingTokens || 0);
			outputCost = (totalOutputTokens / 1000000) * pricing.output.standard;

			// Handle per-image cost if applicable
			if (pricing.output.image) {
				outputCost += pricing.output.image * Math.max(1, imageCount);
			}
		}

		return inputCost + outputCost;
	}
}
