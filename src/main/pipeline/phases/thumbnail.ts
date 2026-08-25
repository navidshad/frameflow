import { PipelineFunction } from '../index'
import { GeminiAdapter } from '../../gemini/adapter'
import { threadManager } from '../../threads'
import * as ffmpegAdapter from '../../ffmpeg'
import fs from 'fs'
import path from 'path'
import { FileType, MessageRole, EnrichedTimelineSegment } from '../../../shared/types'
import { THREAD_DIRS } from '../../constants/paths'


export const generateThumbnail: PipelineFunction = async (data, context) => {
	context.updateStatus('Preparing to generate thumbnail...')

	const intent = context.intentResult
	if (!intent || intent.type !== 'generate-thumbnail') {
		return context.next(data)
	}

	const adapter = GeminiAdapter.create()

	const allReferenceImages = data.selectedReferenceImages || []
	context.updateStatus(`Preparing reference material: ${allReferenceImages.length} images...`)

	// 2. Generate the Thumbnail Asset
	context.updateStatus('Generating thumbnail image with Gemini...')
	const currentModelSettings = (await import('../../settings')).settingsManager.getModelSettings()
	const modelName = currentModelSettings.selection['thumbnail']

	const resultPath = path.join(context.tempDir, THREAD_DIRS.GENERATED_IMAGES, `thumbnail_${context.messageId}.png`)

	const systemInstruction = `You are a professional video thumbnail designer.
Your goal is to create a high-impact, cinematic thumbnail for a video based on a user's request and provided reference frames.

CRITICAL RULES:
1. VISUAL CONSISTENCY: Maintain a consistent appearance for the subjects, objects, and locations shown in the reference frames. Avoid generating generic characters if the source images show clear subjects.
2. SOURCE MATERIAL: The provided reference frames are your primary baseline. Your output should look like it was professionally edited from these actual video frames.
3. COMPOSITION: Use principles of good graphic design (Rule of Thirds, leading lines, high contrast) to make the thumbnail "pop".
4. USER CONTEXT: You are editing material provided by the personal user. Focus on creative enhancement rather than autonomous generation.
5. OUTPUT: DO NOT output ANY text or explanation—ONLY raw image data.`

	const multimodalPrompt = `User Request: "${intent.content}"\n\nPlease generate a thumbnail that fulfills this request using the provided reference frames.`
	const { record, text } = await adapter.generateImage(modelName, multimodalPrompt, resultPath, allReferenceImages, systemInstruction, context.signal, { includeThinking: !!context.isThinkingMode })

	// Record usage immediately
	await context.recordUsage(record)

	if (context.signal.aborted) return;

	// Determine title/content for the final message
	const messageContent = text || intent.content

	// Finish pipeline
	// Pass the thumbnail as the main file, and ALL reference images (old and new) in the carousel
	const finalPreviews = Array.from(new Set(allReferenceImages))
		.filter(f => f !== resultPath)
		.map(f => ({ url: f.startsWith('media://') ? f : `media://${f}`, type: FileType.Preview }))

	console.log(`[THUMBNAIL] Finishing stage. Main result: ${resultPath}. Previews: ${finalPreviews.length}`)

	await context.finish(
		messageContent,
		undefined, // Not used when files is provided in options
		undefined, // timeline
		{
			resultType: 'thumbnail',
			files: [
				{ url: resultPath, type: FileType.Actual },
				...finalPreviews
			]
		}
	)
}

/**
 * Deliberately NOT shared/timeline's srtToSeconds: this one validates MODEL
 * OUTPUT, so it strips `[HH:MM:SS]` brackets and returns NaN on anything
 * malformed rather than coercing to 0. Callers below rely on the NaN.
 */
function timeToSeconds(t: string | any): number {
	if (typeof t !== 'string') return NaN

	// Remove brackets if any [HH:MM:SS]
	const clean = t.replace(/[\[\]]/g, '').trim()
	const parts = clean.split(':').map(val => parseFloat(val))

	if (parts.some(p => isNaN(p))) return NaN

	if (parts.length === 3) {
		return parts[0] * 3600 + parts[1] * 60 + parts[2]
	} else if (parts.length === 2) {
		return parts[0] * 60 + parts[1]
	} else if (parts.length === 1) {
		return parts[0]
	}
	return NaN
}
