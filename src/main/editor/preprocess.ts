import fs from 'fs'
import path from 'path'
import { setMaxListeners } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { Clip, MediaAsset } from '@shared/types'
import type { PipelineContext } from '../pipeline'
import { threadManager } from '../threads'
import { backgroundTaskManager } from '../tasks'
import * as ffmpegAdapter from '../ffmpeg'
import { SceneDetector, checkScenedetectAvailability, type Scene } from '../scenedetect'
import * as extraction from '../pipeline/phases/extraction'
import { ASSET_DIRS } from '../constants/paths'
import { getAssetDir, patchAsset, patchAssetPreprocessing } from './assets'

/**
 * Per-asset preprocessing orchestrator for the timeline editor.
 *
 * Design (video-editor-prd.md §5.2/§7): a lean, editor-shaped step chain
 * (proxy -> scenes -> thumbnails -> clips) calling the ffmpeg/scenedetect
 * helpers directly, plus an OPT-IN Gemini descriptions step that reuses
 * extraction.generateSceneDescription VERBATIM through an asset-scoped
 * PipelineContext (tempDir = tempDir/media/<assetId>), leaving the chat
 * preprocessing chains untouched.
 *
 * Task ids are namespaced `${assetId}:<step>` inside the existing
 * thread.backgroundTasks + background-task-update broadcast.
 */

export type PreprocessStep =
	'proxy' | 'scenes' | 'thumbnails' | 'descriptions' | 'audio' | 'transcript' | 'filmstrip'

// Transcript runs UP FRONT (before scenes) so pieces derive from real speech
// segments; scene detection stays as the fallback piece source for videos
// with no usable transcript and for explicit sensitivity re-runs.
const DEFAULT_STEPS: PreprocessStep[] = ['proxy', 'audio', 'transcript', 'scenes', 'thumbnails']

// Audio/transcript failures (missing Gemini key, quota) must not brick the
// import — the chain continues and pieces fall back to scene detection.
const SOFT_FAIL_STEPS: PreprocessStep[] = ['audio', 'transcript']

export const SCENEDETECT_MISSING = 'scenedetect-missing'

// ===== Concurrency cap (K=3) for ffmpeg/scenedetect-heavy work =====
const MAX_CONCURRENT_HEAVY = 3
let heavyRunning = 0
const heavyQueue: Array<() => void> = []

async function withHeavySlot<T>(fn: () => Promise<T>): Promise<T> {
	if (heavyRunning >= MAX_CONCURRENT_HEAVY) {
		await new Promise<void>((resolve) => heavyQueue.push(resolve))
	}
	heavyRunning++
	try {
		return await fn()
	} finally {
		heavyRunning--
		const next = heavyQueue.shift()
		if (next) next()
	}
}

// ===== Abort registry =====
const abortControllers = new Map<string, AbortController>()

const abortKey = (threadId: string, assetId: string) => `${threadId}:${assetId}`

export function abortAssetPreprocessing(threadId: string, assetId: string): void {
	const key = abortKey(threadId, assetId)
	const controller = abortControllers.get(key)
	if (controller) {
		controller.abort()
		abortControllers.delete(key)
	}
}

export function isAssetPreprocessing(threadId: string, assetId: string): boolean {
	return abortControllers.has(abortKey(threadId, assetId))
}

// ===== Helpers =====

function getAsset(threadId: string, assetId: string): MediaAsset | null {
	const thread = threadManager.getThread(threadId)
	return thread?.editor?.media.find((a) => a.id === assetId) || null
}

function exists(p?: string): boolean {
	return !!p && fs.existsSync(p)
}

const taskId = (assetId: string, step: PreprocessStep) => `${assetId}:${step}`

/**
 * Throttled per-step progress reporter: every setTask persists the thread
 * JSON and broadcasts, so noisy sources (ffmpeg/scenedetect ticks) are
 * quantized to ≥5% jumps.
 */
function makeProgressReporter(threadId: string, assetId: string, step: PreprocessStep) {
	let last = -1
	return (percent: number, status?: string) => {
		const p = Math.min(100, Math.max(0, Math.round(percent)))
		if (p - last < 5 && p !== 100) return
		last = p
		void setTask(threadId, assetId, step, { state: 'running', progress: p, ...(status ? { status } : {}) })
	}
}

/**
 * Best-effort numeric progress from a phase's human status text — reused
 * phases only report strings (e.g. "Converting to audio... 45%",
 * "Analyzing scenes 51 to 100 / 418..."). Returns null when no number.
 */
function progressFromStatus(status: string): number | null {
	const pct = status.match(/(\d{1,3})\s*%/)
	if (pct) return Math.min(100, Number(pct[1]))
	const count = status.match(/(\d+)\s*(?:to\s+(\d+))?\s*\/\s*(\d+)/)
	if (count) {
		const done = Number(count[2] ?? count[1])
		const total = Number(count[3])
		if (total > 0 && done <= total) return Math.round((done / total) * 100)
	}
	return null
}

async function setTask(
	threadId: string,
	assetId: string,
	step: PreprocessStep,
	updates: Parameters<typeof backgroundTaskManager.updateTask>[2]
) {
	await backgroundTaskManager.updateTask(threadId, taskId(assetId, step), {
		name: step,
		...updates
	})
}

/**
 * Asset-scoped PipelineContext bridge so existing pipeline phases
 * (generateSceneDescription today; transcript phases later) run per-asset.
 * Modeled on backgroundTaskManager.createMockContext, but all reads/writes
 * target the MediaAsset record and the asset's artifact dir.
 */
function createAssetContext(
	threadId: string,
	assetId: string,
	step: PreprocessStep,
	signal: AbortSignal
): PipelineContext {
	const thread = threadManager.getThread(threadId)!
	const asset = getAsset(threadId, assetId)!
	const assetDir = getAssetDir(thread, assetId)

	return {
		threadId,
		videoPath: asset.proxyPath || asset.originalPath,
		tempDir: assetDir, // THREAD_DIRS.FRAMES/ANALYSIS joins inside phases land under the asset dir
		get preprocessing() {
			return getAsset(threadId, assetId)?.preprocessing || {}
		},
		messageId: `editor-${assetId}`,
		context: '',
		baseTimeline: undefined,
		intentResult: undefined,
		updateStatus: async (status: string) => {
			const progress = progressFromStatus(status)
			await setTask(threadId, assetId, step, {
				state: 'running',
				status,
				...(progress !== null ? { progress } : {})
			})
		},
		recordUsage: async (record) => {
			await threadManager.updateThreadWith(threadId, (t) => ({
				usageHistory: [...(t.usageHistory || []), { ...record, timestamp: Date.now() }]
			}))
		},
		savePreprocessing: async (updates) => {
			await patchAssetPreprocessing(threadId, assetId, updates)
		},
		waitForTask: async () => { },
		next: () => { },
		finish: async () => { },
		fail: async (error: string) => {
			await setTask(threadId, assetId, step, { state: 'error', error })
		},
		signal
	}
}

// ===== Steps =====

async function runProxyStep(threadId: string, assetId: string, signal: AbortSignal) {
	const asset = getAsset(threadId, assetId)!
	if (exists(asset.proxyPath)) {
		await setTask(threadId, assetId, 'proxy', { state: 'completed', progress: 100 })
		return
	}

	await setTask(threadId, assetId, 'proxy', { state: 'running', status: 'Creating 480p proxy…', progress: 0 })

	const thread = threadManager.getThread(threadId)!
	const proxyDir = path.join(getAssetDir(thread, assetId), ASSET_DIRS.PROXY)
	if (!fs.existsSync(proxyDir)) fs.mkdirSync(proxyDir, { recursive: true })

	let proxyPath: string
	if (await ffmpegAdapter.isVideoLowResolution(asset.originalPath)) {
		// Already <=480p — reuse the original as the proxy
		proxyPath = asset.originalPath
	} else {
		proxyPath = await withHeavySlot(() =>
			ffmpegAdapter.toLowResolution(
				asset.originalPath,
				proxyDir,
				(percent) => setTask(threadId, assetId, 'proxy', { state: 'running', progress: percent }),
				signal,
				{ sourceFps: asset.metadata?.fps }
			)
		)
	}

	await patchAsset(threadId, assetId, { proxyPath })
	await patchAssetPreprocessing(threadId, assetId, { lowResVideoPath: proxyPath })
	await setTask(threadId, assetId, 'proxy', { state: 'completed', progress: 100 })
}

async function runScenesStep(
	threadId: string,
	assetId: string,
	signal: AbortSignal,
	threshold?: number
) {
	const asset = getAsset(threadId, assetId)!
	const forceRerun = threshold !== undefined

	if (!forceRerun && exists(asset.preprocessing.sceneTimesPath)) {
		await setTask(threadId, assetId, 'scenes', { state: 'completed', progress: 100 })
		return
	}

	await setTask(threadId, assetId, 'scenes', { state: 'running', status: 'Detecting scenes…', progress: 0 })
	const reportScenes = makeProgressReporter(threadId, assetId, 'scenes')

	const available = await checkScenedetectAvailability()
	if (!available) {
		throw new Error(SCENEDETECT_MISSING)
	}

	const thread = threadManager.getThread(threadId)!
	const analysisDir = path.join(getAssetDir(thread, assetId), ASSET_DIRS.ANALYSIS)
	if (!fs.existsSync(analysisDir)) fs.mkdirSync(analysisDir, { recursive: true })
	const sceneTimesPath = path.join(analysisDir, 'scenes.json')

	const detector = new SceneDetector()
	const videoPath = asset.proxyPath || asset.originalPath
	let scenes = await withHeavySlot(() =>
		detector.detectScenes(videoPath, signal, threshold, (p) => reportScenes(p))
	)

	// A cut-less video (talking head, screen recording) can yield zero rows —
	// fall back to a single whole-video scene so there is always one piece.
	if (scenes.length === 0 && asset.metadata?.duration) {
		scenes = [{ startTime: 0, endTime: asset.metadata.duration, duration: asset.metadata.duration }]
	}

	fs.writeFileSync(sceneTimesPath, JSON.stringify(scenes, null, 2))
	await patchAssetPreprocessing(threadId, assetId, { sceneTimesPath })

	// Pieces come from the TRANSCRIPT when one was derived earlier in the
	// chain; scenes only produce pieces as the fallback (no transcript) or on
	// an explicit sensitivity re-run (the user asked for scene pieces).
	const hasClips = (getAsset(threadId, assetId)?.clips || []).length > 0
	if (forceRerun || !hasClips) {
		await deriveClips(threadId, assetId, scenes)
	}

	await setTask(threadId, assetId, 'scenes', {
		state: 'completed',
		progress: 100,
		status: `${scenes.length} scenes detected`
	})
}

/**
 * Map Scene[] -> Clip[] on the asset, preserving renderer-owned `selected`
 * and prior `visual`/`thumbnailPath` by (in,out) epsilon-match on re-runs.
 */
async function deriveClips(threadId: string, assetId: string, scenes: Scene[]) {
	const EPSILON = 0.05
	await patchAsset(threadId, assetId, (current) => {
		const previous = current.clips || []
		const clips: Clip[] = scenes.map((scene, i) => {
			const match = previous.find(
				(c) => Math.abs(c.in - scene.startTime) <= EPSILON && Math.abs(c.out - scene.endTime) <= EPSILON
			)
			return {
				id: match?.id || uuidv4(),
				sourceAssetId: assetId,
				index: i + 1,
				in: scene.startTime,
				out: scene.endTime,
				duration: scene.duration,
				thumbnailPath: match?.thumbnailPath,
				visual: match?.visual,
				text: match?.text,
				selected: match?.selected ?? false,
				masterSegmentIndex: i + 1
			}
		})
		return { clips }
	})
}

// Gap handling for transcript-derived pieces — mirrors timeline/enrichment.ts
// so silence between statements stays visible and selectable.
const MIN_GAP_SEC = 0.5
const MAX_GAP_CHUNK_SEC = 15.0

/**
 * Map the transcript -> Clip[]: one piece per spoken statement, plus
 * "[Silence]" pieces over gaps, so the tray shows REAL editorial segments
 * (what was said) instead of visual scene cuts. Prior clip props survive by
 * (in,out) epsilon-match.
 */
async function deriveClipsFromTranscript(threadId: string, assetId: string): Promise<number> {
	const asset = getAsset(threadId, assetId)
	const transcriptPath = asset?.preprocessing.transcriptPath
	if (!asset || !exists(transcriptPath)) return 0

	const items: { start: string; end: string; text: string }[] =
		JSON.parse(fs.readFileSync(transcriptPath!, 'utf-8'))
	const duration = asset.metadata?.duration || 0

	type Seg = { in: number; out: number; text?: string }
	const segments: Seg[] = []
	const pushGap = (from: number, to: number) => {
		let cursor = from
		while (to - cursor > MIN_GAP_SEC) {
			const end = Math.min(cursor + MAX_GAP_CHUNK_SEC, to)
			segments.push({ in: cursor, out: end, text: '[Silence]' })
			cursor = end
		}
	}

	let previousEnd = 0
	for (const item of [...items].sort((a, b) => srtToSeconds(a.start) - srtToSeconds(b.start))) {
		const start = srtToSeconds(item.start)
		const end = srtToSeconds(item.end)
		if (!(end > start)) continue
		if (start - previousEnd > MIN_GAP_SEC) pushGap(previousEnd, start)
		segments.push({ in: start, out: end, text: item.text })
		previousEnd = Math.max(previousEnd, end)
	}
	if (duration - previousEnd > MIN_GAP_SEC) pushGap(previousEnd, duration)

	if (segments.length === 0) return 0

	const EPSILON = 0.05
	await patchAsset(threadId, assetId, (current) => {
		const previous = current.clips || []
		const clips: Clip[] = segments.map((seg, i) => {
			const match = previous.find(
				(c) => Math.abs(c.in - seg.in) <= EPSILON && Math.abs(c.out - seg.out) <= EPSILON
			)
			return {
				id: match?.id || uuidv4(),
				sourceAssetId: assetId,
				index: i + 1,
				in: seg.in,
				out: seg.out,
				duration: seg.out - seg.in,
				thumbnailPath: match?.thumbnailPath,
				visual: match?.visual,
				text: seg.text,
				selected: match?.selected ?? false,
				masterSegmentIndex: undefined // speech segments don't map to master scenes
			}
		})
		return { clips }
	})
	return segments.length
}

async function runThumbnailsStep(threadId: string, assetId: string, signal: AbortSignal) {
	const asset = getAsset(threadId, assetId)!
	// Thumbnails follow the CLIPS (whatever derived them — transcript segments
	// or scene detection), one midpoint frame per piece.
	const targets = (asset.clips || []).map((c) => ({ id: c.id, midpoint: c.in + c.duration / 2 }))
	if (targets.length === 0) {
		await setTask(threadId, assetId, 'thumbnails', { state: 'completed', status: 'No pieces to thumbnail' })
		return
	}

	const thread = threadManager.getThread(threadId)!
	const framesDir = path.join(getAssetDir(thread, assetId), ASSET_DIRS.FRAMES)
	if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true })

	await setTask(threadId, assetId, 'thumbnails', { state: 'running', status: 'Extracting thumbnails…', progress: 0 })

	const videoPath = asset.proxyPath || asset.originalPath
	const thumbnails = new Map<string, string>() // clipId -> framePath

	// Patch finished thumbnails into the (already-derived) clips so tiles fill
	// in progressively. Every updateTask/patchAsset persists the thread JSON,
	// so both are THROTTLED to a batch cadence rather than per-frame.
	const flushThumbnails = async () => {
		await patchAsset(threadId, assetId, (current) => ({
			clips: (current.clips || []).map((clip) =>
				thumbnails.has(clip.id) ? { ...clip, thumbnailPath: thumbnails.get(clip.id) } : clip
			)
		}))
	}

	const BATCH = Math.max(1, Math.min(8, Math.floor(targets.length / 25) || 1))

	await withHeavySlot(async () => {
		for (let i = 0; i < targets.length; i++) {
			if (signal.aborted) throw new Error('Aborted')
			try {
				// extractFrame filenames are deterministic (…_frame_<t>.jpg) — re-runs reuse them
				const framePath = await ffmpegAdapter.extractFrame(videoPath, targets[i].midpoint, framesDir, signal)
				thumbnails.set(targets[i].id, framePath)
			} catch (error) {
				if (signal.aborted) throw error
				console.error(`[editor] Thumbnail failed for piece ${i} of asset ${assetId}:`, error)
				// tolerate individual frame failures
			}

			const done = i + 1
			if (done % BATCH === 0 || done === targets.length) {
				await flushThumbnails()
				await setTask(threadId, assetId, 'thumbnails', {
					state: 'running',
					status: `${done}/${targets.length} thumbnails`,
					progress: Math.round((done / targets.length) * 100)
				})
			}
		}
	})

	await setTask(threadId, assetId, 'thumbnails', { state: 'completed', progress: 100 })
}

async function runDescriptionsStep(threadId: string, assetId: string, signal: AbortSignal) {
	const asset = getAsset(threadId, assetId)!
	if (!exists(asset.preprocessing.sceneTimesPath)) {
		throw new Error('Scenes must be detected before describing them.')
	}

	await setTask(threadId, assetId, 'descriptions', { state: 'running', status: 'Describing scenes…' })

	// Reuse the existing pipeline phase VERBATIM through an asset-scoped context.
	const context = createAssetContext(threadId, assetId, 'descriptions', signal)
	await extraction.generateSceneDescription({}, context)

	if (signal.aborted) throw new Error('Aborted')

	// Merge generated descriptions back into the asset's clips (by scene index).
	const descriptionsPath = getAsset(threadId, assetId)?.preprocessing.sceneDescriptionsPath
	if (exists(descriptionsPath)) {
		const descriptions: { index: number; description: string; framePath: string }[] =
			JSON.parse(fs.readFileSync(descriptionsPath!, 'utf-8'))
		const byIndex = new Map(descriptions.map((d) => [d.index, d]))

		await patchAsset(threadId, assetId, (current) => ({
			clips: (current.clips || []).map((clip) => {
				const desc = byIndex.get(clip.index - 1) // descriptions are 0-based scene indices
				return desc
					? { ...clip, visual: desc.description, thumbnailPath: clip.thumbnailPath || desc.framePath }
					: clip
			})
		}))
	}

	await setTask(threadId, assetId, 'descriptions', { state: 'completed', progress: 100 })
}

async function runAudioStep(threadId: string, assetId: string, signal: AbortSignal) {
	const asset = getAsset(threadId, assetId)!
	if (exists(asset.preprocessing.audioPath)) {
		await setTask(threadId, assetId, 'audio', { state: 'completed', progress: 100 })
		return
	}

	await setTask(threadId, assetId, 'audio', { state: 'running', status: 'Extracting audio…' })

	// Reuse the existing extraction phase VERBATIM through an asset-scoped context.
	const context = createAssetContext(threadId, assetId, 'audio', signal)
	await withHeavySlot(async () => { await extraction.convertToAudio({}, context) })

	if (signal.aborted) throw new Error('Aborted')
	await setTask(threadId, assetId, 'audio', { state: 'completed', progress: 100 })
}

async function runTranscriptStep(threadId: string, assetId: string, signal: AbortSignal) {
	const asset = getAsset(threadId, assetId)!
	if (!exists(asset.preprocessing.audioPath)) {
		throw new Error('Audio must be extracted before transcription.')
	}

	// A single Gemini call has no incremental signal — report honest stage
	// milestones so the bar still moves: upload/transcribe → merge → done.
	await setTask(threadId, assetId, 'transcript', {
		state: 'running', status: 'Uploading audio & transcribing…', progress: 10
	})

	// Reuse the raw-transcript phase VERBATIM (single Gemini pass — the editor
	// keeps transcription lean; the chat flow's corrected pass is not run here).
	const context = createAssetContext(threadId, assetId, 'transcript', signal)
	await extraction.extractRawTranscript({}, context)

	if (signal.aborted) throw new Error('Aborted')

	await setTask(threadId, assetId, 'transcript', {
		state: 'running', status: 'Deriving pieces from speech…', progress: 85
	})

	// Fresh import (no pieces yet): pieces ARE the transcript segments.
	// Existing scene pieces (sensitivity re-run, later re-transcribe): keep
	// them and just fill their text by overlap.
	const hasClips = (getAsset(threadId, assetId)?.clips || []).length > 0
	if (hasClips) {
		await mergeTranscriptIntoClips(threadId, assetId)
	} else {
		const derived = await deriveClipsFromTranscript(threadId, assetId)
		if (derived === 0) {
			// Empty/unusable transcript — scenes step will derive fallback pieces
			await setTask(threadId, assetId, 'transcript', {
				state: 'completed', progress: 100, status: 'No speech found — using scene pieces'
			})
			return
		}
		await setTask(threadId, assetId, 'transcript', {
			state: 'completed', progress: 100, status: `${derived} speech segments`
		})
		return
	}

	await setTask(threadId, assetId, 'transcript', { state: 'completed', progress: 100 })
}

// Cap total strip frames per asset so a multi-hour source stays one bounded
// pass (PRD §5.5/§8): interval = max(1s, duration/300).
const FILMSTRIP_MAX_FRAMES = 300

async function runFilmstripStep(threadId: string, assetId: string, signal: AbortSignal) {
	const asset = getAsset(threadId, assetId)!
	if (asset.filmstrip?.length) {
		await setTask(threadId, assetId, 'filmstrip', { state: 'completed', progress: 100 })
		return
	}

	await setTask(threadId, assetId, 'filmstrip', { state: 'running', status: 'Generating filmstrip…', progress: 0 })
	const reportFilmstrip = makeProgressReporter(threadId, assetId, 'filmstrip')

	const thread = threadManager.getThread(threadId)!
	const stripDir = path.join(getAssetDir(thread, assetId), ASSET_DIRS.FRAMES, 'strip')
	if (!fs.existsSync(stripDir)) fs.mkdirSync(stripDir, { recursive: true })

	const duration = asset.metadata?.duration || 0
	const intervalSec = Math.max(1, duration / FILMSTRIP_MAX_FRAMES)
	const videoPath = asset.proxyPath || asset.originalPath

	const filmstrip = await withHeavySlot(() =>
		ffmpegAdapter.generateFilmstrip(videoPath, stripDir, intervalSec, signal, (p) => reportFilmstrip(p))
	)

	await patchAsset(threadId, assetId, { filmstrip })
	await setTask(threadId, assetId, 'filmstrip', {
		state: 'completed',
		progress: 100,
		status: `${filmstrip.length} frames`
	})
}

/** `HH:MM:SS,mmm` (or `MM:SS,mmm`) → seconds. Mirrors enrichment.ts timeToSeconds. */
function srtToSeconds(t: string): number {
	const clean = t.trim().replace(',', '.')
	const [timePart, milliPart = '0'] = clean.split('.')
	const parts = timePart.split(':').map(Number)
	let seconds = 0
	if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
	else if (parts.length === 2) seconds = parts[0] * 60 + parts[1]
	else seconds = parts[0] || 0
	return seconds + parseFloat(`0.${milliPart}`)
}

/**
 * Populate each Clip.text with the transcript excerpt overlapping [in, out].
 * Mirrors the clip.visual merge in runDescriptionsStep, but keyed by time
 * overlap rather than scene index (transcript segments don't align to scenes).
 */
async function mergeTranscriptIntoClips(threadId: string, assetId: string) {
	const transcriptPath = getAsset(threadId, assetId)?.preprocessing.transcriptPath
	if (!exists(transcriptPath)) return

	const items: { start: string; end: string; text: string }[] =
		JSON.parse(fs.readFileSync(transcriptPath!, 'utf-8'))
	const ranges = items.map((it) => ({
		start: srtToSeconds(it.start),
		end: srtToSeconds(it.end),
		text: (it.text || '').trim()
	}))

	await patchAsset(threadId, assetId, (current) => ({
		clips: (current.clips || []).map((clip) => {
			// Overlap test: item[s,e] intersects clip[in,out] when s < out && e > in.
			const text = ranges
				.filter((r) => r.start < clip.out && r.end > clip.in && r.text && r.text !== '[Silence]')
				.map((r) => r.text)
				.join(' ')
				.trim()
			return text ? { ...clip, text } : clip
		})
	}))
}

// ===== Orchestrator =====

export async function preprocessMediaAsset(
	threadId: string,
	assetId: string,
	options?: { steps?: PreprocessStep[]; threshold?: number }
): Promise<void> {
	const asset = getAsset(threadId, assetId)
	if (!asset) return
	if (isAssetPreprocessing(threadId, assetId)) return // already running

	const steps = options?.steps?.length ? options.steps : DEFAULT_STEPS
	const controller = new AbortController()
	// Every ffmpeg call (one per scene thumbnail) attaches an abort listener to
	// this shared signal — lift Node's default cap of 10 to avoid leak warnings.
	setMaxListeners(0, controller.signal)
	abortControllers.set(abortKey(threadId, assetId), controller)
	const { signal } = controller

	await patchAsset(threadId, assetId, { preprocessState: 'running', preprocessError: undefined })

	// Pre-register every step as pending so the UI shows the full checklist
	// immediately and each bar visibly transitions pending -> running -> done.
	for (const step of steps) {
		await setTask(threadId, assetId, step, { state: 'pending', progress: 0, status: undefined, error: undefined })
	}

	let currentStep: PreprocessStep | null = null
	try {
		// A threshold re-run must re-detect scenes even if outputs exist
		if (options?.threshold !== undefined) {
			await patchAssetPreprocessing(threadId, assetId, { sceneTimesPath: undefined })
		}

		for (const step of steps) {
			if (signal.aborted) throw new Error('Aborted')
			currentStep = step
			try {
				switch (step) {
					case 'proxy': await runProxyStep(threadId, assetId, signal); break
					case 'scenes': await runScenesStep(threadId, assetId, signal, options?.threshold); break
					case 'thumbnails': await runThumbnailsStep(threadId, assetId, signal); break
					case 'descriptions': await runDescriptionsStep(threadId, assetId, signal); break
					case 'audio': await runAudioStep(threadId, assetId, signal); break
					case 'transcript': await runTranscriptStep(threadId, assetId, signal); break
					case 'filmstrip': await runFilmstripStep(threadId, assetId, signal); break
				}
			} catch (stepError: any) {
				// Audio/transcript are best-effort in the default chain: a missing
				// Gemini key or quota error falls back to scene pieces instead of
				// bricking the import. Everything else still hard-fails.
				if (signal.aborted || !SOFT_FAIL_STEPS.includes(step)) throw stepError
				const message = stepError?.message || `${step} failed`
				console.warn(`[editor] ${step} failed for asset ${assetId} — continuing without it:`, message)
				await setTask(threadId, assetId, step, { state: 'error', error: message })
			}
		}

		await patchAsset(threadId, assetId, { preprocessState: 'completed' })
	} catch (error: any) {
		if (signal.aborted) {
			// Asset removed or run cancelled — leave whatever state the removal left
			console.log(`[editor] Preprocessing aborted for asset ${assetId}`)
			return
		}
		const message = error?.message || 'Preprocessing failed'
		console.error(`[editor] Preprocessing failed for asset ${assetId} (step: ${currentStep}):`, error)
		// Mark the failed step's task and the asset errored; other assets are unaffected.
		if (currentStep) {
			await setTask(threadId, assetId, currentStep, { state: 'error', error: message })
		}
		await patchAsset(threadId, assetId, {
			preprocessState: 'error',
			preprocessError: message === SCENEDETECT_MISSING
				? `${SCENEDETECT_MISSING}: PySceneDetect is not installed — scene splitting is unavailable.`
				: message
		})
	} finally {
		abortControllers.delete(abortKey(threadId, assetId))
	}
}
