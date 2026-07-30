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


export const ensureLowResolution: PipelineFunction = async (_data, context) => {
	const videoPath = context.videoPath
	context.updateStatus('Checking video resolution...')

	const isLowRes = await ffmpegAdapter.isVideoLowResolution(videoPath)
	if (isLowRes) {
		context.updateStatus('Video is already low resolution.')
		context.next({ videoPath })
		return
	}

	context.updateStatus('Downscaling video to 480p for faster processing...')
	const videoDir = path.join(context.tempDir, THREAD_DIRS.VIDEO)
	if (!fs.existsSync(videoDir)) fs.mkdirSync(videoDir, { recursive: true })

	const lowResPath = await ffmpegAdapter.toLowResolution(videoPath, videoDir, (percent) => {
		context.updateStatus(`Downscaling video... ${percent}%`)
	}, context.signal)

	context.savePreprocessing({ lowResVideoPath: lowResPath })
	context.updateStatus('Video downscaled successfully.')
	context.next({ videoPath: lowResPath })
}

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

export const extractSceneTiming: PipelineFunction = async (data, context) => {
	const videoPath = context.preprocessing.lowResVideoPath || context.videoPath

	// Check if scenedetect CLI is available before attempting
	const scenedetectAvailable = await checkScenedetectAvailability()
	if (!scenedetectAvailable) {
		context.updateStatus('scenedetect not found — skipping visual scene analysis. Results will be audio-only.')
		context.next(data)
		return
	}

	context.updateStatus('Detecting scenes in video...')

	const detector = new SceneDetector()
	let scenes: Scene[] = []
	try {
		scenes = await detector.detectScenes(videoPath, context.signal)
	} catch (error) {
		if (!context.signal.aborted) {
			console.error('Scene detection failed:', error)
		}
		context.updateStatus('Scene detection failed, proceeding without scenes.')
		context.next(data)
		return
	}

	const analysisDir = path.join(context.tempDir, THREAD_DIRS.ANALYSIS)
	if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true })

	const sceneTimesPath = path.join(analysisDir, `scenes.json`)
	fs.writeFileSync(sceneTimesPath, JSON.stringify(scenes, null, 2))

	context.savePreprocessing({ sceneTimesPath })
	context.updateStatus(`Detected ${scenes.length} scenes.`)
	context.next({ ...data, scenes })
}

const BATCH_SIZE = 50

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
	// Read model from settings
	const modelSettings = settingsManager.getModelSettings()
	const modelName = modelSettings.selection['scene-description'] || GEMINI_MODEL_2_5_FLASH_LITE

	const descriptions: { index: number, startTime: number, description: string, framePath: string }[] = []
	let framesDir = path.join(tempDir, THREAD_DIRS.FRAMES)
	if (!fs.existsSync(framesDir)) {
		fs.mkdirSync(framesDir)
	}

	// Process in batches to reduce API overhead and improve speed
	for (let i = 0; i < scenes.length; i += BATCH_SIZE) {
		const batchScenes = scenes.slice(i, i + BATCH_SIZE)
		const batchFramePaths: string[] = []
		const validBatchInfo: { scene: Scene, index: number, framePath: string }[] = []

		context.updateStatus(`Analyzing scenes ${i + 1} to ${Math.min(i + BATCH_SIZE, scenes.length)} / ${scenes.length}...`)

		// 1. Extract Frames for the batch (sequential extraction is safer for FFmpeg resources)
		for (let j = 0; j < batchScenes.length; j++) {
			const scene = batchScenes[j]
			const originalIndex = i + j

			// Skip very short scenes?
			if (scene.duration < 1.0) continue;

			try {
				const midpoint = scene.startTime + (scene.duration / 2)
				const framePath = await ffmpegAdapter.extractFrame(videoPath, midpoint, framesDir, context.signal)
				batchFramePaths.push(framePath)
				validBatchInfo.push({ scene, index: originalIndex, framePath })
			} catch (error) {
				if (!context.signal.aborted) {
					console.error(`Failed to extract frame for scene ${originalIndex}:`, error)
				}
			}
		}

		if (validBatchInfo.length === 0) continue;

		try {
			// 2. Upload Frames in parallel
			const uploadPromises = batchFramePaths.map(fpath => gemini.uploadFile(fpath, 'image/jpeg'))
			const frameUris = await Promise.all(uploadPromises)

			// 3. Describe Frames in batch
			// Add context from previous batches to maintain continuity
			let prompt = `I am providing you with ${validBatchInfo.length} chronological frames from a video. 
For EACH frame, provide a concise one-sentence description focusing on visual action, setting, and atmosphere. 
Maintain consistency in identifying people, objects, and settings across the frames.

Return the descriptions as an array of strings in the exact same order as the images provided.`

			if (descriptions.length > 0) {
				const recentContext = descriptions.slice(-3).map(d => d.description).join('\n- ')
				prompt += `\n\nContext from previous scenes (use this to identify recurring people/settings if applicable):\n- ${recentContext}`
			}

			const schema = {
				type: 'object',
				properties: {
					descriptions: {
						type: 'array',
						items: { type: 'string' },
						description: 'One sentence description for each frame, in order.'
					}
				},
				required: ['descriptions']
			}

			const { data: result, record } = await gemini.generateStructuredFromImages<{ descriptions: string[] }>(
				modelName,
				prompt,
				frameUris,
				schema,
				context.signal
			)

			// Record usage immediately
			await context.recordUsage(record)

			if (context.signal.aborted) return;

			// 4. Map results back to scenes
			result.descriptions.forEach((text, index) => {
				const info = validBatchInfo[index]
				if (info) {
					descriptions.push({
						index: info.index,
						startTime: info.scene.startTime,
						description: text.trim(),
						framePath: info.framePath
					})
				}
			})

			// 5. Save frames discovered so far to the thread metadata so the UI updates in real-time
			const currentFrames = fs.readdirSync(framesDir)
				.filter(f => f.endsWith('.jpg') || f.endsWith('.jpeg'))
				.map(f => path.join(framesDir, f))
			
			await context.savePreprocessing({ 
				'reference-frames': currentFrames
			})

			// 6. DO NOT cleanup frames - we want to keep them as reference-frames
			// batchFramePaths.forEach(fpath => {
			// 	try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath) } catch (e) { }
			// })

		} catch (error) {
			if (!context.signal.aborted) {
				console.error(`Failed to describe batch starting at index ${i}:`, error)
			}
		}
	}

	const analysisDir = path.join(tempDir, THREAD_DIRS.ANALYSIS)
	if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true })

	const sceneDescriptionsPath = path.join(analysisDir, `scene_descriptions.json`)
	fs.writeFileSync(sceneDescriptionsPath, JSON.stringify(descriptions, null, 2))

	// Collect all retained frames from the frames directory
	framesDir = path.join(tempDir, THREAD_DIRS.FRAMES)
	let allFrames: string[] = []
	if (fs.existsSync(framesDir)) {
		allFrames = fs.readdirSync(framesDir)
			.filter(f => f.endsWith('.jpg') || f.endsWith('.jpeg'))
			.map(f => path.join(framesDir, f))
	}

	context.savePreprocessing({ 
		sceneDescriptionsPath,
		'reference-frames': allFrames
	})
	context.updateStatus('Scene descriptions generated.')
	context.next({ ...data, sceneDescriptions: descriptions })
}


// Wait functions for pipeline to use
export const waitForEnsureLowResolution: PipelineFunction = async (data, context) => {
	console.log(`[EXTRACTION PHASE] Entering waitForEnsureLowResolution`)
	await context.updateStatus('Ensuring optimal video resolution...')
	await context.waitForTask('downscale')
	console.log(`[EXTRACTION PHASE] Leaving waitForEnsureLowResolution`)
	context.next(data)
}

export const waitForConvertToAudio: PipelineFunction = async (data, context) => {
	console.log(`[EXTRACTION PHASE] Entering waitForConvertToAudio`)
	await context.updateStatus('Waiting for audio extraction...')
	await context.waitForTask('audio')
	console.log(`[EXTRACTION PHASE] Leaving waitForConvertToAudio`)
	context.next(data)
}

export const waitForExtractRawTranscript: PipelineFunction = async (data, context) => {
	console.log(`[EXTRACTION PHASE] Entering waitForExtractRawTranscript`)
	await context.updateStatus('Waiting for raw transcript...')
	await context.waitForTask('rawTranscript')
	console.log(`[EXTRACTION PHASE] Leaving waitForExtractRawTranscript`)
	context.next(data)
}

export const waitForExtractCorrectedTranscript: PipelineFunction = async (data, context) => {
	console.log(`[EXTRACTION PHASE] Entering waitForExtractCorrectedTranscript`)
	await context.updateStatus('Waiting for transcript refinement...')
	await context.waitForTask('correctedTranscript')
	console.log(`[EXTRACTION PHASE] Leaving waitForExtractCorrectedTranscript`)
	context.next(data)
}

export const waitForExtractSceneTiming: PipelineFunction = async (data, context) => {
	console.log(`[EXTRACTION PHASE] Entering waitForExtractSceneTiming`)
	await context.updateStatus('Waiting for scene timing detection...')
	await context.waitForTask('sceneTiming')
	console.log(`[EXTRACTION PHASE] Leaving waitForExtractSceneTiming`)
	context.next(data)
}

export const waitForGenerateSceneDescription: PipelineFunction = async (data, context) => {
	console.log(`[EXTRACTION PHASE] Entering waitForGenerateSceneDescription`)
	await context.updateStatus('Waiting for scene descriptions...')
	await context.waitForTask('sceneDescriptions')
	console.log(`[EXTRACTION PHASE] Leaving waitForGenerateSceneDescription`)
	context.next(data)
}
