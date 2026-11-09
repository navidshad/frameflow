/**
 * Object tracking: where one thing is in the picture, frame by frame.
 *
 * A track belongs to the FOOTAGE, not to the edit. Its samples are in the
 * source file's own seconds and in fractions of the source picture (0–1), the
 * same bargain the transcript makes: measured once per media file, and every
 * cut, move and retime of a clip made from it reads the same track.
 *
 * Two kinds, because they fail differently:
 *
 *   face    A detector finds every face on every frame, so a face that is
 *           lost (a blur, a turned head, out of frame) is found again by
 *           itself. The hard part is WHO: detections are joined into short
 *           runs by position alone (a "tracklet" never changes person, it just
 *           ends), and the runs are then merged into people by how alike the
 *           faces look.
 *
 *   object  Anything else has no detector. A box given on one frame is
 *           followed from where it last was, so it works only while the thing
 *           stays in view, and the follower itself never says "I lost it":
 *           `objectLost` decides that from its answers.
 *
 * Everything here is arithmetic on boxes and numbers. The models, the frames
 * and the files live in main/tracking.
 */
import type { TimelineItem } from './types'

export type TrackKind = 'face' | 'object'
export type TrackShape = 'box' | 'ellipse'

/** One frame of a track. Positions are fractions of the SOURCE picture. */
export interface TrackSample {
	/** Seconds in the source file. */
	t: number
	/** Centre. */
	cx: number
	cy: number
	w: number
	h: number
	/** How sure the model was, 0–1. 0 on a sample that was filled in. */
	score: number
	/** Not measured: interpolated across a short gap between two measured frames. */
	filled?: boolean
}

export interface ObjectTrack {
	id: string
	assetId: string
	kind: TrackKind
	name: string
	/** The shape a cover or mask drawn from this track should take. */
	shape: TrackShape
	/** Frames a second in the source, as measured from the samples. */
	fps: number
	samples: TrackSample[]
	/** Source seconds that were looked at. A face can be absent from most of it. */
	scannedFrom: number
	scannedTo: number
	/** Objects: why each end stopped where it did. */
	ended?: { backward?: TrackEnd; forward?: TrackEnd }
	createdAt: number
}

/** `lost`: the follower stopped believing it. `range`: it reached the end it was asked to cover. */
export type TrackEnd = 'lost' | 'range'

// ===== Faces: detections → tracklets =====

export interface FaceBox {
	cx: number
	cy: number
	w: number
	h: number
}

interface OpenTracklet {
	id: number
	/** Where the face is expected in the CURRENT frame. */
	px: number
	py: number
	size: number
	lastFrame: number
}

/** A face may be missed for this many frames and still be the same run. */
export const TRACKLET_MAX_MISSES = 2
/** A face may be this far from where it was expected, in face sizes. */
export const TRACKLET_MAX_JUMP = 0.7
/** ...and this much smaller or larger than it was. */
export const TRACKLET_SIZE_RANGE = [0.65, 1.5] as const

/**
 * Joins each frame's faces to the runs already open, by position and size
 * alone. Deliberately strict: when it is not obvious that a face is the one
 * from the frame before, the run ENDS and a new one starts. A broken run costs
 * nothing (the pieces are merged into people afterwards); a run that swaps
 * person halfway would put a cover on the wrong face.
 */
export class TrackletLinker {
	private open: OpenTracklet[] = []
	private nextId = 0
	private frame = 0

	/**
	 * The tracklet id for each face of the next frame, in order. `shift` is how
	 * far the whole picture moved since the frame before (a camera swing), in the
	 * same units as the boxes.
	 */
	step(faces: readonly FaceBox[], shift: { dx: number; dy: number } = { dx: 0, dy: 0 }): number[] {
		for (const t of this.open) { t.px += shift.dx; t.py += shift.dy }
		const pairs: { cost: number; t: number; f: number }[] = []
		this.open.forEach((t, ti) => {
			faces.forEach((face, fi) => {
				const size = Math.max(face.w, face.h)
				const ratio = size / t.size
				const jump = Math.hypot(face.cx - t.px, face.cy - t.py) / Math.max(size, t.size)
				if (jump < TRACKLET_MAX_JUMP && ratio > TRACKLET_SIZE_RANGE[0] && ratio < TRACKLET_SIZE_RANGE[1]) pairs.push({ cost: jump, t: ti, f: fi })
			})
		})
		const ids: number[] = new Array(faces.length).fill(-1)
		const taken = new Set<number>()
		for (const pair of pairs.sort((a, b) => a.cost - b.cost)) {
			if (taken.has(pair.t) || ids[pair.f] !== -1) continue
			taken.add(pair.t)
			const t = this.open[pair.t]
			const face = faces[pair.f]
			ids[pair.f] = t.id
			t.px = face.cx; t.py = face.cy; t.size = Math.max(face.w, face.h); t.lastFrame = this.frame
		}
		faces.forEach((face, fi) => {
			if (ids[fi] !== -1) return
			const t = { id: this.nextId++, px: face.cx, py: face.cy, size: Math.max(face.w, face.h), lastFrame: this.frame }
			this.open.push(t)
			ids[fi] = t.id
		})
		this.open = this.open.filter((t) => this.frame - t.lastFrame <= TRACKLET_MAX_MISSES)
		this.frame++
		return ids
	}
}

// ===== Faces: tracklets → people =====

export interface TrackletLook {
	id: number
	/** The frame numbers it was seen on. Two tracklets that share a frame are two people. */
	frames: readonly number[]
	/** Unit-length face embeddings taken along it. None means it cannot be matched to anyone. */
	embeddings: readonly ArrayLike<number>[]
}

/** How alike two faces must look (cosine, 0–1) to be called the same person. */
export const SAME_PERSON = 0.35

const dot = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
	let s = 0
	for (let i = 0; i < a.length; i++) s += a[i] * b[i]
	return s
}

function meanLook(embeddings: readonly ArrayLike<number>[]): number[] | null {
	if (!embeddings.length) return null
	const mean = new Array<number>(embeddings[0].length).fill(0)
	for (const e of embeddings) for (let i = 0; i < mean.length; i++) mean[i] += e[i]
	const norm = Math.sqrt(dot(mean, mean)) || 1
	return mean.map((v) => v / norm)
}

/**
 * Merges tracklets into people: repeatedly joins the two most alike groups
 * until none are alike enough. Two groups are never joined if any of their
 * tracklets were on screen in the same frame, however alike they look: one
 * person is not in two places.
 *
 * Returns groups of tracklet ids, the person seen longest first.
 */
export function groupPeople(tracklets: readonly TrackletLook[], threshold = SAME_PERSON): number[][] {
	const looks = tracklets.map((t) => meanLook(t.embeddings))
	const frames = tracklets.map((t) => new Set(t.frames))
	let groups = tracklets.map((_, i) => [i])
	const together = (a: number[], b: number[]) =>
		a.some((i) => b.some((j) => { for (const f of frames[i]) if (frames[j].has(f)) return true; return false }))
	const alike = (a: number[], b: number[]): number => {
		let sum = 0, n = 0
		for (const i of a) for (const j of b) {
			if (!looks[i] || !looks[j]) return -1
			sum += dot(looks[i]!, looks[j]!); n++
		}
		return n ? sum / n : -1
	}
	for (;;) {
		let best: { score: number; a: number; b: number } | null = null
		for (let a = 0; a < groups.length; a++) {
			for (let b = a + 1; b < groups.length; b++) {
				if (together(groups[a], groups[b])) continue
				const score = alike(groups[a], groups[b])
				if (score >= threshold && (!best || score > best.score)) best = { score, a, b }
			}
		}
		if (!best) break
		const merged = [...groups[best.a], ...groups[best.b]]
		groups = groups.filter((_, i) => i !== best!.a && i !== best!.b).concat([merged])
	}
	const seen = (g: number[]) => g.reduce((n, i) => n + tracklets[i].frames.length, 0)
	return groups.sort((a, b) => seen(b) - seen(a)).map((g) => g.map((i) => tracklets[i].id))
}

// ===== Objects: when the follower has lost it =====

/** Below this confidence the follower's answer is not believed, whatever its size. */
export const LOST_SCORE = 0.4
/** The box's area may change by at most this factor, up or down, between two believed frames. */
export const LOST_AREA_JUMP = 1.8

/**
 * Whether the object follower has lost what it was following.
 *
 * The follower always answers with a box, right or wrong. `current` is its
 * answer for this frame (size as fractions of the picture, and its confidence
 * 0–1); `previous` is the last answer that was believed.
 *
 * Confidence alone does not separate right from wrong: on real footage correct
 * answers scored 0.5–1.0 and wrong ones 0.3–0.5. What the wrong ones had in
 * common was size: when the object left the picture the box jumped to several
 * times its area and settled on whatever was nearest. Nothing real grows or
 * shrinks that fast between two frames, while a camera pulling back changes the
 * area by a few percent a frame, which stays well inside the limit because
 * `previous` moves along with every believed frame.
 */
export function objectLost(
	current: { w: number; h: number; score: number },
	previous: { w: number; h: number }
): boolean {
	if (current.score < LOST_SCORE) return true
	const before = previous.w * previous.h
	const now = current.w * current.h
	if (!(before > 0) || !(now > 0)) return true
	const change = now / before
	return change > LOST_AREA_JUMP || change < 1 / LOST_AREA_JUMP
}

/** This many lost answers in a row end the track. One bad frame (a blur) does not. */
export const LOST_FRAMES_TO_STOP = 3

// ===== Reading a track =====

/** Frames a second, from the spacing of the measured samples (the median, so gaps do not skew it). */
export function measuredFps(samples: readonly TrackSample[], fallback = 30): number {
	const steps: number[] = []
	for (let i = 1; i < samples.length; i++) {
		const d = samples[i].t - samples[i - 1].t
		if (d > 1e-4) steps.push(d)
	}
	if (!steps.length) return fallback
	steps.sort((a, b) => a - b)
	return Math.round((1 / steps[Math.floor(steps.length / 2)]) * 1000) / 1000
}

/**
 * Fills gaps no longer than `maxGapSec` with samples on a straight line between
 * the frames on either side, one per missing frame. A face lost to two blurred
 * frames in a camera swing is still where the line says it is, near enough for
 * a cover. Longer gaps are left open: the face may have left the picture.
 */
export function fillGaps(samples: readonly TrackSample[], fps: number, maxGapSec = 0.4): TrackSample[] {
	const out: TrackSample[] = []
	const step = 1 / fps
	samples.forEach((s, i) => {
		const prev = samples[i - 1]
		if (prev) {
			const gap = s.t - prev.t
			const missing = Math.round(gap / step) - 1
			if (missing >= 1 && gap <= maxGapSec + 1e-6) {
				for (let k = 1; k <= missing; k++) {
					const u = k / (missing + 1)
					const mix = (a: number, b: number) => a + (b - a) * u
					out.push({ t: mix(prev.t, s.t), cx: mix(prev.cx, s.cx), cy: mix(prev.cy, s.cy), w: mix(prev.w, s.w), h: mix(prev.h, s.h), score: 0, filled: true })
				}
			}
		}
		out.push(s)
	})
	return out
}

export interface TrackSpan {
	from: number
	to: number
}

/** The stretches of source time the track covers without a break. */
export function trackSpans(samples: readonly TrackSample[], fps: number): TrackSpan[] {
	const spans: TrackSpan[] = []
	const step = 1 / fps
	for (const s of samples) {
		const last = spans[spans.length - 1]
		if (last && s.t - last.to <= step * 1.5) last.to = s.t
		else spans.push({ from: s.t, to: s.t })
	}
	return spans
}

/** Where the object is at a source instant, on a line between the samples around it; null in a gap. */
export function trackAt(track: Pick<ObjectTrack, 'samples' | 'fps'>, sourceSec: number): TrackSample | null {
	const { samples } = track
	if (!samples.length) return null
	const step = 1 / track.fps
	let lo = 0, hi = samples.length - 1
	if (sourceSec < samples[0].t - step / 2 || sourceSec > samples[hi].t + step / 2) return null
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1
		if (samples[mid].t <= sourceSec) lo = mid
		else hi = mid
	}
	const a = samples[lo], b = samples[hi]
	if (sourceSec <= a.t || a === b) return a
	if (sourceSec >= b.t) return b
	if (b.t - a.t > step * 1.5) return null
	const u = (sourceSec - a.t) / (b.t - a.t)
	const mix = (x: number, y: number) => x + (y - x) * u
	return { t: sourceSec, cx: mix(a.cx, b.cx), cy: mix(a.cy, b.cy), w: mix(a.w, b.w), h: mix(a.h, b.h), score: Math.min(a.score, b.score), filled: a.filled || b.filled || undefined }
}

/** Every `n`th sample, always keeping the first and last of each unbroken stretch. */
export function thinSamples(samples: readonly TrackSample[], fps: number, everySec: number): TrackSample[] {
	if (everySec <= 1 / fps + 1e-6) return [...samples]
	const out: TrackSample[] = []
	for (const span of trackSpans(samples, fps)) {
		const inSpan = samples.filter((s) => s.t >= span.from - 1e-6 && s.t <= span.to + 1e-6)
		let next = span.from
		inSpan.forEach((s, i) => {
			if (s.t >= next - 1e-6 || i === inSpan.length - 1) {
				out.push(s)
				next = s.t + everySec
			}
		})
	}
	return out
}

// ===== A clip's time and the footage's time =====

type ClipTiming = Pick<TimelineItem, 'timelineStart' | 'in' | 'out' | 'speed' | 'duration'>

/** The source second a clip shows at a timeline second. */
export const clipSourceTime = (clip: ClipTiming, timelineSec: number): number =>
	clip.in + (timelineSec - clip.timelineStart) * (clip.speed || 1)

/** The timeline second at which a clip shows a source second; null when the clip does not include it. */
export function clipTimelineTime(clip: ClipTiming, sourceSec: number): number | null {
	if (sourceSec < clip.in - 1e-6 || sourceSec > clip.out + 1e-6) return null
	return clip.timelineStart + (sourceSec - clip.in) / (clip.speed || 1)
}

/** A track as one clip plays it: the samples inside the clip, with `t` in TIMELINE seconds. */
export function trackOnClip(samples: readonly TrackSample[], clip: ClipTiming): TrackSample[] {
	const out: TrackSample[] = []
	for (const s of samples) {
		const t = clipTimelineTime(clip, s.t)
		if (t !== null) out.push({ ...s, t })
	}
	return out
}
