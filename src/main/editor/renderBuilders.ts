import type { ItemFraming, TimelineItem, Track, TransitionRef } from '@shared/types'
import { panFraction } from '@shared/framing'
import { effectChain } from '@shared/effects'
import { duckExpression, type Interval } from '@shared/ducking'
import { transformFilter } from '@shared/transform'
import { keyframeExpression } from '@shared/keyframes'

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
	/**
	 * Region-local seconds at which this slice's content begins. 0 for every
	 * slice on a transition-free timeline, because regions are cut at every item
	 * edge — non-zero only when a transition window swallowed the cut that would
	 * otherwise have started this slice's own region.
	 */
	offset: number
	/**
	 * On-timeline seconds this slice occupies, INCLUDING repeated frames.
	 * Invariants the walker asserts:
	 *   freezeHead + (out - in) / speed + freezeTail === duration
	 *   offset + duration <= region.duration
	 */
	duration: number
	/** Seconds of the FIRST source frame repeated before `in` (incoming side). */
	freezeHead: number
	/** Seconds of the LAST source frame repeated after `out` (outgoing side). */
	freezeTail: number
	item: TimelineItem
	track: Track
}

/**
 * A region is either an ordinary partition cell or a transition window. This is
 * a UNION rather than an optional field on one shape so that every consumer is
 * forced by the compiler to handle the overlap case — an optional field would
 * let `renderRegion` keep compiling while silently ignoring the transition,
 * which is precisely the class of silent wrongness this model exists to prevent.
 */
export type Region = CutRegion | OverlapRegion

export interface CutRegion {
	kind: 'cut'
	duration: number
	/**
	 * Covering video-track items, TOP-most first — [0] is the visible layer.
	 * v1 renders only [0]; the rest are the seam for PiP/overlay compositing
	 * (a future 'transform' builder + overlay graph consume [1..n]).
	 */
	videoLayers: SourceSlice[]
	audioSources: SourceSlice[] // empty → silence of `duration`
}

/**
 * One transition window, rendered atomically — an `xfade` cannot start mid-ramp,
 * so this span must never be split by another cut.
 *
 * Deliberately has NO `videoLayers`: on today's renderer a bystander in
 * `videoLayers[0]` would be drawn INSTEAD of the transition. Leaving the field
 * out makes that state unrepresentable rather than merely unlikely.
 */
export interface OverlapRegion {
	kind: 'overlap'
	duration: number
	transition: TransitionRef
	from: SourceSlice           // outgoing clip, spanning the whole window
	to: SourceSlice             // incoming clip, spanning the whole window
	cutAt: number               // region-local seconds of the original cut (=== front)
	fromAudioActive: boolean    // whether each side's OWN audio joins the crossfade
	toAudioActive: boolean
	/**
	 * Audio-TRACK bystanders only. The pair's own audio is deliberately absent:
	 * it rides on from/to and must be blended with `acrossfade`, never `amix` —
	 * mixing both sides at full level is audible double-talk.
	 */
	audioSources: SourceSlice[]
}

export interface RegionPlan {
	regions: Region[]
	width: number
	height: number
	fps: number
	/** Total timeline seconds; asserted equal to the sum of region durations. */
	duration: number
	/** Derived from the walker's own output, so it cannot drift from it. */
	hasOverlap: boolean
	/** Where speech happens, for the ducking envelope. Absent = no bed to duck. */
	speech?: Interval[]
}

export interface BuildCtx {
	slice: SourceSlice
	plan: { width: number; height: number; fps: number; speech?: Interval[] }
}

/**
 * Every slice a region carries, exhaustive over `kind` so a new region shape or
 * a new slice-bearing field is a COMPILE error rather than a slice that quietly
 * escapes the export pre-flight's missing-file check.
 */
export function allSlices(region: Region): SourceSlice[] {
	switch (region.kind) {
		case 'cut': return [...region.videoLayers, ...region.audioSources]
		case 'overlap': return [region.from, region.to, ...region.audioSources]
	}
	const unreachable: never = region
	return unreachable
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

/**
 * Where a slice's content begins, in seconds from its CLIP's start.
 *
 * Every animated parameter needs this: keyframe times are clip-local, but a
 * filter's `t` starts at zero for the slice it runs on, and a slice does not
 * necessarily begin where its clip does. `fadeA` and the ducking envelope both
 * compute the same number.
 */
export const sliceOffset = (slice: SourceSlice): number =>
	(slice.in - slice.item.in) / (slice.item.speed || 1)

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

/**
 * Per-item visual effects, resolved through the shared catalogue.
 *
 * Order is the user's: the inspector's list top-to-bottom is the filter chain
 * left-to-right, which is what makes "blur then sharpen" differ from the
 * reverse and is the only ordering a person can predict.
 */
const effectsV: FilterBuilder = {
	id: 'effects', stream: 'video',
	build: ({ slice }) => effectChain(slice.item.effects, 'video').join(',')
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
		// Animated gain is the same filter with an expression instead of a
		// number — `volume` has taken one since the fade envelope needed it.
		const curve = keyframeExpression(slice.item.keyframes?.gain, {
			offset: sliceOffset(slice)
		})
		if (curve) {
			// The TRACK's gain still multiplies: the keyframes ride on the item.
			const track = slice.track.gain ?? 1
			const scaled = track === 1 ? `(${curve})` : `(${curve})*${track}`
			return `volume='max(0,${scaled})':eval=frame`
		}
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
	build: ({ slice }) => {
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
		// `slice.duration`, NOT the region's: once a transition window can swallow a
		// cut, a slice may be shorter than the region it sits in, and measuring the
		// ramp against the region would place the fade-out in the wrong place.
		if (fadeOut > 0 && localStart + slice.duration > itemDur - fadeOut) {
			terms.push(`(${fmt(itemDur - localStart)}-t)/${fmt(fadeOut)}`)
		}
		if (terms.length === 0) return '' // slice lies fully outside both ramps
		// Quotes protect the expression's commas from the filtergraph parser.
		const inner = terms.length === 2 ? `min(${terms[0]},${terms[1]})` : terms[0]
		return `volume='max(0,min(1,${inner}))':eval=frame`
	}
}

/**
 * Duck a music bed under speech.
 *
 * Runs on the bed's own slice, in slice-local time, from intervals the walker
 * resolved once for the whole timeline — so the envelope is identical no matter
 * where the region boundaries fall. That is the entire reason this is not
 * `sidechaincompress`.
 */
const duckA: FilterBuilder = {
	id: 'duck', stream: 'audio',
	build: ({ slice, plan }) => {
		if (slice.track.role !== 'music' || !plan.speech?.length) return ''
		const speed = slice.item.speed || 1
		// Where this slice's content sits on the timeline — the same mapping the
		// caption mapper and the fade builder both use.
		const start = slice.item.timelineStart + (slice.in - slice.item.in) / speed
		return duckExpression(plan.speech, { start, duration: slice.duration })
	}
}

/** Per-item audio effects, from the same catalogue. */
const effectsA: FilterBuilder = {
	id: 'effects', stream: 'audio',
	build: ({ slice }) => effectChain(slice.item.effects, 'audio').join(',')
}

// ===== Registries (ORDER MATTERS: retime first, so later fragments run in
// timeline-domain time; gain before fade so the envelope scales the final mix
// level; effects last, just before conform) =====

// Transform is NOT here: it belongs after the conform, in frame space, and
// `videoStream` emits it there. A scale applied in source pixels would simply
// be undone by `vnorm` scaling back to the frame.
export const videoBuilders: FilterBuilder[] = [speedV, effectsV]
export const audioBuilders: FilterBuilder[] = [speedA, gainA, fadeA, duckA, effectsA]

/** Fold a builder list into chain fragments, dropping no-ops. */
export function buildChain(builders: FilterBuilder[], ctx: BuildCtx): string[] {
	return builders.map((b) => b.build(ctx)).filter((f) => f !== '')
}

// ===== Region graph =====
// The filtergraph for one region, built as DATA so it can be asserted in tests
// without ffmpeg in the loop. renderRegion just feeds the result to
// fluent-ffmpeg. Neither of the two slice-placement bugs this replaced could be
// caught while the graph only existed inside an async function that shells out.

const t3 = (n: number) => n.toFixed(3)
const PAD_EPS = 1e-6

export interface GraphInput {
	path: string
	options: string[]
	/** 'lavfi' for synthesised sources (black, silence). */
	format?: string
}

export interface RegionGraph {
	inputs: GraphInput[]
	filters: string[]
	video: string   // filtergraph label carrying the finished picture
	audio: string   // …and the finished mix
}

/**
 * Normalize to the sequence's frame size and rate. `xfade` requires its two
 * inputs to match exactly, so both sides of a transition run this too.
 *
 * Two ways to reconcile a source with a frame of a different shape:
 *
 *   fit  — scale until it fits INSIDE the frame, pad the remainder black.
 *          Nothing is lost; a 16:9 source in a 9:16 frame becomes a strip.
 *   fill — scale until it COVERS the frame, then crop back to it. Nothing is
 *          padded; whatever falls outside is gone, and `pan` chooses which part
 *          survives.
 *
 * The crop offset is written as an ffmpeg expression over `iw`/`ih` — the scaled
 * image, not the source — so this needs no asset metadata. Only one axis has
 * slack after a cover-scale, so the same `pan` drives both orientations: the
 * axis with no slack contributes zero.
 */
export const vnorm = (w: number, h: number, fps: number, framing?: ItemFraming, alpha = false) => {
	// A compositing layer keeps an alpha channel, and letterboxes into
	// TRANSPARENCY rather than black — otherwise a `fit` layer paints black bars
	// over the picture it is supposed to sit on top of.
	const tail = `setsar=1,fps=${fps},format=${alpha ? 'yuva420p' : 'yuv420p'}`
	if (framing?.mode !== 'fill') {
		return `scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
			`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2${alpha ? ':black@0' : ''},${tail}`
	}
	// The fraction of the overflow cut from the near edge — shared with the
	// monitor, which spends the same number as an `object-position`.
	const f = panFraction(framing.pan)
	const off = (i: string, o: string) =>
		f === 0.5 ? `(${i}-${o})/2` : `(${i}-${o})*${fmt(f)}`
	return `scale=${w}:${h}:force_original_aspect_ratio=increase,` +
		`crop=${w}:${h}:${off('iw', 'ow')}:${off('ih', 'oh')},${tail}`
}

/**
 * Pad a video stream at either end. `add` fills with black — the slice starts
 * partway through its region, so the timeline genuinely shows nothing there.
 * `clone` holds the boundary frame, which is the repeated-frame behaviour a
 * transition falls back on when a clip has no handle media left.
 */
function vpad(head: number, tail: number, mode: 'add' | 'clone', alpha = false): string {
	const parts: string[] = []
	// `add` fills with a colour; on a layer that colour has to be transparent,
	// or the seconds before a late layer starts would black out the base.
	const colour = mode === 'add' && alpha ? ':color=black@0' : ''
	if (head > PAD_EPS) parts.push(`start_mode=${mode}${colour}:start_duration=${t3(head)}`)
	if (tail > PAD_EPS) parts.push(`stop_mode=${mode}${colour}:stop_duration=${t3(tail)}`)
	if (!parts.length) return ''
	return `tpad=${parts.join(':')}${mode === 'add' ? ':color=black' : ''}`
}

/** Silence before an audio stream, in whole milliseconds. The tail is covered by
 *  `apad` in the fixed conform step, so only the head needs placing. */
function adelay(seconds: number): string {
	const ms = Math.round(Math.max(0, seconds) * 1000)
	return ms > 0 ? `adelay=${ms}|${ms}` : ''
}

/** One video slice → a labelled stream of exactly `regionDur`. */
function videoStream(
	slice: SourceSlice, plan: RegionPlan, regionDur: number, idx: number, label: string,
	/** A layer composited ON TOP of another, so everything it does not cover
	 *  must end up transparent rather than black. */
	alpha = false
): { input: GraphInput; filter: string } {
	const cut = t3(slice.out - slice.in)
	const chain = [
		...buildChain(videoBuilders, { slice, plan }),
		vnorm(plan.width, plan.height, plan.fps, slice.item.framing, alpha),
		// Frame space starts here: the picture is now exactly plan.width x
		// plan.height, which is the only place a position or a scale means
		// anything.
		transformFilter(slice.item.transform, plan.width, plan.height, alpha, {
			tracks: slice.item.keyframes,
			offset: sliceOffset(slice)
		}),
		// Repeated frames first — they belong to the slice's own content — then
		// black to position that content inside the region.
		vpad(slice.freezeHead, slice.freezeTail, 'clone', alpha),
		vpad(slice.offset, regionDur - slice.offset - slice.duration, 'add', alpha)
	].filter((f) => f !== '')
	return {
		input: { path: slice.srcPath, options: ['-ss', t3(slice.in), '-t', cut] },
		filter: `[${idx}:v]${chain.join(',')}${label}`
	}
}

/** One audio slice → a labelled stream pinned to exactly `regionDur`. */
function audioStream(
	slice: SourceSlice, plan: RegionPlan, regionDur: number, idx: number, label: string
): { input: GraphInput; filter: string } {
	const dur = t3(regionDur)
	const cut = t3(slice.out - slice.in)
	const chain = [
		'asetpts=PTS-STARTPTS',
		...buildChain(audioBuilders, { slice, plan }),
		// AFTER the builders: `fadeA` emits a volume envelope in stream-relative
		// `t`, so delaying upstream would drag the fade ramp along with it.
		// A frozen head is silence, never repeated samples.
		adelay(slice.offset + slice.freezeHead),
		'aresample=48000',
		`aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${dur},atrim=0:${dur}`
	].filter((f) => f !== '')
	return {
		input: { path: slice.srcPath, options: ['-ss', t3(slice.in), '-t', cut] },
		filter: `[${idx}:a]${chain.join(',')}${label}`
	}
}

const silence = (dur: string): GraphInput =>
	({ path: 'anullsrc=r=48000:cl=stereo', options: ['-t', dur], format: 'lavfi' })

/**
 * Build the whole filtergraph for one region.
 *
 * A cut region is the top video layer (or black) plus its mixed audio. An
 * overlap region is the transition: both clips normalized to the same geometry,
 * padded to the full window, then blended — `xfade` for the picture and an
 * equal-power `acrossfade` for the pair's own sound, with any audio-track
 * bystanders mixed on top afterwards.
 */
export function buildRegionGraph(region: Region, plan: RegionPlan): RegionGraph {
	const regionDur = region.duration
	const dur = t3(regionDur)
	const inputs: GraphInput[] = []
	const filters: string[] = []
	const add = (made: { input: GraphInput; filter: string }) => {
		inputs.push(made.input)
		filters.push(made.filter)
	}

	if (region.kind === 'overlap') {
		// ---- Picture: both sides, then the blend ----
		add(videoStream(region.from, plan, regionDur, inputs.length, '[vf]'))
		add(videoStream(region.to, plan, regionDur, inputs.length, '[vt]'))
		// Both inputs are exactly regionDur, so xfade's `in1 + in2 - duration`
		// yields exactly regionDur — the window's length is preserved by
		// construction rather than by trimming afterwards.
		filters.push(
			`[vf][vt]xfade=transition=${region.transition.kind}:duration=${dur}:offset=0[v]`
		)

		// ---- Sound: equal-power crossfade of the pair, then the bystanders ----
		// An inactive side feeds silence rather than taking a different code path,
		// so the audible side still gets its half of the ramp with no level jump.
		const side = (slice: SourceSlice, active: boolean, label: string) => {
			if (active) return add(audioStream(slice, plan, regionDur, inputs.length, label))
			inputs.push(silence(dur))
			filters.push(`[${inputs.length - 1}:a]atrim=0:${dur},asetpts=PTS-STARTPTS${label}`)
		}
		side(region.from, region.fromAudioActive, '[af]')
		side(region.to, region.toAudioActive, '[at]')
		// NEVER amix the pair: both at full level through the window is audible
		// double-talk. Equal power keeps the blend's loudness flat.
		filters.push(`[af][at]acrossfade=d=${dur}:c1=qsin:c2=qsin[apair]`)

		const beds = region.audioSources.map((slice, k) => {
			add(audioStream(slice, plan, regionDur, inputs.length, `[ab${k}]`))
			return `[ab${k}]`
		})
		const audio = beds.length
			? (filters.push(`[apair]${beds.join('')}amix=inputs=${beds.length + 1}:normalize=0[a]`), '[a]')
			: '[apair]'
		return { inputs, filters, video: '[v]', audio }
	}

	// ---- Video: every covering layer, composited bottom-up, or black ----
	// videoLayers is TOP-most first, so the base is the LAST one. A single layer
	// takes the same path it always did: opaque, no overlay, byte-identical.
	if (region.videoLayers.length) {
		const bottomUp = [...region.videoLayers].reverse()
		add(videoStream(bottomUp[0], plan, regionDur, inputs.length, bottomUp.length > 1 ? '[vl0]' : '[v]'))
		let below = '[vl0]'
		for (let k = 1; k < bottomUp.length; k++) {
			const layer = `[vl${k}]`
			add(videoStream(bottomUp[k], plan, regionDur, inputs.length, layer, true))
			const out = k === bottomUp.length - 1 ? '[v]' : `[vc${k}]`
			// The layer is already frame-sized with everything it does not cover
			// transparent, so it lands at the origin; `shortest=0` keeps the
			// composite as long as the base, which IS the region.
			filters.push(`${below}${layer}overlay=0:0:shortest=0:format=auto${out}`)
			below = out
		}
	} else {
		inputs.push({
			path: `color=black:size=${plan.width}x${plan.height}:rate=${plan.fps}`,
			options: ['-t', dur], format: 'lavfi'
		})
		filters.push(`[${inputs.length - 1}:v]setsar=1,format=yuv420p[v]`)
	}

	// ---- Audio: silence, single stream, or amix of k streams ----
	if (region.audioSources.length === 0) {
		inputs.push(silence(dur))
		filters.push(`[${inputs.length - 1}:a]atrim=0:${dur},asetpts=PTS-STARTPTS[a]`)
		return { inputs, filters, video: '[v]', audio: '[a]' }
	}
	const labels = region.audioSources.map((slice, k) => {
		add(audioStream(slice, plan, regionDur, inputs.length, `[a${k}]`))
		return `[a${k}]`
	})
	if (labels.length === 1) return { inputs, filters, video: '[v]', audio: labels[0] }
	filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0[a]`)
	return { inputs, filters, video: '[v]', audio: '[a]' }
}
