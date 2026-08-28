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
import { findOrphanItems, itemEnd } from '@shared/timeline'
import { planTransitions, sourceDurationsFrom, type TransitionWindow } from '@shared/transitionPlan'
import { threadManager } from '../threads'
import { assembleVideo, sanitizeFilename } from '../ffmpeg'
import { THREAD_DIRS } from '../constants/paths'
import {
	allSlices, audioBuilders, buildChain, videoBuilders,
	type BuildCtx, type Region, type RegionPlan, type SourceSlice
} from './renderBuilders'

export { atempoChain } from './renderBuilders'

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
/**
 * Boundaries closer together than this are the SAME boundary. Used to collapse
 * near-coincident cuts so the walker never emits a sliver region — which it used
 * to DROP outright, silently shortening the export.
 */
const SNAP_EPS = 0.05
/** Float slack for geometry comparisons. Never a tolerance on real content. */
const TIME_EPS = 1e-6

// ===== Region planning =====
// Regions are sliced at the UNION of every video- AND audio-item boundary, so
// each region is fully covered (or not) by each item — never partially. The
// region model (SourceSlice/Region/RegionPlan) lives in renderBuilders.ts;
// slices carry their originating item+track so filter builders read every
// adjustment field directly (§7 handler-based render).

/** Map a covering item's source range onto a sub-region [t0,t1) of the timeline. */
function sliceSource(item: TimelineItem, t0: number, t1: number): { in: number; out: number } {
	const speed = item.speed || 1
	return {
		in: item.in + (t0 - item.timelineStart) * speed,
		out: item.in + (t1 - item.timelineStart) * speed
	}
}

export function computeRegions(doc: EditorDocument, quality: ExportQuality): RegionPlan {
	// Video tracks TOP-most first (highest order wins visually); [0] of a
	// region's videoLayers is the layer v1 actually renders.
	const videoTracks = doc.tracks
		.filter((t) => t.kind === 'video' && !t.hidden)
		.sort((a, b) => b.order - a.order)
	const audioTrackById = new Map(
		doc.tracks.filter((t) => t.kind === 'audio' && !t.hidden).map((t) => [t.id, t])
	)

	const trackById = new Map(doc.tracks.map((t) => [t.id, t]))
	const videoTrackIds = new Set(videoTracks.map((t) => t.id))
	const videoItems = doc.timeline
		.filter((i) => videoTrackIds.has(i.trackId))
		.sort((a, b) => a.timelineStart - b.timelineStart)
	const audioItems = doc.timeline
		.filter((i) => audioTrackById.has(i.trackId))
		.sort((a, b) => a.timelineStart - b.timelineStart)

	if (videoItems.length === 0 && audioItems.length === 0) {
		throw new Error('Nothing to export — the timeline is empty.')
	}

	const assetById = new Map(doc.media.map((a) => [a.id, a]))

	// ---- Orphan pre-flight ----
	// A clip whose media was removed cannot be rendered. Report EVERY offender
	// at once with enough detail to find them, instead of dying on the first one
	// with a bare label. Scoped to the items the render actually consumes:
	// hidden tracks and overlay/text lanes never reach ffmpeg, so an orphan
	// parked there must not block an export that would otherwise succeed.
	const orphans = findOrphanItems([...videoItems, ...audioItems], new Set(assetById.keys()))
	if (orphans.length) {
		const at = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
		const listed = orphans.slice(0, 5)
			.map((i) => `"${i.label || i.id}" on ${trackById.get(i.trackId)?.name || i.trackId} at ${at(i.timelineStart)}`)
			.join(', ')
		const more = orphans.length > 5 ? `, and ${orphans.length - 5} more` : ''
		throw new Error(
			`${orphans.length} clip${orphans.length === 1 ? '' : 's'} reference media that is no longer in ` +
			`the project: ${listed}${more}. Delete them from the timeline, or re-import the media, then export again.`
		)
	}

	const srcFor = (asset: MediaAsset) =>
		quality === 'preview' ? (asset.proxyPath || asset.originalPath) : asset.originalPath

	// Normalization target: derived from the VIDEO assets in use (audio assets
	// carry no picture). Defaults keep an audio-only export at a sane 720p.
	const usedVideoAssets = [...new Set(videoItems.map((i) => i.sourceAssetId))]
		.map((id) => assetById.get(id))
		.filter((a): a is MediaAsset => !!a)
	const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2)
	const largest = usedVideoAssets.reduce((best, a) => {
		const area = (a.metadata?.width || 0) * (a.metadata?.height || 0)
		return area > best.area ? { area, w: a.metadata!.width, h: a.metadata!.height } : best
	}, { area: 0, w: 1280, h: 720 })
	const width = even(largest.w)
	const height = even(largest.h)
	const fps = Math.min(60, Math.max(10,
		usedVideoAssets.reduce((max, a) => Math.max(max, a.metadata?.fps || 0), 0) || 30
	))

	const allItems = [...videoItems, ...audioItems]
	const end = allItems.reduce((max, it) => Math.max(max, itemEnd(it)), 0)

	// ---- Transition windows ----
	// Resolved BEFORE the cut set, because a window suppresses the cuts inside it.
	const sourceDurations = sourceDurationsFrom(doc.media)
	const windows = planTransitions(videoItems, sourceDurations)
		.flatMap((seam) => (seam.window ? [seam.window] : []))
	validateWindows(windows, end, trackById)

	// ---- Boundary set ----
	// Every video- and audio-item edge, clamped to [0, end], plus each window's
	// own edges. Priority decides which survives when two land within SNAP_EPS:
	// a sequence bound outranks a window edge, which outranks an item edge.
	type Cut = { t: number; rank: 0 | 1 | 2 }  // 0 = bound, 1 = window, 2 = item
	const raw: Cut[] = [{ t: 0, rank: 0 }, { t: end, rank: 0 }]
	for (const it of allItems) {
		raw.push({ t: Math.min(Math.max(it.timelineStart, 0), end), rank: 2 })
		raw.push({ t: Math.min(Math.max(itemEnd(it), 0), end), rank: 2 })
	}
	for (const w of windows) {
		raw.push({ t: w.start, rank: 1 }, { t: w.end, rank: 1 })
	}
	raw.sort((a, b) => a.t - b.t || a.rank - b.rank)

	// Collapse each run of near-coincident cuts to its highest-priority member.
	// This is what keeps total duration exact: a boundary moves by < SNAP_EPS in
	// the PLAN only (the document is untouched), instead of a sliver of the
	// timeline being deleted. It rides on slack `covers()` already allows.
	const collapsed: Cut[] = []
	for (const cut of raw) {
		const last = collapsed[collapsed.length - 1]
		if (last && cut.t - last.t < SNAP_EPS) {
			if (cut.rank === 1 && last.rank === 1 && Math.abs(cut.t - last.t) > TIME_EPS) {
				throw new Error('Two transition windows are too close together to render separately.')
			}
			if (cut.rank < last.rank) collapsed[collapsed.length - 1] = cut
			continue
		}
		collapsed.push(cut)
	}

	// Suppress every cut strictly inside a window — an xfade cannot start
	// mid-ramp, so the window has to be one atomic region. Unambiguous after the
	// collapse: an item edge within SNAP_EPS of a window edge has already BECOME
	// that window edge.
	const points = collapsed
		.filter((c) => !windows.some((w) => c.t > w.start + TIME_EPS && c.t < w.end - TIME_EPS))
		.map((c) => c.t)

	// A video item's own audio contributes when unmuted and the source has audio.
	const videoAudioActive = (item: TimelineItem, asset: MediaAsset) =>
		!item.muted && !trackById.get(item.trackId)?.muted && asset.metadata?.hasAudio !== false
	// An audio-track item contributes when neither it nor its track is muted.
	const audioItemActive = (item: TimelineItem) =>
		!item.muted && !audioTrackById.get(item.trackId)?.muted

	const intersects = (item: TimelineItem, t0: number, t1: number) =>
		item.timelineStart < t1 - TIME_EPS && itemEnd(item) > t0 + TIME_EPS

	/**
	 * The item's content clipped to [t0,t1). On a transition-free timeline this is
	 * IDENTICAL to the old covering-item slice — regions are cut at every item
	 * edge, so an intersecting item always spans the whole cell and offset is 0.
	 * It is a strict generalisation, needed only because a window's edges are not
	 * item edges.
	 */
	const toSlice = (item: TimelineItem, t0: number, t1: number): SourceSlice => {
		const asset = assetById.get(item.sourceAssetId)
		if (!asset) throw new Error(`Missing media asset for clip "${item.label || item.id}".`)
		const s = Math.max(t0, item.timelineStart)
		const e = Math.min(t1, itemEnd(item))
		const { in: sIn, out: sOut } = sliceSource(item, s, e)
		return {
			srcPath: srcFor(asset), in: sIn, out: sOut,
			offset: s - t0, duration: e - s, freezeHead: 0, freezeTail: 0,
			item, track: trackById.get(item.trackId)!
		}
	}

	/** One side of a transition, extended into its handle and frozen past it. */
	const toTransitionSlice = (
		side: TransitionWindow['outgoing'], duration: number
	): SourceSlice => {
		const item = side.item
		const asset = assetById.get(item.sourceAssetId)
		if (!asset) throw new Error(`Missing media asset for clip "${item.label || item.id}".`)
		const speed = item.speed || 1
		const slice: SourceSlice = {
			srcPath: srcFor(asset), in: side.in, out: side.out,
			offset: 0, duration,
			freezeHead: side.freeze && side.in <= item.in + TIME_EPS ? side.freeze : 0,
			freezeTail: side.freeze && side.out >= item.out - TIME_EPS ? side.freeze : 0,
			item, track: trackById.get(item.trackId)!
		}
		// The freeze convention is easy to invert silently, so pin it with the one
		// identity that only closes when each side is padded at the correct end.
		const covered = slice.freezeHead + (slice.out - slice.in) / speed + slice.freezeTail
		if (Math.abs(covered - duration) > TIME_EPS) {
			throw new Error(
				`Transition slice for "${item.label || item.id}" covers ${covered.toFixed(3)}s ` +
				`of a ${duration.toFixed(3)}s window.`
			)
		}
		return slice
	}

	const regions: Region[] = []
	for (let i = 0; i < points.length - 1; i++) {
		const t0 = points[i]
		const t1 = points[i + 1]
		const duration = t1 - t0
		// After the collapse this is an invariant, not a filter. It used to be
		// `continue`, which silently deleted a legally-trimmed sub-50ms clip.
		if (duration <= TIME_EPS) {
			throw new Error(`Region plan produced a zero-length span at ${t0.toFixed(3)}s.`)
		}

		const window = windows.find(
			(w) => Math.abs(w.start - t0) < TIME_EPS && Math.abs(w.end - t1) < TIME_EPS
		)

		// ---- Audio-track bystanders: shared by both region kinds ----
		const audioSources: SourceSlice[] = []
		const addTrackAudio = () => {
			for (const aItem of audioItems) {
				if (!intersects(aItem, t0, t1) || !audioItemActive(aItem)) continue
				// No missing-asset check here: the pre-flight above already threw.
				// Silently skipping would drop audio from the export without a word.
				audioSources.push(toSlice(aItem, t0, t1))
			}
		}

		if (window) {
			// Any OTHER video track crossing the window would have to composite with
			// the blend, which nothing renders yet. Throw rather than quietly drop it.
			for (const track of videoTracks) {
				if (track.id === window.trackId) continue
				const clash = videoItems.find((it) => it.trackId === track.id && intersects(it, t0, t1))
				if (clash) {
					throw new Error(
						`Clip "${clash.label || clash.id}" on track "${track.name}" overlaps a transition. ` +
						'Move it clear of the transition, or remove the transition, then export again.'
					)
				}
			}
			addTrackAudio()
			const fromAsset = assetById.get(window.outgoing.item.sourceAssetId)!
			const toAsset = assetById.get(window.incoming.item.sourceAssetId)!
			regions.push({
				kind: 'overlap',
				duration,
				transition: { kind: window.kind, duration: window.duration },
				from: toTransitionSlice(window.outgoing, duration),
				to: toTransitionSlice(window.incoming, duration),
				cutAt: window.cut - t0,
				fromAudioActive: videoAudioActive(window.outgoing.item, fromAsset),
				toAudioActive: videoAudioActive(window.incoming.item, toAsset),
				audioSources
			})
			continue
		}

		// ---- Video: covering item per video track, top-most first ----
		const videoLayers: SourceSlice[] = []
		for (const track of videoTracks) {
			const hits = videoItems.filter((it) => it.trackId === track.id && intersects(it, t0, t1))
			if (hits.length > 1) {
				// Illegal in the document model (repairOverlaps guarantees it), and the
				// old `.find()` silently rendered the first and discarded the rest.
				throw new Error(
					`Clips "${hits[0].label || hits[0].id}" and "${hits[1].label || hits[1].id}" ` +
					`overlap on track "${track.name}".`
				)
			}
			if (!hits.length) continue
			const slice = toSlice(hits[0], t0, t1)
			if (slice.offset > TIME_EPS || slice.duration < duration - TIME_EPS) {
				// Video has no region-local placement in renderRegion (a late start
				// needs black padding), so enforce the invariant rather than mis-render.
				throw new Error(`Clip "${hits[0].label || hits[0].id}" only partly covers its region.`)
			}
			videoLayers.push(slice)
		}

		// ---- Audio: each video layer's own audio + covering audio-track items ----
		for (const layer of videoLayers) {
			const asset = assetById.get(layer.item.sourceAssetId)!
			if (videoAudioActive(layer.item, asset)) audioSources.push(toSlice(layer.item, t0, t1))
		}
		addTrackAudio()

		regions.push({ kind: 'cut', duration, videoLayers, audioSources })
	}

	// Nothing downstream checks export length — concat just stitches whatever it
	// is given — so a slip in the window arithmetic would ship as a silently
	// wrong-length file. One reduce is the whole defence.
	const total = regions.reduce((sum, r) => sum + r.duration, 0)
	if (Math.abs(total - end) > TIME_EPS) {
		throw new Error(
			`Region plan covers ${total.toFixed(3)}s of a ${end.toFixed(3)}s timeline.`
		)
	}

	return {
		regions, width, height, fps,
		duration: end,
		hasOverlap: regions.some((r) => r.kind === 'overlap')
	}
}

/**
 * Windows come from a pure module that cannot see the document, so the walker
 * checks the properties it depends on rather than trusting them.
 */
function validateWindows(
	windows: TransitionWindow[],
	end: number,
	trackById: Map<string, Track>
): void {
	const sorted = [...windows].sort((a, b) => a.start - b.start)
	for (let i = 0; i < sorted.length; i++) {
		const w = sorted[i]
		const name = trackById.get(w.trackId)?.name || w.trackId
		if (w.start < -TIME_EPS || w.end > end + TIME_EPS) {
			throw new Error(`A transition on track "${name}" runs outside the timeline.`)
		}
		if (w.duration <= SNAP_EPS) {
			throw new Error(`A transition on track "${name}" is too short to render.`)
		}
		if (w.start < w.outgoing.item.timelineStart - TIME_EPS || w.end > itemEnd(w.incoming.item) + TIME_EPS) {
			throw new Error(`A transition on track "${name}" runs past the clips it joins.`)
		}
		const next = sorted[i + 1]
		if (next && next.start < w.end - TIME_EPS) {
			throw new Error(`Two transitions on track "${name}" overlap each other.`)
		}
	}
}

// ===== Fast path =====

export function isFastPathEligible(items: TimelineItem[], track: Track, hasAudioItems = false): boolean {
	if (items.length === 0) return false
	if (hasAudioItems) return false // audio-track items need the mixing region path
	if (track.muted || track.hidden) return false // assembleVideo can't drop audio
	const srcId = items[0].sourceAssetId
	if (!items.every((i) => i.sourceAssetId === srcId)) return false
	if (!items.every((i) => (i.speed ?? 1) === 1)) return false // no setpts in assembleVideo
	if (items.some((i) => i.muted)) return false
	// Any audio adjustment needs the builder chain (no volume/afade in assembleVideo).
	if ((track.gain ?? 1) !== 1) return false
	if (!items.every((i) => (i.gain ?? 1) === 1)) return false
	if (items.some((i) => (i.fadeInSec ?? 0) > 0 || (i.fadeOutSec ?? 0) > 0)) return false
	// A butt-joined single-source timeline is EXACTLY what a beginner applies a
	// transition to, and assembleVideo has no blend — without this it exports hard
	// cuts with no error and no log. Deliberately checks the raw annotation rather
	// than resolving the window: declining the fast path costs a re-encode, and
	// resolving here would be a second place the geometry could disagree.
	if (items.some((i) => i.transition?.in || i.transition?.out)) return false
	if (Math.abs(items[0].timelineStart) > SNAP_EPS) return false // leading gap needs black
	for (let i = 1; i < items.length; i++) {
		if (Math.abs(items[i].timelineStart - itemEnd(items[i - 1])) > SNAP_EPS) return false
	}
	return true
}

// ===== ffmpeg building blocks =====

const vnorm = (w: number, h: number, fps: number) =>
	`scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
	`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p`

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

/**
 * Renders ONE region to a uniform intermediate: the top video layer (or black)
 * plus the region's mixed audio. 0 audio sources → silence; 1 → that stream;
 * k>1 → amix (normalize=0, gains already applied) so overlapping audio-track
 * items and a video's own soundtrack mix correctly and stay region-length
 * (§5.9). Per-stream chains are composed from the ORDERED builder registries
 * in renderBuilders.ts — new adjustments plug in there, not here.
 */
async function renderRegion(
	region: Region,
	index: number,
	plan: RegionPlan,
	workDir: string,
	signal: AbortSignal,
	onProgress: (percent: number) => void
): Promise<string> {
	const duration = region.duration
	const dur = duration.toFixed(3)
	const outputPath = path.join(workDir, `region-${String(index).padStart(3, '0')}.mp4`)

	const command = ffmpeg()
	const filters: string[] = []
	let inputIdx = 0
	const ctxFor = (slice: SourceSlice): BuildCtx => ({ slice, plan })

	if (region.kind === 'overlap') {
		// Item 2 of the roadmap replaces this with the xfade / acrossfade graph.
		// Until then the plan can EXPRESS a transition that the renderer cannot
		// draw, and the only acceptable behaviour is to stop.
		throw new Error('This build cannot render transitions yet.')
	}

	// ---- Video: top layer's slice, or black of exactly `duration`.
	// videoLayers[1..n] are the compositing seam (PiP/overlay, deferred). ----
	const topLayer = region.videoLayers[0]
	if (topLayer) {
		const cut = (topLayer.out - topLayer.in).toFixed(3)
		command.input(topLayer.srcPath).inputOptions(['-ss', topLayer.in.toFixed(3), '-t', cut])
		const chain = [...buildChain(videoBuilders, ctxFor(topLayer)), vnorm(plan.width, plan.height, plan.fps)]
		filters.push(`[${inputIdx++}:v]${chain.join(',')}[v]`)
	} else {
		command.input(`color=black:size=${plan.width}x${plan.height}:rate=${plan.fps}`)
			.inputFormat('lavfi').inputOptions(['-t', dur])
		filters.push(`[${inputIdx++}:v]setsar=1,format=yuv420p[v]`)
	}

	// ---- Audio: silence, single stream, or amix of k streams ----
	let audioLabel = '[a]'
	if (region.audioSources.length === 0) {
		command.input('anullsrc=r=48000:cl=stereo').inputFormat('lavfi').inputOptions(['-t', dur])
		filters.push(`[${inputIdx++}:a]atrim=0:${dur},asetpts=PTS-STARTPTS[a]`)
	} else {
		const labels: string[] = []
		region.audioSources.forEach((a, k) => {
			const cut = (a.out - a.in).toFixed(3)
			command.input(a.srcPath).inputOptions(['-ss', a.in.toFixed(3), '-t', cut])
			const label = `[a${k}]`
			// Head: PTS reset. Builders: speed → gain → fade → effects. Tail:
			// conform + apad + atrim pin every stream to EXACTLY the region
			// duration so amix aligns them and the intermediate stays A/V
			// frame-aligned for concat.
			const chain = [
				'asetpts=PTS-STARTPTS',
				...buildChain(audioBuilders, ctxFor(a)),
				'aresample=48000',
				`aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${dur},atrim=0:${dur}`
			]
			filters.push(`[${inputIdx++}:a]${chain.join(',')}${label}`)
			labels.push(label)
		})
		if (labels.length === 1) {
			audioLabel = labels[0]
		} else {
			filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0[a]`)
		}
	}

	command
		.complexFilter(filters.join(';'))
		.map('[v]')
		.map(audioLabel)
		.outputOptions([...intermediateOpts(), '-t', dur])

	await runCommand(command, outputPath, signal, onProgress)
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

export function startEditorRender(options: {
	threadId: string
	quality: ExportQuality
	/**
	 * In-memory timeline snapshot (serialized over IPC). When present, the
	 * render works ENTIRELY off this object — the live document can keep
	 * changing, revisions can switch, another project can load; nothing here
	 * is persisted. Falls back to the persisted thread doc when absent.
	 */
	doc?: EditorDocument
}): { renderId: string } {
	const { threadId, quality } = options
	const thread = threadManager.getThread(threadId)
	if (!thread || thread.type !== 'editor' || !thread.editor) {
		throw new Error('Not an editor project')
	}
	const doc = options.doc ?? thread.editor

	// ---- Pre-flight (synchronous — a bad timeline rejects the invoke
	// immediately instead of producing a ghost render) ----
	const plan = computeRegions(doc, quality)
	// `allSlices` is exhaustive over region kinds, so a slice can never escape this
	// check by living in a field the pre-flight forgot — which would turn a clean
	// synchronous rejection into a failure halfway through a long render.
	const srcPaths = [...new Set(plan.regions.flatMap(allSlices).map((s) => s.srcPath))]
	const missing = srcPaths.filter((p) => !fs.existsSync(p))
	if (missing.length > 0) {
		throw new Error(`Missing source file(s): ${missing.map((p) => path.basename(p)).join(', ')}`)
	}
	// Reject up front rather than mid-render: the plan can describe a transition
	// that renderRegion cannot draw until roadmap item 2 lands.
	if (plan.hasOverlap) {
		throw new Error(
			'This timeline uses transitions, which this build cannot export yet. ' +
			'Remove the transition, or export again after updating.'
		)
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
				.filter((t) => t.kind === 'video' && !t.hidden)
				.sort((a, b) => a.order - b.order)[0] || null
			const items = videoTrack
				? doc.timeline
					.filter((i) => i.trackId === videoTrack.id)
					.sort((a, b) => a.timelineStart - b.timelineStart)
				: []
			const audioTrackIds = new Set(
				doc.tracks.filter((t) => t.kind === 'audio' && !t.hidden).map((t) => t.id)
			)
			const hasAudioItems = doc.timeline.some((i) => audioTrackIds.has(i.trackId))
			// Items on a SECOND video track need the region path (layering).
			const videoTrackIds = new Set(
				doc.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id)
			)
			const hasOtherVideoItems = doc.timeline.some(
				(i) => videoTrackIds.has(i.trackId) && i.trackId !== videoTrack?.id
			)

			// `!plan.hasOverlap` reads the walker's OWN output, so a future source of
			// transitions the predicate does not know about still cannot slip through.
			if (videoTrack && !hasOtherVideoItems && !plan.hasOverlap
				&& isFastPathEligible(items, videoTrack, hasAudioItems)) {
				// ---- Fast path: single-source trim+concat via assembleVideo ----
				// computeRegions' orphan pre-flight already ran, so this resolves —
				// but assert rather than `!`, so a future reordering fails loudly.
				const asset = doc.media.find((a) => a.id === items[0].sourceAssetId)
				if (!asset) throw new Error(`Missing media asset for clip "${items[0].label || items[0].id}".`)
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
					const file = await renderRegion(region, i, plan, workDir, signal, onRegionProgress)
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
