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
import { clipTimelineTime, type ObjectTrack, type TrackSample } from './tracking'

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
 * cover drawn from it would visibly do too. A sample that is nearly still is
 * averaged with its neighbours (1-2-1), inside an unbroken stretch only. One
 * that is moving is left exactly where it was measured: averaging a fast,
 * curving path pulls it off the face it is meant to be on, and nobody sees a
 * pixel of tremble in a camera swing.
 */
export function steady(samples: readonly TrackSample[], fps: number): TrackSample[] {
	const step = 1 / fps
	return samples.map((s, i) => {
		const a = samples[i - 1], b = samples[i + 1]
		if (!a || !b || s.t - a.t > step * 1.5 || b.t - s.t > step * 1.5) return s
		const moved = Math.max(Math.hypot(s.cx - a.cx, s.cy - a.cy), Math.hypot(b.cx - s.cx, b.cy - s.cy))
		if (moved > STILL * Math.max(s.w, s.h)) return s
		const mix = (p: number, q: number, r: number) => (p + 2 * q + r) / 4
		return { ...s, cx: mix(a.cx, s.cx, b.cx), cy: mix(a.cy, s.cy, b.cy), w: mix(a.w, s.w, b.w), h: mix(a.h, s.h, b.h) }
	})
}

/** Moving less than this much of its own size per frame counts as still. */
const STILL = 0.1
/**
 * How much of a frame's travel the cover grows by. A moving face is smeared
 * along its path for as long as the shutter was open, and the detector reports
 * the middle of the smear; half the travel each way covers a fully open shutter.
 */
export const BLUR_PAD = 1

/**
 * Where the footage's frames land in the export, for one stretch of a clip.
 *
 * The export does not show footage at "the time of each output frame". Each
 * stretch (a region: the span between two cuts on any track) seeks half an
 * output frame before its in-point, takes the first source frame at or after
 * that as its frame zero, and converts the frame rate by rounding every source
 * frame to the nearest output frame. A 25 fps clip in a 30 fps sequence repeats
 * every fifth frame; a cover placed by time alone is up to a whole source frame
 * out on the repeats, which in a camera swing is most of a face.
 *
 * So the export hands over its own stretches, and the cover is keyed frame by
 * frame to the picture actually shown. Checked against a real export: the rule
 * predicts the source frame of every output frame.
 */
export interface ShownSlice {
	clipId: string
	/** Timeline seconds at which this stretch's first output frame plays. */
	start: number
	/** Source seconds the stretch starts and ends at. */
	in: number
	out: number
}

export interface FrameLock {
	/** The sequence's frame rate. */
	fps: number
	slices: readonly ShownSlice[]
}

export interface FollowContext {
	track: Pick<ObjectTrack, 'samples' | 'fps'>
	/** The followed footage clip, as it is on the timeline now. */
	clip: Pick<TimelineItem, 'id' | 'timelineStart' | 'in' | 'out' | 'speed' | 'duration' | 'framing' | 'transform' | 'keyframes'>
	/** The footage's own picture size. */
	source: Size
	frame: Size
	/** The export's own stretches of the clip. Absent in the monitor, which plays the footage itself. */
	lock?: FrameLock
}

/** The settings of the layer's page that a follow can drive. */
export function followable(item: Pick<TimelineItem, 'motion'>): FollowSetting[] {
	if (!item.motion) return []
	const def = resolveDefinition(item.motion)
	return FOLLOW_SETTINGS.filter((key) => def.settings.some((s) => s.key === key && s.type === 'number' && s.animate))
}

const HIDDEN: KeyframeTracks = { 'motion.on': [{ t: 0, value: 0, ease: 'hold' }] }

/** A tracked frame, and the timeline second from which the picture shows it. */
interface Shown {
	sample: TrackSample
	/** Travel since the frame before and to the frame after, in picture fractions (the larger of the two). */
	dx: number
	dy: number
	from: number
	/** When the NEXT source frame takes over: where a stretch of tracking that ends here switches off. */
	until: number
}

/**
 * When each tracked frame is on screen. With the export's stretches, by its
 * frame rule; without them, from the frame's own time until the next frame's,
 * which is how a video element shows it.
 */
function shownFrames(samples: readonly TrackSample[], travel: readonly { dx: number; dy: number }[], context: FollowContext): Shown[] {
	const { track, clip, lock } = context
	const speed = clip.speed || 1
	const period = 1 / track.fps
	const out: Shown[] = []
	if (!lock) {
		samples.forEach((sample, i) => {
			const from = clipTimelineTime(clip, sample.t)
			if (from !== null) out.push({ sample, ...travel[i], from, until: from + period / speed })
		})
		return out
	}
	// Source frames sit on a grid; a frame's number on it is what the export counts in.
	const origin = samples[0]?.t ?? 0
	const number = (t: number) => Math.round((t - origin) / period)
	const outputFrame = (frames: number) => Math.floor((frames * lock.fps) / (track.fps * speed) + 0.5)
	for (const slice of lock.slices) {
		if (slice.clipId !== clip.id) continue
		const lead = Math.min(slice.in, (0.5 / lock.fps) * speed)
		const zero = Math.ceil((slice.in - lead - origin) / period - 1e-6)
		samples.forEach((sample, i) => {
			if (sample.t < slice.in - lead - 1e-6 || sample.t >= slice.out) return
			const k = number(sample.t) - zero
			out.push({
				sample, ...travel[i],
				from: slice.start + outputFrame(k) / lock.fps,
				until: slice.start + outputFrame(k + 1) / lock.fps
			})
		})
	}
	return out.sort((a, b) => a.from - b.from)
}

/**
 * The keys a following layer is drawn with, in the layer's own seconds: the
 * position of each tracked frame, HELD for as long as the picture shows that
 * frame (never slid between two frames: the footage does not slide either).
 * `on` holds 1 through each unbroken stretch and 0 everywhere else.
 */
export function followKeys(
	item: Pick<TimelineItem, 'motion' | 'timelineStart' | 'duration'>,
	context: FollowContext
): KeyframeTracks {
	const { track, clip, source, frame } = context
	const wanted = followable(item)
	if (!wanted.length) return {}
	const short = Math.min(frame.width, frame.height)
	const period = 1 / track.fps

	const samples = steady(track.samples, track.fps)
	// How far the thing travels in one frame, from the raw track: what its smear is as long as.
	const travel = track.samples.map((s, i) => {
		const near = [track.samples[i - 1], track.samples[i + 1]].filter((o) => o && Math.abs(o.t - s.t) < period * 1.5) as TrackSample[]
		return {
			dx: Math.max(0, ...near.map((o) => Math.abs(o.cx - s.cx))),
			dy: Math.max(0, ...near.map((o) => Math.abs(o.cy - s.cy)))
		}
	})
	const end = item.timelineStart + item.duration
	const shown = shownFrames(samples, travel, context).filter((f) => f.until > item.timelineStart + 1e-6 && f.from < end - 1e-6)
	if (!shown.length) return wanted.includes('on') ? HIDDEN : {}

	// A hair before the frame, so the frame that starts exactly there reads its own key.
	const at = (timeline: number) => Math.max(0, timeline - item.timelineStart - 1e-4)
	const lanes: Record<FollowSetting, Keyframe[]> = { x: [], y: [], w: [], h: [], size: [], on: [] }
	const put = (lane: Keyframe[], t: number, value: number) => {
		// Two source frames rounded onto one output frame: the later one is the one shown.
		if (lane.length && Math.abs(lane[lane.length - 1].t - t) < 1e-6) lane[lane.length - 1].value = value
		else lane.push({ t, value, ease: 'hold' })
	}
	let previous: Shown | null = null
	for (const f of shown) {
		const u = at(f.from)
		const grown = { ...f.sample, w: f.sample.w + BLUR_PAD * f.dx, h: f.sample.h + BLUR_PAD * f.dy }
		const placed = placeInFrame(grown, clip, source, frame, f.from - clip.timelineStart)
		put(lanes.x, u, placed.cx)
		put(lanes.y, u, placed.cy)
		put(lanes.w, u, placed.w)
		put(lanes.h, u, placed.h)
		put(lanes.size, u, Math.max(placed.w * frame.width, placed.h * frame.height) / 2 / short)
		// On from this frame; off where the last frame of a stretch hands over to an untracked one.
		const joined = previous && f.sample.t - previous.sample.t < period * 1.5
		if (!joined) {
			if (previous) put(lanes.on, at(previous.until), 0)
			else if (u > 1e-6) put(lanes.on, 0, 0)
			put(lanes.on, u, 1)
		}
		previous = f
	}
	if (previous && previous.until < end - 1e-6) put(lanes.on, at(previous.until), 0)
	const out: KeyframeTracks = {}
	for (const key of wanted) out[`motion.${key}`] = lanes[key]
	return out
}

export interface FollowSources {
	tracks: readonly Pick<ObjectTrack, 'id' | 'samples' | 'fps'>[]
	media: readonly Pick<MediaAsset, 'id' | 'metadata'>[]
	frame: Size
	/** The export's stretches, so covers are keyed to the frames it shows. See `ShownSlice`. */
	lock?: FrameLock
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
			track, clip, frame: sources.frame, lock: sources.lock,
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
