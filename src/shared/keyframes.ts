/**
 * Keyframes: a parameter that changes over the length of a clip.
 *
 * The model is deliberately flat — one list of {time, value} per parameter,
 * keyed by a path like `transform.x` — because that is what both consumers
 * need. The monitor evaluates the list in JavaScript; the export turns the same
 * list into an ffmpeg expression. Same curve, twice, and a test that says so.
 *
 * ## What can actually be animated
 *
 * Not everything ffmpeg can compute, it can compute PER FRAME. Verified against
 * the bundled binary rather than assumed:
 *
 *   crop  x, y     per frame          → position
 *   crop  w, h     init only          → scale cannot go through crop
 *   rotate a       per frame          → rotation
 *   volume         with eval=frame    → level
 *   eq    params   with eval=frame    → colour
 *
 * So `transform.scale` is absent from the animatable set for now, and says so
 * where the UI would otherwise offer it. It needs `zoompan`, which resamples
 * every frame, and that belongs with speed ramps rather than bolted on here.
 */

export type Ease = 'linear' | 'hold' | 'ease'

export interface Keyframe {
	/** Seconds from the START of the clip, on the timeline. */
	t: number
	value: number
	/** How the value travels from THIS keyframe to the next. */
	ease?: Ease
}

/** Keyframe lists by parameter path — `transform.x`, `gain`, `fx.<id>.amount`. */
export type KeyframeTracks = Record<string, Keyframe[]>

/** Parameters this build can genuinely animate. Anything else is refused. */
export const ANIMATABLE = [
	'transform.x',
	'transform.y',
	'transform.rotation',
	'gain'
] as const

export type AnimatablePath = typeof ANIMATABLE[number]

export const isAnimatable = (path: string): path is AnimatablePath =>
	(ANIMATABLE as readonly string[]).includes(path)

const TIME_EPS = 1e-6

/** Sorted by time, with anything unusable dropped. */
export function normalise(track: Keyframe[] | undefined): Keyframe[] {
	if (!track?.length) return []
	return track
		.filter((k) => Number.isFinite(k.t) && Number.isFinite(k.value))
		.map((k) => ({ t: Math.max(0, k.t), value: k.value, ease: k.ease ?? 'linear' }))
		.sort((a, b) => a.t - b.t)
}

/** Smoothstep — the curve people mean when they say "ease". */
const smooth = (u: number) => u * u * (3 - 2 * u)

/**
 * The value at clip-local time `t`.
 *
 * Flat before the first keyframe and after the last, so a single keyframe pins
 * a constant and two keyframes ramp between them — which is what everyone
 * expects and what stops a curve extrapolating off into nonsense.
 */
export function valueAt(track: Keyframe[] | undefined, t: number, fallback = 0): number {
	const keys = normalise(track)
	if (!keys.length) return fallback
	if (t <= keys[0].t) return keys[0].value
	const last = keys[keys.length - 1]
	if (t >= last.t) return last.value

	for (let i = 0; i < keys.length - 1; i++) {
		const a = keys[i]
		const b = keys[i + 1]
		if (t < a.t || t >= b.t) continue
		if (a.ease === 'hold' || b.t - a.t <= TIME_EPS) return a.value
		const u = (t - a.t) / (b.t - a.t)
		return a.value + (b.value - a.value) * (a.ease === 'ease' ? smooth(u) : u)
	}
	return last.value
}

const fmt = (n: number) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')

/**
 * The same curve as an ffmpeg expression.
 *
 * `time` is whatever variable the filter exposes — `t` for `crop` and `volume`.
 * `offset` shifts clip-local time into the filter's frame, exactly as the
 * ducking envelope does: a slice does not necessarily start where its clip does.
 *
 * Returns '' when the track is empty or pins a single constant, so the caller
 * can fall back to a plain number and keep the filter graph readable.
 */
export function keyframeExpression(
	track: Keyframe[] | undefined,
	options: { time?: string; offset?: number } = {}
): string {
	const keys = normalise(track)
	if (keys.length < 2) return ''
	const time = options.time ?? 't'
	const offset = options.offset ?? 0
	// One subtraction here instead of one per segment.
	const T = offset === 0 ? time : `(${time}+${fmt(offset)})`

	// Built from the LAST segment backwards, so each `if` wraps the rest.
	let expression = fmt(keys[keys.length - 1].value)
	for (let i = keys.length - 2; i >= 0; i--) {
		const a = keys[i]
		const b = keys[i + 1]
		let segment: string
		if (a.ease === 'hold' || b.t - a.t <= TIME_EPS) {
			segment = fmt(a.value)
		} else {
			const u = `((${T}-${fmt(a.t)})/${fmt(b.t - a.t)})`
			const curve = a.ease === 'ease' ? `(${u}*${u}*(3-2*${u}))` : u
			segment = `(${fmt(a.value)}+${fmt(b.value - a.value)}*${curve})`
		}
		expression = `if(lt(${T},${fmt(b.t)}),${segment},${expression})`
	}
	// Flat before the first keyframe, matching valueAt.
	return `if(lt(${T},${fmt(keys[0].t)}),${fmt(keys[0].value)},${expression})`
}

/** Whether this clip animates anything at all. */
export function hasKeyframes(tracks: KeyframeTracks | undefined): boolean {
	if (!tracks) return false
	return Object.entries(tracks).some(([path, track]) =>
		isAnimatable(path) && normalise(track).length >= 2
	)
}

/** Value comparison for the undo diff. Writers replace, never mutate. */
export function sameKeyframes(
	a: KeyframeTracks | undefined,
	b: KeyframeTracks | undefined
): boolean {
	if (a === b) return true
	const left = a ?? {}
	const right = b ?? {}
	const paths = new Set([...Object.keys(left), ...Object.keys(right)])
	for (const path of paths) {
		const x = normalise(left[path])
		const y = normalise(right[path])
		if (x.length !== y.length) return false
		for (let i = 0; i < x.length; i++) {
			if (x[i].t !== y[i].t || x[i].value !== y[i].value || x[i].ease !== y[i].ease) return false
		}
	}
	return true
}
