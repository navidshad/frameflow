import { PipelineFunction } from '../index'
import * as ffmpegAdapter from '../../ffmpeg'
import fs from 'fs'
import path from 'path'
import { extractTranscript, formatTranscript } from '../../gemini/utils'
import { SceneDetector, checkScenedetectAvailability } from '../../scenedetect'
import { GeminiAdapter } from '../../gemini/adapter'
import { Scene } from '../../scenedetect/types'
import { GEMINI_MODEL_2_5_FLASH_LITE } from '../../constants/gemini'
import { settingsManager } from '../../settings'
import { THREAD_DIRS } from '../../constants/paths'
import type { UsageRecord } from '@shared/types'
import {
	MIN_BATCH_COVERAGE,
	MIN_DESCRIBABLE_DURATION,
	MIN_RETRY_BATCH,
	batchCoverage,
	halveBatch,
	mapBatchResponse,
	planBatches,
	type DescribedScene,
	type ModelDescription,
	type SceneFrame
} from '../../gemini/scene-descriptions'

export const convertToAudio: PipelineFunction = async (data, context) => {
	const videoPath = context.preprocessing.lowResVideoPath! || context.videoPath;
	context.updateStatus('Converting video to audio...')

	const audioDir = path.join(context.tempDir, THREAD_DIRS.AUDIO)
	if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true })

	const audioPath = await ffmpegAdapter.toAudio(videoPath, audioDir, (percent) => {
		context.updateStatus(`Converting to audio... ${percent}%`)
	}, context.signal)

	context.savePreprocessing({ audioPath })
	context.updateStatus('Audio extracted successfully.')
	context.next({ ...data, audioPath })
}

export const extractRawTranscript: PipelineFunction = async (data, context) => {
	const audioPath = data.audioPath || context.preprocessing.audioPath
	if (!audioPath) {
		throw new Error('Audio path not found for transcript extraction')
	}

	context.updateStatus('Extracting raw transcript...')
	const duration = await ffmpegAdapter.getVideoDuration(audioPath)

	const { items: transcript, rawResponseText, record } = await extractTranscript(
		audioPath, duration, undefined, context.signal,
		(done, total) => {
			if (total > 1) context.updateStatus(`Transcribing part ${Math.min(done + 1, total)} of ${total}…`)
		}
	)

	// Record usage immediately
	await context.recordUsage(record)

	if (context.signal.aborted) return;

	const transcriptsDir = path.join(context.tempDir, THREAD_DIRS.TRANSCRIPTS)
	if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir, { recursive: true })

	const rawResponsePath = path.join(transcriptsDir, `raw_transcript_response.txt`)
	fs.writeFileSync(rawResponsePath, rawResponseText)

	const rawTranscriptPath = path.join(transcriptsDir, `raw_transcript.json`)
	fs.writeFileSync(rawTranscriptPath, JSON.stringify(transcript, null, 2))

	context.savePreprocessing({ rawTranscriptPath, transcriptPath: rawTranscriptPath })
	context.updateStatus('Raw transcript extracted.')
	context.next({ ...data, transcript })
}

export const extractCorrectedTranscript: PipelineFunction = async (data, context) => {
	const audioPath = context.preprocessing.audioPath
	const rawTranscriptPath = context.preprocessing.rawTranscriptPath

	if (!audioPath || !rawTranscriptPath) {
		context.next(data)
		return
	}

	context.updateStatus('Correcting transcript for better accuracy...')
	const duration = await ffmpegAdapter.getVideoDuration(audioPath)

	const transcriptJson = fs.readFileSync(rawTranscriptPath, 'utf-8')
	const rawTranscript = JSON.parse(transcriptJson)
	const rawTranscriptText = formatTranscript(rawTranscript)

	const { items: transcript, rawResponseText, record } = await extractTranscript(
		audioPath, duration, rawTranscriptText, context.signal,
		(done, total) => {
			if (total > 1) context.updateStatus(`Re-checking part ${Math.min(done + 1, total)} of ${total}…`)
		}
	)

	// Record usage immediately
	await context.recordUsage(record)

	if (context.signal.aborted) return;

	const transcriptsDir = path.join(context.tempDir, THREAD_DIRS.TRANSCRIPTS)
	if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir, { recursive: true })

	const rawResponsePath = path.join(transcriptsDir, `corrected_transcript_response.txt`)
	fs.writeFileSync(rawResponsePath, rawResponseText)

	const correctedTranscriptPath = path.join(transcriptsDir, `corrected_transcript.json`)
	fs.writeFileSync(correctedTranscriptPath, JSON.stringify(transcript, null, 2))

	context.savePreprocessing({ correctedTranscriptPath, transcriptPath: correctedTranscriptPath })
	context.updateStatus('Transcript refined.')
	context.next({ ...data, transcript })
}

/**
 * ~9x headroom for 20 one-sentence descriptions plus a modest thinking pass.
 * The model for this step is user-configurable, and on Gemini 3 thinking eats
 * the same budget as the body — an unbounded pass truncates the JSON.
 */
const SCENE_DESC_MAX_OUTPUT_TOKENS = 8_192

const SCENE_DESCRIPTION_SCHEMA = {
	type: 'object',
	properties: {
		descriptions: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					index: { type: 'integer', description: 'The id printed in the label directly above that frame' },
					description: { type: 'string', description: 'One sentence describing that frame' }
				},
				required: ['index', 'description']
			}
		}
	},
	required: ['descriptions']
}

/**
 * Describes one frame per detected scene.
 *
 * Frames are LABELLED with their scene index and the model echoes that id back,
 * so a sentence can only ever be stored against the frame it was written for.
 * See gemini/scene-descriptions.ts for why position cannot be trusted here.
 */
export const generateSceneDescription: PipelineFunction = async (data, context) => {
	const sceneTimesPath = context.preprocessing.sceneTimesPath
	if (!sceneTimesPath) {
		context.next(data)
		return
	}

	const scenes: Scene[] = JSON.parse(fs.readFileSync(sceneTimesPath, 'utf-8'))
	const videoPath = context.preprocessing.lowResVideoPath || context.videoPath
	const tempDir = context.tempDir

	context.updateStatus(`Generating descriptions for ${scenes.length} scenes...`)

	const gemini = GeminiAdapter.create()
	const modelSettings = settingsManager.getModelSettings()
	const modelName = modelSettings.selection['scene-description'] || GEMINI_MODEL_2_5_FLASH_LITE

	const analysisDir = path.join(tempDir, THREAD_DIRS.ANALYSIS)
	if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true })
	const sceneDescriptionsPath = path.join(analysisDir, `scene_descriptions.json`)

	const framesDir = path.join(tempDir, THREAD_DIRS.FRAMES)
	if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true })

	// ---- Resume: keep what a previous run already paid for ----
	// Re-running after a partial failure should cost only the gaps.
	const described: DescribedScene[] = []
	if (fs.existsSync(sceneDescriptionsPath)) {
		try {
			const prior: DescribedScene[] = JSON.parse(fs.readFileSync(sceneDescriptionsPath, 'utf-8'))
			for (const d of prior) {
				if (typeof d?.index === 'number' && d.description) described.push(d)
			}
		} catch { /* unreadable sidecar: start over rather than guess */ }
	}
	const alreadyDone = new Set(described.map((d) => d.index))

	// ---- Frame extraction ----
	// A scene with no frame gets no description, and the merge-back covers its
	// time window with no span at all — so the clips inside it end up blank.
	// Only sub-threshold scenedetect artifacts are skipped.
	const describable = scenes.filter((s) => s.duration >= MIN_DESCRIBABLE_DURATION).length
	const frames: SceneFrame[] = []
	for (let i = 0; i < scenes.length; i++) {
		const scene = scenes[i]
		if (scene.duration < MIN_DESCRIBABLE_DURATION) continue
		if (alreadyDone.has(i)) continue
		try {
			const midpoint = scene.startTime + (scene.duration / 2)
			const framePath = await ffmpegAdapter.extractFrame(videoPath, midpoint, framesDir, context.signal)
			frames.push({ index: i, startTime: scene.startTime, framePath })
		} catch (error) {
			if (context.signal.aborted) return
			console.error(`Failed to extract frame for scene ${i}:`, error)
		}
	}

	// Uploads are cached by path so a retry never re-uploads the same frame.
	const uploaded = new Map<string, string>()
	const uploadFrame = async (framePath: string): Promise<string> => {
		const cached = uploaded.get(framePath)
		if (cached) return cached
		const uri = await gemini.uploadFile(framePath, 'image/jpeg')
		uploaded.set(framePath, uri)
		return uri
	}

	let failedBatches = 0
	let attemptedBatches = 0
	/** Tail of the previous batch, but ONLY when that batch came back whole. */
	let continuity: string[] = []

	const describeBatch = async (batch: SceneFrame[], canRetry: boolean): Promise<void> => {
		if (!batch.length || context.signal.aborted) return
		attemptedBatches++

		const first = batch[0].index
		const last = batch[batch.length - 1].index
		let prompt = `Each frame below is preceded by a line "Frame <id>:". That id identifies the frame.

For EACH frame return one object: the id copied from its label, and a concise one-sentence
description of the visual action, setting and atmosphere.

Rules:
- Return exactly ${batch.length} objects — one per frame, no more, no fewer.
- COPY the id from the label above each frame. Do NOT renumber them 1, 2, 3…
- If a frame is unreadable (black, blurred, mid-transition), still return its object and say so.
- Name recurring people, objects and settings consistently across frames.`

		if (continuity.length) {
			prompt += `\n\nContext from the immediately preceding scenes (use this to identify recurring people/settings):\n- ${continuity.join('\n- ')}`
		}

		let pendingRecord: UsageRecord | null = null
		let mapping: ReturnType<typeof mapBatchResponse> | null = null
		let cutOff = false

		try {
			const uris = await Promise.all(batch.map((f) => uploadFrame(f.framePath)))

			const { data: result, finishReason } = await gemini.generateStructuredFromImages<{
				descriptions: ModelDescription[]
			}>(
				modelName, prompt, uris, SCENE_DESCRIPTION_SCHEMA, context.signal,
				{
					labels: batch.map((f) => `Frame ${f.index}:`),
					maxOutputTokens: SCENE_DESC_MAX_OUTPUT_TOKENS,
					onUsage: (record) => { pendingRecord = record }
				}
			)
			cutOff = !!finishReason && finishReason !== 'STOP'
			mapping = mapBatchResponse(batch, result?.descriptions)
		} catch (error: any) {
			if (context.signal.aborted) return
			console.warn(`[scene-descriptions] batch ${first}..${last} failed:`, error?.message || error)
		}

		// The call is paid for either way — bank it before deciding what to do.
		if (pendingRecord) await context.recordUsage(pendingRecord)
		if (context.signal.aborted) return

		if (!mapping) {
			// Nothing came back, so there is nothing to re-ask for specifically.
			// Halving shrinks the response, which is the usual cause.
			if (canRetry && batch.length >= MIN_RETRY_BATCH) {
				const [a, b] = halveBatch(batch)
				await describeBatch(a, false)
				await describeBatch(b, false)
			} else {
				failedBatches++
				continuity = []
			}
			return
		}

		described.push(...mapping.described)
		if (mapping.unknown.length) {
			console.warn(
				`[scene-descriptions] batch ${first}..${last}: model returned ${mapping.unknown.length} id(s) ` +
				`it was never given (${mapping.unknown.slice(0, 5).join(', ')}) — it renumbered instead of copying`
			)
		}
		if (mapping.duplicates.length) {
			console.warn(`[scene-descriptions] batch ${first}..${last}: duplicate id(s) ${mapping.duplicates.join(', ')}, first kept`)
		}

		const coverage = batchCoverage(mapping.described.length, batch.length)
		if (coverage < MIN_BATCH_COVERAGE || cutOff) {
			if (canRetry && mapping.missing.length) {
				// An id-join says exactly WHICH frames went unanswered, so re-ask
				// for those rather than blindly halving.
				console.warn(
					`[scene-descriptions] batch ${first}..${last}: ${mapping.missing.length} of ${batch.length} ` +
					`unanswered${cutOff ? ' (response was cut off)' : ''} — re-asking for those frames`
				)
				continuity = []
				await describeBatch(mapping.missing, false)
				// A re-ask covers a scattered subset, not the run of scenes just
				// before the next batch — so it is not usable as continuity.
				continuity = []
				return
			}
			if (!mapping.described.length) failedBatches++
			console.warn(
				`[scene-descriptions] batch ${first}..${last}: ${mapping.missing.length} scene(s) left with no ` +
				`description — clips inside them will have no visual context`
			)
		}

		// Only carry the tail forward when this batch was whole: after a failure
		// the last three descriptions can be a hundred scenes old, and presenting
		// them as "the immediately preceding scenes" is worse than no context.
		continuity = mapping.missing.length === 0
			? mapping.described.slice(-3).map((d) => d.description)
			: []
	}

	const batches = planBatches(frames)
	for (let b = 0; b < batches.length; b++) {
		if (context.signal.aborted) return
		const batch = batches[b]
		// Status wording is parsed for progress by editor/preprocess.ts — keep it.
		context.updateStatus(
			`Analyzing scenes ${batch[0].index + 1} to ${batch[batch.length - 1].index + 1} / ${scenes.length}...`
		)
		await describeBatch(batch, true)

		// Surface frames as they appear so the UI updates in real time.
		await context.savePreprocessing({ 'reference-frames': listFrames(framesDir) })
	}

	if (context.signal.aborted) return

	if (described.length === 0) {
		// Writing an empty artifact would report success AND set
		// sceneDescriptionsPath — which makes intent.ts emit a scene header with
		// no scenes instead of falling back to the transcript, and stops the
		// visual chain ever retrying. Leave the path unset instead.
		if (attemptedBatches > 0) {
			console.error(`[scene-descriptions] every batch failed (${attemptedBatches}) — not writing the artifact`)
			context.updateStatus(`Scene descriptions failed (${attemptedBatches} batches).`)
		} else {
			console.warn('[scene-descriptions] no scene was long enough to describe')
			context.updateStatus('No scenes long enough to describe.')
		}
		context.savePreprocessing({ 'reference-frames': listFrames(framesDir) })
		context.next({ ...data, sceneDescriptions: [] })
		return
	}

	// Retries and resumes append out of order; consumers render in file order.
	described.sort((a, b) => a.index - b.index)
	fs.writeFileSync(sceneDescriptionsPath, JSON.stringify(described, null, 2))

	context.savePreprocessing({
		sceneDescriptionsPath,
		'reference-frames': listFrames(framesDir)
	})
	context.updateStatus(
		described.length >= describable
			? `Scene descriptions generated (${described.length} scenes).`
			: `Described ${described.length} of ${describable} scenes${failedBatches ? ` (${failedBatches} batches failed)` : ''}.`
	)
	context.next({ ...data, sceneDescriptions: described })
}

const listFrames = (framesDir: string): string[] => {
	if (!fs.existsSync(framesDir)) return []
	return fs.readdirSync(framesDir)
		.filter((f) => f.endsWith('.jpg') || f.endsWith('.jpeg'))
		.map((f) => path.join(framesDir, f))
}

// Wait functions for pipeline to use

