import path from 'path'
import type { EditorDocument, TimelineItem } from '@shared/types'
import { itemEnd } from '@shared/timeline'
import { isCompositedItem } from '@shared/tracks'
import { snapItemToFrames } from './regionJoin'
import { motionClipLabel, motionFrameCount } from '@shared/motion'
import { motionStatus, unverifiedPage } from '@shared/motionCode'
import type { CutRegion, Region, SourceSlice } from './renderBuilders'
import { allSlices } from './renderBuilders'

/**
 * Motion layers in ONE exact frame, without rendering their whole clips.
 *
 * The exact frame used to render every motion clip it touched in full before
 * drawing anything: the first look at a two-minute layer captured 3,600 page
 * frames, and while a bulk edit had 28 clips re-rendering, `render_frame` sat
 * behind them until the agent's call timed out. Now a layer whose clip is on
 * disk is read from it, and one whose clip is not is drawn by capturing only
 * the few page frames the still reads (`stillFrameRange`) into a short clip.
 * Both are keyed by the layer's recipe, so neither can show an older page.
 *
 * Pure: the capture itself lives in ../motion, which needs Electron.
 */

/**
 * The clip frames a one-frame region reads from a motion slice: a frame either
 * side of what its input seek can land on, clamped to the clip.
 */
export function stillFrameRange(slice: SourceSlice, fps: number): { first: number; last: number } {
	const count = motionFrameCount(slice.item.duration, fps)
	const first = Math.min(count - 1, Math.max(0, Math.floor(slice.in * fps + 1e-6) - 1))
	const last = Math.min(count - 1, Math.max(first, Math.ceil(slice.out * fps - 1e-6) + 1))
	return { first, last }
}

/**
 * The slice re-pointed at a short clip whose frame 0 is the full clip's frame
 * `first`. Everything moves back by the same `first / fps` — the seek, and the
 * item's own `in`/`out` — so every builder that reads `slice.in - item.in`
 * (fades, keyframe offsets) evaluates exactly as it would on the full clip.
 */
export function rebasedSlice(slice: SourceSlice, first: number, fps: number, srcPath: string): SourceSlice {
	const base = first / fps
	return {
		...slice,
		srcPath,
		in: slice.in - base,
		out: slice.out - base,
		item: { ...slice.item, in: slice.item.in - base, out: slice.item.out - base }
	}
}

/** Where the captured frames for one still live, by the clip's own key. */
export function stillClipPath(clipPath: string, range: { first: number; last: number }): string {
	const key = path.basename(clipPath, '.mov')
	return path.join(path.dirname(clipPath), 'stills', `${key}-${range.first}-${range.last}.mov`)
}

/**
 * Every motion layer the frame must show, read from the DOCUMENT rather than
 * from the plan: the motion items on showing video tracks whose (frame-snapped)
 * span covers `timeSec`. The exact frame compares this with what its graph
 * actually draws, so a layer the planner or the instant cut dropped is an error
 * instead of a frame silently missing it.
 */
export function motionItemsAt(doc: Pick<EditorDocument, 'tracks' | 'timeline'>, timeSec: number, fps: number): TimelineItem[] {
	const showing = new Set(doc.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id))
	return doc.timeline
		.filter((i) => !!i.motion && showing.has(i.trackId) && isCompositedItem(i))
		.map((i) => snapItemToFrames(i, fps))
		.filter((i): i is TimelineItem => !!i && timeSec >= i.timelineStart - 1e-6 && timeSec < itemEnd(i) - 1e-6)
}

/** Every distinct motion clip the plan composites, and how many are on disk. */
export function motionClipsReady(regions: Region[], exists: (file: string) => boolean): { ready: number; total: number } {
	const paths = new Set(regions.flatMap(allSlices).filter((s) => !!s.motion).map((s) => s.srcPath))
	let ready = 0
	for (const p of paths) if (exists(p)) ready++
	return { ready, total: paths.size }
}

export interface MotionLayerReport {
	id: string
	label: string
	/** `clip`: read from the rendered clip. `captured`: drawn from the page for this frame alone. */
	drawnFrom: 'clip' | 'captured'
	/**
	 * `checked`: the page drawn has passed every check. `checking`: it passed the
	 * static checks and the editor has not finished drawing it twice yet; if
	 * that fails, the layer will draw nothing. `last-passing`: the working text
	 * fails its checks, so an older version is drawn. `nothing`: no version has
	 * passed, so the layer draws nothing.
	 */
	state: 'checked' | 'checking' | 'last-passing' | 'nothing'
}

export interface MotionFrameReport {
	layers: MotionLayerReport[]
	/** The export's motion clips, across the whole timeline. */
	clips: { ready: number; total: number }
}

export function layerState(item: Pick<TimelineItem, 'motion'>): MotionLayerReport['state'] {
	const status = motionStatus(item.motion)
	if (status.state === 'nothing') return 'nothing'
	if (status.state === 'last-passing') return 'last-passing'
	return unverifiedPage(item.motion) ? 'checking' : 'checked'
}

export function layerReport(slice: SourceSlice, drawnFrom: MotionLayerReport['drawnFrom']): MotionLayerReport {
	return {
		id: slice.item.id,
		label: motionClipLabel(slice.item),
		drawnFrom,
		state: layerState(slice.item)
	}
}

/**
 * What an agent needs to trust the frame, in words. Null when there is no
 * motion anywhere on the timeline.
 */
export function describeMotionReport(report: MotionFrameReport): string | null {
	const lines: string[] = []
	const { layers, clips } = report
	if (layers.length) {
		const names = layers.map((l) => `"${l.label || l.id}"`).join(', ')
		lines.push(`Motion layers in this frame (${layers.length}): ${names}. All are drawn from their current page.`)
		for (const l of layers) {
			const name = `"${l.label || l.id}"`
			if (l.state === 'checking') lines.push(`${name} is still being checked by the editor; if the check fails it will draw nothing. Look again in a few seconds to be sure.`)
			if (l.state === 'last-passing') lines.push(`${name} shows its last version that passed: its current text fails the checks.`)
			if (l.state === 'nothing') lines.push(`${name} draws nothing: no version of its page has passed the checks.`)
		}
	}
	if (clips.total) {
		lines.push(clips.ready === clips.total
			? `Motion clips for export: all ${clips.total} rendered.`
			: `Motion clips for export: ${clips.ready} of ${clips.total} rendered; the export renders the rest. This frame does not wait for them.`)
	}
	return lines.length ? lines.join('\n') : null
}

/** The still region with each motion slice swapped for its stand-in. */
export function withSlices(region: CutRegion, swap: Map<SourceSlice, SourceSlice>): CutRegion {
	return { ...region, videoLayers: region.videoLayers.map((s) => swap.get(s) ?? s) }
}
