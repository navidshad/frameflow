/**
 * A motion layer that follows a track.
 *
 * The layer names a track and the footage clip it is following it in
 * (`TimelineItem.follow`). Nothing is copied onto the layer: where the thing is
 * at each instant is worked out when the layer is drawn, from the track (source
 * seconds, fractions of the source picture) through the clip as it is NOW (its
 * place on the timeline, its speed, how it is framed and moved). Trim the clip,
 * slide it, retime it, and the layer still lands on the thing.
 *
 * It reaches the page as ordinary keyframes. `withFollows` hands the monitor
 * and the export the same items with keys added for the settings the page
 * defines, so both draw from one description, the way every other keyframe
 * already does:
 *
 *   x, y    the centre, as fractions of the frame (0–1 from the top-left)
 *   w, h    the box, as fractions of the frame's width and height
 *   size    half the box's longer side, as a fraction of the frame's SHORT side
 *   on      1 while the thing is tracked, 0 in a gap and outside the track
 *
 * A page takes part by defining any of those as numeric settings with
 * `animate: true`; a setting it does not define is simply not driven.
 */
import type { MediaAsset, TimelineItem } from './types'
import { valueAt, type Keyframe, type KeyframeTracks } from './keyframes'
import { panFraction } from './framing'
import { resolveDefinition } from './motion'
import { clipSourceTime, clipTimelineTime, trackAt, trackSpans, type ObjectTrack, type TrackSample } from './tracking'

/** What a following layer stores. */
export interface TrackFollow {
	trackId: string
	/** The footage the track was measured in. */
	assetId: string
	/** The clip of that footage the layer sits over. */
	clipId: string
}

export const FOLLOW_SETTINGS = ['x', 'y', 'w', 'h', 'size', 'on'] as const
export type FollowSetting = typeof FOLLOW_SETTINGS[number]

interface Size {
	width: number
	height: number
}

interface Box {
	cx: number
	cy: number
	w: number
	h: number
}

type FramedClip = Pick<TimelineItem, 'framing' | 'transform' | 'keyframes'>

/**
 * Where a box in the SOURCE picture lands in the frame, both as fractions.
 *
 * The same two steps the export takes: the conform (letterbox, or fill and
 * crop by `pan`), then the free transform about the frame's centre (scale,
 * rotate clockwise, move), with the position and rotation keyed at `clipSec`
 * seconds into the clip.
 */
export function placeInFrame(box: Box, clip: FramedClip, source: Size, frame: Size, clipSec = 0): Box {
	const W = frame.width, H = frame.height
	const sw = source.width || W, sh = source.height || H
	const fill = clip.framing?.mode === 'fill'
	const k = fill ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh)
	const pw = sw * k, ph = sh * k
	const ox = fill ? -(pw - W) * panFraction(clip.framing?.pan) : (W - pw) / 2
	const oy = fill ? -(ph - H) * panFraction(clip.framing?.pan) : (H - ph) / 2
	let x = ox + box.cx * pw, y = oy + box.cy * ph
	let w = box.w * pw, h = box.h * ph

	const t = clip.transform
	const keys = clip.keyframes
	const scale = Number(t?.scale ?? 1) || 1
	const moveX = valueAt(keys?.['transform.x'], clipSec, Number(t?.x ?? 0) || 0)
	const moveY = valueAt(keys?.['transform.y'], clipSec, Number(t?.y ?? 0) || 0)
	const turn = (valueAt(keys?.['transform.rotation'], clipSec, Number(t?.rotation ?? 0) || 0) * Math.PI) / 180
	if (scale !== 1 || moveX || moveY || turn) {
		const dx = (x - W / 2) * scale, dy = (y - H / 2) * scale
		x = W / 2 + dx * Math.cos(turn) - dy * Math.sin(turn) + moveX * W
		y = H / 2 + dx * Math.sin(turn) + dy * Math.cos(turn) + moveY * H
		w *= scale
		h *= scale
	}
	return { cx: x / W, cy: y / H, w: w / W, h: h / H }
}

/**
 * A detector's box trembles by a pixel or two from frame to frame, which a
 * cover drawn from it would visibly do too. Each sample is averaged with its
 * neighbours (1-2-1), inside an unbroken stretch only: centred, so it does not
 * lag a fast move, and never blending across a gap.
 */
export function steady(samples: readonly TrackSample[], fps: number): TrackSample[] {
	const step = 1 / fps
	return samples.map((s, i) => {
		const a = samples[i - 1], b = samples[i + 1]
		if (!a || !b || s.t - a.t > step * 1.5 || b.t - s.t > step * 1.5) return s
		const mix = (p: number, q: number, r: number) => (p + 2 * q + r) / 4
		return { ...s, cx: mix(a.cx, s.cx, b.cx), cy: mix(a.cy, s.cy, b.cy), w: mix(a.w, s.w, b.w), h: mix(a.h, s.h, b.h) }
	})
}

export interface FollowContext {
	track: Pick<ObjectTrack, 'samples' | 'fps'>
	/** The followed footage clip, as it is on the timeline now. */
	clip: Pick<TimelineItem, 'timelineStart' | 'in' | 'out' | 'speed' | 'duration' | 'framing' | 'transform' | 'keyframes'>
	/** The footage's own picture size. */
	source: Size
	frame: Size
}

/** The settings of the layer's page that a follow can drive. */
export function followable(item: Pick<TimelineItem, 'motion'>): FollowSetting[] {
	if (!item.motion) return []
	const def = resolveDefinition(item.motion)
	return FOLLOW_SETTINGS.filter((key) => def.settings.some((s) => s.key === key && s.type === 'number' && s.animate))
}

const HIDDEN: KeyframeTracks = { 'motion.on': [{ t: 0, value: 0, ease: 'hold' }] }

/**
 * The keys a following layer is drawn with, in the layer's own seconds.
 * One key per tracked frame the layer covers; `on` holds 1 through each
 * unbroken stretch and 0 everywhere else.
 */
export function followKeys(
	item: Pick<TimelineItem, 'motion' | 'timelineStart' | 'duration'>,
	context: FollowContext
): KeyframeTracks {
	const { track, clip, source, frame } = context
	const wanted = followable(item)
	if (!wanted.length) return {}
	const speed = clip.speed || 1
	const stepU = 1 / (track.fps * speed)
	const short = Math.min(frame.width, frame.height)

	// The samples the layer covers, plus one exactly on each of its edges, so
	// the cover is in place on its first frame and its last.
	const fromSrc = clipSourceTime(clip, item.timelineStart)
	const toSrc = clipSourceTime(clip, item.timelineStart + item.duration)
	const smooth = steady(track.samples, track.fps)
	const inside = smooth.filter((s) => s.t > fromSrc + 1e-6 && s.t < toSrc - 1e-6)
	const edge = (t: number) => trackAt({ samples: smooth, fps: track.fps }, t)
	const samples = [edge(fromSrc), ...inside, edge(toSrc)].filter((s): s is TrackSample => !!s)

	const lanes: Record<FollowSetting, Keyframe[]> = { x: [], y: [], w: [], h: [], size: [], on: [] }
	const points: { u: number; t: number }[] = []
	for (const s of samples) {
		const timeline = clipTimelineTime(clip, s.t)
		if (timeline === null) continue
		const u = Math.min(item.duration, Math.max(0, timeline - item.timelineStart))
		const placed = placeInFrame(s, clip, source, frame, timeline - clip.timelineStart)
		points.push({ u, t: s.t })
		lanes.x.push({ t: u, value: placed.cx })
		lanes.y.push({ t: u, value: placed.cy })
		lanes.w.push({ t: u, value: placed.w })
		lanes.h.push({ t: u, value: placed.h })
		lanes.size.push({ t: u, value: Math.max(placed.w * frame.width, placed.h * frame.height) / 2 / short })
	}
	if (!points.length) return wanted.includes('on') ? HIDDEN : {}

	// `on`: off until the first tracked frame, on through each stretch, off one frame after it ends.
	const spans = trackSpans(points.map((p) => ({ t: p.t } as TrackSample)), track.fps)
	if (points[0].u > 1e-6) lanes.on.push({ t: 0, value: 0, ease: 'hold' })
	for (const span of spans) {
		const first = points.find((p) => p.t >= span.from - 1e-6)!
		const last = [...points].reverse().find((p) => p.t <= span.to + 1e-6)!
		lanes.on.push({ t: first.u, value: 1, ease: 'hold' })
		if (last.u + stepU < item.duration - 1e-6) lanes.on.push({ t: last.u + stepU, value: 0, ease: 'hold' })
	}
	const out: KeyframeTracks = {}
	for (const key of wanted) out[`motion.${key}`] = lanes[key]
	return out
}

export interface FollowSources {
	tracks: readonly Pick<ObjectTrack, 'id' | 'samples' | 'fps'>[]
	media: readonly Pick<MediaAsset, 'id' | 'metadata'>[]
	frame: Size
}

/**
 * The item as it should be drawn: a following layer with its follow keys
 * added (over any keys of its own on the same settings), every other item
 * returned as it is. A layer whose track or clip is gone is hidden rather than
 * left sitting wherever its settings put it.
 */
export function withFollow(item: TimelineItem, timeline: readonly TimelineItem[], sources: FollowSources): TimelineItem {
	const follow = item.follow
	if (!follow || !item.motion) return item
	const track = sources.tracks.find((t) => t.id === follow.trackId)
	// The clip it was bound to, while that clip is still under the layer. A clip
	// that was split or replaced has a new id: then the clip of the same footage
	// the layer overlaps most, which is the piece the layer was left over.
	const overlaps = (c: TimelineItem) => c.timelineStart < item.timelineStart + item.duration && c.timelineStart + c.duration > item.timelineStart
	const bound = timeline.find((i) => i.id === follow.clipId && i.sourceAssetId === follow.assetId)
	const clip = bound && overlaps(bound) ? bound : clipToFollow(item, timeline, follow.assetId) ?? bound
	const asset = sources.media.find((a) => a.id === follow.assetId)
	const keys = track && clip
		? followKeys(item, {
			track, clip, frame: sources.frame,
			source: { width: asset?.metadata?.width || sources.frame.width, height: asset?.metadata?.height || sources.frame.height }
		})
		: followable(item).includes('on') ? HIDDEN : {}
	if (!Object.keys(keys).length) return item
	return { ...item, keyframes: { ...(item.keyframes ?? {}), ...keys } }
}

export function withFollows(timeline: readonly TimelineItem[], sources: FollowSources): TimelineItem[] {
	return timeline.map((item) => withFollow(item, timeline, sources))
}

/** Whether anything on the timeline follows a track (so the tracks need loading at all). */
export const hasFollows = (timeline: readonly TimelineItem[]): boolean => timeline.some((i) => !!i.follow && !!i.motion)

/**
 * The clip a new follow should bind to when none is named: the clip of the
 * track's footage that the layer overlaps most.
 */
export function clipToFollow(
	layer: Pick<TimelineItem, 'timelineStart' | 'duration'>, timeline: readonly TimelineItem[], assetId: string
): TimelineItem | null {
	let best: { clip: TimelineItem; overlap: number } | null = null
	for (const clip of timeline) {
		if (clip.sourceAssetId !== assetId || clip.motion) continue
		const overlap = Math.min(layer.timelineStart + layer.duration, clip.timelineStart + clip.duration) - Math.max(layer.timelineStart, clip.timelineStart)
		if (overlap > 0 && (!best || overlap > best.overlap)) best = { clip, overlap }
	}
	return best?.clip ?? null
}
