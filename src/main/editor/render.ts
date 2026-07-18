import { BrowserWindow } from 'electron'
import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import process from 'node:process'
import { v4 as uuidv4 } from 'uuid'
import type {
	EditorDocument, EditorRenderProgress, ExportQuality, MediaAsset,
	TimelineItem, TimelineSegment, Track
} from '@shared/types'
import { itemDuration, itemEnd } from '@shared/timeline'
import { threadManager } from '../threads'
import { assembleVideo, sanitizeFilename } from '../ffmpeg'
import { THREAD_DIRS } from '../constants/paths'

/**
 * Export render engine (PRD §5.9 / §7 option C — segment-then-concat).
 *
 * Fast path: a single-source, speed-1, unmuted, gapless timeline maps to
 * TimelineSegment[] and reuses assembleVideo unchanged.
 *
 * Region path: the sequence is sliced at clip boundaries into regions
 * (clip | gap); each region renders to a UNIFORM mp4 intermediate
 * (h264 + aac 48kHz stereo, normalized W×H/FPS, both streams always
 * present), then the concat demuxer stitches with -c copy. Per-item
 * speed renders via setpts + chained atempo (or asetrate when
 * preservePitch=false). Gaps render black + silence.
 *
 * The region model carries audioSources[] (0..1 entries today) so the
 * P2 multi-source amix graph slots in without reshaping.
 */

const IS_MAC = process.platform === 'darwin'
const GAP_EPS = 0.05

// ===== Region model =====

interface AudioSource {
	srcPath: string
	in: number
	out: number
	speed: number
	preservePitch: boolean
	gain: number
}

type Region =
	| { kind: 'clip'; item: TimelineItem; asset: MediaAsset; srcPath: string; duration: number; audioSources: AudioSource[] }
	| { kind: 'gap'; duration: number }

interface RegionPlan {
	regions: Region[]
	width: number
	height: number
	fps: number
}

export function computeRegions(doc: EditorDocument, quality: ExportQuality): RegionPlan {
	const videoTrack = doc.tracks
		.filter((t) => t.kind === 'video')
		.sort((a, b) => a.order - b.order)[0]
	if (!videoTrack || videoTrack.hidden) {
		throw new Error('Nothing to export — the video track is hidden or empty.')
	}

	const items = doc.timeline
		.filter((i) => i.trackId === videoTrack.id)
		.sort((a, b) => a.timelineStart - b.timelineStart)
	if (items.length === 0) {
		throw new Error('Nothing to export — the timeline is empty.')
	}

	// Normalization target: source-derived (timelineMeta is blindly seeded
	// 1920x1080 and would silently upscale small sources).
	const usedAssets = [...new Set(items.map((i) => i.sourceAssetId))]
		.map((id) => doc.media.find((a) => a.id === id))
		.filter((a): a is MediaAsset => !!a)
	const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
	const largest = usedAssets.reduce((best, a) => {
		const area = (a.metadata?.width || 0) * (a.metadata?.height || 0)
		return area > best.area ? { area, w: a.metadata!.width, h: a.metadata!.height } : best
	}, { area: 0, w: 1280, h: 720 })
	const width = even(largest.w)
	const height = even(largest.h)
	const fps = Math.min(60, Math.max(10,
		usedAssets.reduce((max, a) => Math.max(max, a.metadata?.fps || 0), 0) || 30
	))

	const regions: Region[] = []
	let cursor = 0
	for (const item of items) {
		const gap = item.timelineStart - cursor
		if (gap > GAP_EPS) {
			regions.push({ kind: 'gap', duration: gap })
		} else if (gap < -GAP_EPS) {
			// Overlap (e.g. from an AI accept made before overlap repair):
			// render magnetically — this item butts against the previous one,
			// preserving all content instead of failing the export.
			console.warn(`[render] Overlapping item ${item.id} repaired: butted at ${cursor.toFixed(2)}s`)
		}

		const asset = doc.media.find((a) => a.id === item.sourceAssetId)
		if (!asset) throw new Error(`Missing media asset for clip "${item.label || item.id}".`)
		const srcPath = quality === 'preview'
			? (asset.proxyPath || asset.originalPath)
			: asset.originalPath

		const speed = item.speed || 1
		const muted = !!item.muted || videoTrack.muted || asset.metadata?.hasAudio === false
		regions.push({
			kind: 'clip',
			item,
			asset,
			srcPath,
			duration: itemDuration(item),
			audioSources: muted ? [] : [{
				srcPath,
				in: item.in,
				out: item.out,
				speed,
				preservePitch: item.preservePitch !== false,
				gain: item.gain ?? 1
			}]
		})
		cursor = Math.max(cursor, itemEnd(item))
	}

	return { regions, width, height, fps }
}

// ===== Fast path =====

export function isFastPathEligible(items: TimelineItem[], track: Track): boolean {
	if (items.length === 0) return false
	if (track.muted || track.hidden) return false // assembleVideo can't drop audio
	const srcId = items[0].sourceAssetId
	if (!items.every((i) => i.sourceAssetId === srcId)) return false
	if (!items.every((i) => (i.speed ?? 1) === 1)) return false // no setpts in assembleVideo
	if (items.some((i) => i.muted)) return false
	if (Math.abs(items[0].timelineStart) > GAP_EPS) return false // leading gap needs black
	for (let i = 1; i < items.length; i++) {
		if (Math.abs(items[i].timelineStart - itemEnd(items[i - 1])) > GAP_EPS) return false
	}
	return true
}

// ===== ffmpeg building blocks =====

const vnorm = (w: number, h: number, fps: number) =>
	`scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
	`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`

/** Chain atempo stages so each stays within ffmpeg's 0.5–2.0 range. */
export function atempoChain(speed: number): string {
	const stages: number[] = []
	let factor = speed
	while (factor > 2) { stages.push(2); factor /= 2 }
	while (factor < 0.5) { stages.push(0.5); factor /= 0.5 }
	stages.push(factor)
	return stages.map((s) => `atempo=${s.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`).join(',')
}

// Uniform intermediates: identical codec/res/fps/rate/layout is REQUIRED for
// concat -c copy. Forced h264+aac mp4 on all platforms (incl. webm sources).
const intermediateOpts = (): string[] => [
	...(IS_MAC
		? ['-c:v', 'h264_videotoolbox', '-b:v', '8M', '-realtime', 'true']
		: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18']),
	'-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
	'-video_track_timescale', '90000',
	'-threads', '0'
]

function runCommand(
	command: ffmpeg.FfmpegCommand,
	outputPath: string,
	signal: AbortSignal,
	onProgress?: (percent: number) => void
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error('aborted'))
		signal.addEventListener('abort', () => command.kill('SIGKILL'))
		command
			.output(outputPath)
			.on('start', (cmd) => console.log('[render] ffmpeg:', cmd))
			.on('progress', (progress) => {
				if (onProgress && progress.percent) onProgress(Math.min(100, Math.round(progress.percent)))
			})
			.on('end', () => resolve())
			.on('error', (err, _stdout, stderr) => {
				if (signal.aborted) return reject(new Error('aborted'))
				console.error('[render] ffmpeg failed:', err?.message, stderr?.slice(-800))
				reject(new Error(`Render step failed: ${err?.message || 'ffmpeg error'}`))
			})
			.run()
	})
}

async function renderClipRegion(
	region: Extract<Region, { kind: 'clip' }>,
	index: number,
	plan: RegionPlan,
	workDir: string,
	signal: AbortSignal,
	onProgress: (percent: number) => void
): Promise<string> {
	const { item } = region
	const speed = item.speed || 1
	const cut = item.out - item.in
	const duration = region.duration
	const outputPath = path.join(workDir, `region-${String(index).padStart(3, '0')}.mp4`)
	const videoFilter = `[0:v]setpts=(PTS-STARTPTS)/${speed},${vnorm(plan.width, plan.height, plan.fps)}[v]`

	let command: ffmpeg.FfmpegCommand
	if (region.audioSources.length > 0) {
		const audio = region.audioSources[0]
		const retime = speed === 1
			? ''
			: audio.preservePitch
				? `${atempoChain(speed)},`
				: `asetrate=48000*${speed},`
		const gain = audio.gain !== 1 ? `volume=${audio.gain},` : ''
		command = ffmpeg(region.srcPath)
			.inputOptions(['-ss', item.in.toFixed(3), '-t', cut.toFixed(3)])
			.complexFilter(
				`${videoFilter};` +
				`[0:a]asetpts=PTS-STARTPTS,${retime}${gain}aresample=48000,` +
				`aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${duration.toFixed(3)}[a]`
			)
	} else {
		// Silent clip: lavfi anullsrc keeps every intermediate A+V uniform
		command = ffmpeg(region.srcPath)
			.inputOptions(['-ss', item.in.toFixed(3), '-t', cut.toFixed(3)])
			.input('anullsrc=r=48000:cl=stereo')
			.inputFormat('lavfi')
			.complexFilter(`${videoFilter};[1:a]atrim=0:${duration.toFixed(3)}[a]`)
	}

	command
		.map('[v]')
		.map('[a]')
		.outputOptions([...intermediateOpts(), '-t', duration.toFixed(3)])

	await runCommand(command, outputPath, signal, onProgress)
	return outputPath
}

async function renderGapRegion(
	region: Extract<Region, { kind: 'gap' }>,
	index: number,
	plan: RegionPlan,
	workDir: string,
	signal: AbortSignal
): Promise<string> {
	const duration = region.duration
	const outputPath = path.join(workDir, `region-${String(index).padStart(3, '0')}.mp4`)
	const command = ffmpeg(`color=black:size=${plan.width}x${plan.height}:rate=${plan.fps}`)
		.inputFormat('lavfi')
		.inputOptions(['-t', duration.toFixed(3)])
		.input('anullsrc=r=48000:cl=stereo')
		.inputFormat('lavfi')
		.inputOptions(['-t', duration.toFixed(3)])
		.outputOptions([...intermediateOpts(), '-vf', 'format=yuv420p', '-t', duration.toFixed(3)])
	await runCommand(command, outputPath, signal)
	return outputPath
}

async function concatRegions(
	regionFiles: string[],
	workDir: string,
	finalPath: string,
	signal: AbortSignal,
	reencode: boolean
): Promise<void> {
	const listPath = path.join(workDir, 'list.txt')
	const list = regionFiles
		.map((f) => `file '${path.basename(f).replace(/'/g, "'\\''")}'`)
		.join('\n')
	fs.writeFileSync(listPath, list)

	const command = ffmpeg(listPath)
		.inputOptions(['-f', 'concat', '-safe', '0'])
		.outputOptions(
			reencode
				? [...intermediateOpts(), '-movflags', '+faststart']
				: ['-c', 'copy', '-movflags', '+faststart']
		)
	await runCommand(command, finalPath, signal)
}

// ===== Orchestrator =====

const activeRenders = new Map<string, { controller: AbortController; workDir: string | null }>()

function emitRenderProgress(payload: EditorRenderProgress) {
	BrowserWindow.getAllWindows().forEach((win) => {
		win.webContents.send('editor-render-progress', payload)
	})
}

export function abortEditorRender(renderId: string): void {
	activeRenders.get(renderId)?.controller.abort()
}

export function abortRendersForThread(threadId: string): void {
	// renderIds are opaque; abort everything registered under this thread by
	// checking workDir containment (workdirs live under the thread's tempDir).
	const thread = threadManager.getThread(threadId)
	if (!thread) return
	for (const [, entry] of activeRenders) {
		if (entry.workDir && entry.workDir.startsWith(thread.tempDir)) {
			entry.controller.abort()
		}
	}
}

export function startEditorRender(options: { threadId: string; quality: ExportQuality }): { renderId: string } {
	const { threadId, quality } = options
	const thread = threadManager.getThread(threadId)
	if (!thread || thread.type !== 'editor' || !thread.editor) {
		throw new Error('Not an editor project')
	}
	const doc = thread.editor

	// ---- Pre-flight (synchronous — a bad timeline rejects the invoke
	// immediately instead of producing a ghost render) ----
	const plan = computeRegions(doc, quality)
	const srcPaths = [...new Set(
		plan.regions.flatMap((r) => (r.kind === 'clip' ? [r.srcPath] : []))
	)]
	const missing = srcPaths.filter((p) => !fs.existsSync(p))
	if (missing.length > 0) {
		throw new Error(`Missing source file(s): ${missing.map((p) => path.basename(p)).join(', ')}`)
	}

	const renderId = uuidv4()
	const exportsDir = path.join(thread.tempDir, THREAD_DIRS.EXPORTS)
	const workDir = path.join(exportsDir, renderId)
	fs.mkdirSync(workDir, { recursive: true })

	const controller = new AbortController()
	activeRenders.set(renderId, { controller, workDir })
	const { signal } = controller

	const progress = (percent: number, phase: EditorRenderProgress['phase']) =>
		emitRenderProgress({ threadId, renderId, percent: Math.round(percent), phase })

	// ---- Async render body ----
	void (async () => {
		const baseName = sanitizeFilename(thread.title || 'export')
		let finalPath = path.join(exportsDir, `${baseName}_${renderId.slice(0, 8)}.mp4`)
		try {
			progress(0, 'rendering')

			const videoTrack = doc.tracks
				.filter((t) => t.kind === 'video')
				.sort((a, b) => a.order - b.order)[0]
			const items = doc.timeline
				.filter((i) => i.trackId === videoTrack.id)
				.sort((a, b) => a.timelineStart - b.timelineStart)

			if (isFastPathEligible(items, videoTrack)) {
				// ---- Fast path: single-source trim+concat via assembleVideo ----
				const asset = doc.media.find((a) => a.id === items[0].sourceAssetId)!
				const srcPath = quality === 'preview'
					? (asset.proxyPath || asset.originalPath)
					: asset.originalPath
				const segments: TimelineSegment[] = items.map((item, i) => ({
					index: i + 1,
					start: item.in.toFixed(3), // NEVER String(): exponent forms break timeToSeconds
					end: item.out.toFixed(3),
					text: '',
					duration: item.out - item.in
				}))
				finalPath = await assembleVideo(
					srcPath,
					segments,
					exportsDir,
					renderId.slice(0, 8),
					(percent) => progress(percent * 0.98, 'rendering'),
					signal
				)
			} else {
				// ---- Region path: segment-then-concat ----
				const total = plan.regions.reduce((sum, r) => sum + r.duration, 0) || 1
				let doneWeight = 0
				let lastEmit = -1
				const regionFiles: string[] = []

				for (let i = 0; i < plan.regions.length; i++) {
					if (signal.aborted) throw new Error('aborted')
					const region = plan.regions[i]
					const weight = region.duration / total
					const onRegionProgress = (pct: number) => {
						const overall = (doneWeight + weight * (pct / 100)) * 96
						if (overall - lastEmit >= 1) {
							lastEmit = overall
							progress(overall, 'rendering')
						}
					}
					const file = region.kind === 'clip'
						? await renderClipRegion(region, i, plan, workDir, signal, onRegionProgress)
						: await renderGapRegion(region, i, plan, workDir, signal)
					regionFiles.push(file)
					doneWeight += weight
					progress(doneWeight * 96, 'rendering')
				}

				progress(96, 'stitching')
				try {
					await concatRegions(regionFiles, workDir, finalPath, signal, false)
				} catch (error) {
					if (signal.aborted) throw error
					console.warn('[render] copy-concat failed, retrying with re-encode:', error)
					await concatRegions(regionFiles, workDir, finalPath, signal, true)
				}
			}

			emitRenderProgress({ threadId, renderId, percent: 100, phase: 'done', outputPath: finalPath })
		} catch (error: any) {
			const message = signal.aborted ? 'aborted' : (error?.message || 'Export failed')
			if (!signal.aborted) console.error('[render] Export failed:', error)
			// Remove a partial final file
			try { if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath) } catch { /* ignore */ }
			emitRenderProgress({ threadId, renderId, percent: 0, phase: 'error', error: message })
		} finally {
			try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
			activeRenders.delete(renderId)
		}
	})()

	return { renderId }
}
