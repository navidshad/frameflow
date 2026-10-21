import type { GenerateRequest } from '../../shared/audioProviders'
import { ProviderError, type AudioProviderImpl, type ProviderContext, type ProviderOutput, type Voice } from './provider'

/**
 * Gemini voices, over the Gemini API's `generateContent` REST endpoint, using the
 * API key the app already has.
 *
 * From the official speech-generation docs (ai.google.dev), read on 2026-10-21:
 * ask for `responseModalities: ['AUDIO']` with a `speechConfig` naming a
 * prebuilt voice; the audio comes back base64 in
 * `candidates[0].content.parts[0].inlineData.data`. A unary reply is now a
 * COMPLETE WAV (24 kHz, mono, 16-bit); older replies were headerless PCM, so
 * this sniffs for `RIFF` and wraps only when it is missing — never both.
 *
 * Models are tried in order: the docs have renamed these more than once, and a
 * 404 for a model id is a reason to try the next, not to fail.
 */

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'
export const TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'] as const
export const DEFAULT_VOICE = 'Kore'

/** The prebuilt voices the docs list. */
export const GEMINI_VOICES = [
	'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus',
	'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar',
	'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
]

/** USD per 1M tokens, (text in, audio out). The pricing page doubles on 2027-01-01. */
export function ttsPricing(model: string, now = new Date()): { input: number; output: number } {
	const after = now.getTime() >= Date.UTC(2027, 0, 1)
	if (model === 'gemini-3.8-flash-tts') return after ? { input: 1, output: 18 } : { input: 0.5, output: 9 }
	if (model === 'gemini-3.1-flash-tts-preview') return { input: 1, output: 20 }
	return { input: 0.5, output: 10 }
}

/** Audio is billed by the second at 25 tokens a second, the pricing page says. */
const AUDIO_TOKENS_PER_SEC = 25
/** About how fast a voice reads: characters per second. Only for the estimate before the call. */
const CHARS_PER_SEC = 15

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

async function failure(res: Response): Promise<ProviderError> {
	let message = ''
	try {
		const body = await res.json() as { error?: { message?: string } }
		message = body?.error?.message ?? ''
	} catch { /* not JSON */ }
	const said = message ? `: ${message}` : ''
	if (res.status === 401 || res.status === 403) return new ProviderError(`Gemini did not accept the API key${said}. Check it in Settings.`, res.status, 'auth')
	// An invalid key is a 400 here, not a 401.
	if (res.status === 400 && /api key/i.test(message)) return new ProviderError(`Gemini did not accept the API key${said}. Check it in Settings.`, 400, 'auth')
	if (res.status === 429) return new ProviderError(`Gemini is rate limiting this key, or its quota is used up${said}.`, 429, 'quota')
	if (res.status === 400) return new ProviderError(`Gemini could not use that request${said}.`, 400, 'input')
	return new ProviderError(`Gemini had a problem (${res.status})${said}. Try again.`, res.status)
}

/** `audio/L16;codec=pcm;rate=24000` → 24000. */
const rateFrom = (mime: string | undefined): number => {
	const m = /rate=(\d+)/i.exec(mime ?? '')
	return m ? parseInt(m[1], 10) : 24000
}

export const gemini: AudioProviderImpl = {
	id: 'gemini',
	capabilities: ['speech'],

	estimateUsd(req: GenerateRequest) {
		const { input, output } = ttsPricing(TTS_MODELS[0])
		const text = req.prompt.trim().length
		const seconds = Math.max(1, text / CHARS_PER_SEC)
		return round6((Math.ceil(text / 4) * input + seconds * AUDIO_TOKENS_PER_SEC * output) / 1e6)
	},

	async voices(): Promise<Voice[]> {
		return GEMINI_VOICES.map((name) => ({ id: name, name }))
	},

	async generate(req, ctx: ProviderContext): Promise<ProviderOutput> {
		const voice = req.voice && GEMINI_VOICES.includes(req.voice) ? req.voice : DEFAULT_VOICE
		const body = JSON.stringify({
			contents: [{ parts: [{ text: req.prompt.trim() }] }],
			generationConfig: {
				responseModalities: ['AUDIO'],
				speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
			}
		})

		let last: ProviderError | null = null
		for (const model of TTS_MODELS) {
			const res = await ctx.fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
				method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': ctx.key }, body, signal: ctx.signal
			})
			if (res.status === 404) { last = new ProviderError(`Gemini has no model ${model}.`, 404, 'input'); continue }
			if (!res.ok) throw await failure(res)

			const json = await res.json() as {
				candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[]
				usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
			}
			const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData
			if (!inline?.data) throw new ProviderError('Gemini returned no audio. Try shorter text.', res.status)
			const bytes = Buffer.from(inline.data, 'base64')
			const isWav = bytes.subarray(0, 4).toString() === 'RIFF'
			const sampleRate = rateFrom(inline.mimeType)
			const seconds = isWav ? Math.max(0, (bytes.length - 44) / (sampleRate * 2)) : bytes.length / (sampleRate * 2)

			const price = ttsPricing(model)
			const inTokens = json.usageMetadata?.promptTokenCount ?? Math.ceil(req.prompt.trim().length / 4)
			const outTokens = json.usageMetadata?.candidatesTokenCount ?? Math.round(seconds * AUDIO_TOKENS_PER_SEC)
			return {
				bytes, model,
				...(isWav ? { format: 'wav' as const } : { format: 'pcm16' as const, sampleRate, channels: 1 }),
				costUsd: round6((inTokens * price.input + outTokens * price.output) / 1e6)
			}
		}
		throw last ?? new ProviderError('Gemini voices are not available.')
	}
}
