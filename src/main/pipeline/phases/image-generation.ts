import { PipelineFunction } from '../index'
import { GeminiAdapter } from '../../gemini/adapter'
import { settingsManager } from '../../settings'
import path from 'path'
import fs from 'fs'
import { FileType, PipelineResultType } from '../../../shared/types'
import { THREAD_DIRS } from '../../constants/paths'

/**
 * Image output for the AI graph, in two flavours.
 *
 * These were two phases — generateOutputImage and generateThumbnail — that
 * differed in exactly five constants and duplicated everything else. The
 * duplication was already costing something: only one of them stripped
 * `media://` prefixes, and adapter.generateImage silently SKIPS reference paths
 * that fail existsSync, so thumbnails generated with fewer references than the
 * user had selected. Merging fixes that.
 *
 * Both keep their own model slot, so they stay independently configurable in
 * Settings.
 */

const IMAGE_SYSTEM_INSTRUCTION = `You are an expert AI image generator and editor.
Your ONLY goal is to output a single image that fulfills the user prompt based on the visual context of the provided images.

CRITICAL RULES:
1. VISUAL CONSISTENCY: Maintain consistent appearance for subjects and styles seen in the reference images.
2. OUTPUT: DO NOT output ANY text or explanation—ONLY raw image data.`

const THUMBNAIL_SYSTEM_INSTRUCTION = `You are a professional video thumbnail designer.
Your goal is to create a high-impact, cinematic thumbnail for a video based on a user's request and provided reference frames.

CRITICAL RULES:
1. VISUAL CONSISTENCY: Maintain a consistent appearance for the subjects, objects, and locations shown in the reference frames. Avoid generating generic characters if the source images show clear subjects.
2. SOURCE MATERIAL: The provided reference frames are your primary baseline. Your output should look like it was professionally edited from these actual video frames.
3. COMPOSITION: Use principles of good graphic design (Rule of Thirds, leading lines, high contrast) to make the thumbnail "pop".
4. USER CONTEXT: You are editing material provided by the personal user. Focus on creative enhancement rather than autonomous generation.
5. OUTPUT: DO NOT output ANY text or explanation—ONLY raw image data.`

interface GenerationMode {
	/** Settings key — the two flavours stay separately configurable. */
	modelKey: 'image-generation' | 'thumbnail'
	systemInstruction: string
	resultType: PipelineResultType
	status: string
	fileName: (messageId: string) => string
	/** How the intent's `content` is wrapped before it reaches the model. */
	prompt: (intentContent: string) => string
	/** Fallback message body when the model returns no text. */
	message: (intentContent: string, modelText?: string) => string
}

const MODES: Record<'generate-image' | 'generate-thumbnail', GenerationMode> = {
	'generate-image': {
		modelKey: 'image-generation',
		systemInstruction: IMAGE_SYSTEM_INSTRUCTION,
		resultType: 'image',
		status: 'Generating final image...',
		fileName: () => `generated_image_${Date.now()}.png`,
		prompt: (content) => content,
		message: (content) =>
			`I have generated a new image based on your request: ${content.substring(0, 50)}...`
	},
	'generate-thumbnail': {
		modelKey: 'thumbnail',
		systemInstruction: THUMBNAIL_SYSTEM_INSTRUCTION,
		resultType: 'thumbnail',
		status: 'Generating thumbnail image...',
		fileName: (messageId) => `thumbnail_${messageId}.png`,
		prompt: (content) =>
			`User Request: "${content}"\n\nPlease generate a thumbnail that fulfills this request using the provided reference frames.`,
		message: (content, modelText) => modelText || content
	}
}

const DEFAULT_PROMPT = 'Generate a creative image based on the provided ones.'

export const generateOutputImage: PipelineFunction = async (data, context) => {
	const intentType = context.intentResult?.type
	const mode = intentType === 'generate-thumbnail'
		? MODES['generate-thumbnail']
		: MODES['generate-image']

	context.updateStatus(mode.status)

	const gemini = GeminiAdapter.create()
	const modelName = settingsManager.getModelSettings().selection[mode.modelKey]
	const intentPrompt = context.intentResult?.content || DEFAULT_PROMPT

	// Normalize (drop media://) and dedupe. generateImage skips paths failing
	// existsSync, so a stray prefix silently costs a reference image.
	const rawPaths = data.selectedReferenceImages || data.selectedImagePaths || []
	const allReferenceImages: string[] = Array.from(new Set(
		rawPaths.map((p: string) => p.replace(/^media:\/+/i, '/').replace(/\//g, path.sep))
	))

	if (allReferenceImages.length === 0) {
		throw new Error('No images selected for generation. Please check the intent analysis.')
	}

	try {
		const resultsDir = path.join(context.tempDir, THREAD_DIRS.GENERATED_IMAGES)
		if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true })
		const destPath = path.join(resultsDir, mode.fileName(context.messageId))

		const { path: savedPath, record, text } = await gemini.generateImage(
			modelName,
			mode.prompt(intentPrompt),
			destPath,
			allReferenceImages,
			mode.systemInstruction,
			context.signal,
			{ includeThinking: !!context.isThinkingMode }
		)

		await context.recordUsage(record)
		if (context.signal.aborted) return

		context.updateStatus('Generation complete.')
		context.finish(
			mode.message(intentPrompt, text),
			undefined,
			undefined,
			{
				resultType: mode.resultType,
				files: [
					{ url: savedPath, type: FileType.Actual },
					// Every reference rides along in the carousel.
					...allReferenceImages
						.filter((p) => p !== savedPath)
						.map((p) => ({
							url: p.startsWith('media://') ? p : `media://${p}`,
							type: FileType.Preview
						}))
				]
			}
		)
	} catch (error) {
		if (!context.signal.aborted) {
			console.error(`Failed to generate ${mode.resultType}:`, error)
		}
		throw error
	}
}
