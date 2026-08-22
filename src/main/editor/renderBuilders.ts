import type { TimelineItem, Track } from '@shared/types'

/**
 * Handler-based filter builders (PRD §7 — "Render engine is handler-based").
 *
 * A region's per-stream filter chain is composed by folding an ORDERED list of
 * builders between a fixed head (input trim / PTS reset) and a fixed tail
 * (normalization / conform+pad). Each builder inspects the full TimelineItem +
 * Track carried on the slice and returns a filter fragment ('' = no-op), so a
 * future adjustment (transform, effects, transitions, track EQ, …) lands by
 * REGISTERING a builder here — the region walker in render.ts never changes.
 */

// ===== Region model =====
// A slice maps one item's source range onto a sub-region of the timeline. It
// carries the originating item + track so builders can read every adjustment
// field (speed, gain, fades, effects, …) instead of copies going stale.

export interface SourceSlice {
	srcPath: string
	in: number                  // source seconds mapped to this region
	out: number
	item: TimelineItem
	track: Track
}

export interface Region {
	duration: number
	/**
	 * Covering video-track items, TOP-most first — [0] is the visible layer.
	 * v1 renders only [0]; the rest are the seam for PiP/overlay compositing
	 * (a future 'transform' builder + overlay graph consume [1..n]).
	 */
	videoLayers: SourceSlice[]
	audioSources: SourceSlice[] // empty → silence of `duration`
}

export interface RegionPlan {
	regions: Region[]
	width: number
	height: number
	fps: number
}

export interface BuildCtx {
	slice: SourceSlice
	regionDur: number
	plan: { width: number; height: number; fps: number }
}

export interface FilterBuilder {
	id: string
	stream: 'video' | 'audio'
	/** Returns a filter fragment for the chain, or '' to contribute nothing. */
	build(ctx: BuildCtx): string
}

const fmt = (n: number) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')

/** Chain atempo stages so each stays within ffmpeg's 0.5–2.0 range. */
export function atempoChain(speed: number): string {
	const stages: number[] = []
	let factor = speed
	while (factor > 2) { stages.push(2); factor /= 2 }
	while (factor < 0.5) { stages.push(0.5); factor /= 0.5 }
	stages.push(factor)
	return stages.map((s) => `atempo=${fmt(s)}`).join(',')
}

/** Effective gain = item gain × track gain (PRD §5.9 mix). */
export function effectiveGain(item: TimelineItem, track: Track): number {
	return (item.gain ?? 1) * (track.gain ?? 1)
}

// ===== Video builders =====

/** Retime: PTS reset + constant-speed division (§5.6/§5.9). */
const speedV: FilterBuilder = {
	id: 'speed', stream: 'video',
	build: ({ slice }) => `setpts=(PTS-STARTPTS)/${slice.item.speed || 1}`
}

/** Transform (scale/position/crop/rotation) — registered no-op until v2. */
const transformV: FilterBuilder = {
	id: 'transform', stream: 'video',
	build: ({ slice }) => {
		void slice.item.transform // seam: emit scale/crop/rotate fragments here
		return ''
	}
}

/** Per-item visual effects — registered no-op; iterate EffectRef[] in v2. */
const effectsV: FilterBuilder = {
	id: 'effects', stream: 'video',
	build: ({ slice }) => {
		void (slice.item.effects ?? []) // seam: resolve each EffectRef to a filter
		return ''
	}
}

// Transitions (xfade/acrossfade) are NOT a per-slice builder: they need region
// OVERLAP, i.e. computeRegions must emit overlap regions carrying both items.
// The builder registry doesn't preclude that — it's a region-walker concern.

// ===== Audio builders =====

/** Retime: atempo (pitch-preserving) or asetrate (pitch follows speed). */
const speedA: FilterBuilder = {
	id: 'speed', stream: 'audio',
	build: ({ slice }) => {
		const speed = slice.item.speed || 1
		if (speed === 1) return ''
		return slice.item.preservePitch !== false
			? atempoChain(speed)
			: `asetrate=48000*${speed}`
	}
}

/** Gain: item × track, applied pre-mix so amix normalize=0 stays correct. */
const gainA: FilterBuilder = {
	id: 'gain', stream: 'audio',
	build: ({ slice }) => {
		const gain = effectiveGain(slice.item, slice.track)
		return gain === 1 ? '' : `volume=${gain}`
	}
}

/**
 * Fade-in/out (afade can't start mid-ramp, and a region may slice an item
 * anywhere inside a fade — so emit a volume ENVELOPE in slice-local time).
 * Fade lengths are item-local ON-TIMELINE seconds; this runs after the speed
 * builder, so `t` is already in timeline domain.
 */
const fadeA: FilterBuilder = {
	id: 'fade', stream: 'audio',
	build: ({ slice, regionDur }) => {
		const item = slice.item
		const fadeIn = Math.max(0, item.fadeInSec ?? 0)
		const fadeOut = Math.max(0, item.fadeOutSec ?? 0)
		if (fadeIn <= 0 && fadeOut <= 0) return ''
		const speed = item.speed || 1
		const itemDur = item.duration
		const localStart = (slice.in - item.in) / speed // slice start in item-local timeline secs
		const terms: string[] = []
		if (fadeIn > 0 && localStart < fadeIn) {
			terms.push(`(t+${fmt(localStart)})/${fmt(fadeIn)}`)
		}
		if (fadeOut > 0 && localStart + regionDur > itemDur - fadeOut) {
			terms.push(`(${fmt(itemDur - localStart)}-t)/${fmt(fadeOut)}`)
		}
		if (terms.length === 0) return '' // slice lies fully outside both ramps
		// Quotes protect the expression's commas from the filtergraph parser.
		const inner = terms.length === 2 ? `min(${terms[0]},${terms[1]})` : terms[0]
		return `volume='max(0,min(1,${inner}))':eval=frame`
	}
}

/** Per-item audio effects — registered no-op; iterate EffectRef[] in v2. */
const effectsA: FilterBuilder = {
	id: 'effects', stream: 'audio',
	build: ({ slice }) => {
		void (slice.item.effects ?? [])
		return ''
	}
}

// ===== Registries (ORDER MATTERS: retime first, so later fragments run in
// timeline-domain time; gain before fade so the envelope scales the final mix
// level; effects last, just before conform) =====

export const videoBuilders: FilterBuilder[] = [speedV, transformV, effectsV]
export const audioBuilders: FilterBuilder[] = [speedA, gainA, fadeA, effectsA]

/** Fold a builder list into chain fragments, dropping no-ops. */
export function buildChain(builders: FilterBuilder[], ctx: BuildCtx): string[] {
	return builders.map((b) => b.build(ctx)).filter((f) => f !== '')
}
