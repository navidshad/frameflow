/**
 * The effect catalogue.
 *
 * Effects are DATA, the way `transitionPresets.ts` made transitions data: a
 * kind, its parameters, and a pure function from parameters to an ffmpeg
 * fragment. Nothing here imports ffmpeg or Vue, so the export builder and the
 * monitor read the same definitions and a test can assert the string.
 *
 * The registry is open on purpose — `registerEffects` is how the built-in set
 * gets in, and it is the same door a pack loader will use later. Packs supply
 * data (parameters, a LUT file), never code.
 */

export type EffectStream = 'video' | 'audio'

export type EffectParam =
	| {
		kind: 'number'
		key: string
		label: string
		min: number
		max: number
		step: number
		/** The value at which this parameter changes nothing. */
		default: number
		unit?: string
	}
	| {
		kind: 'choice'
		key: string
		label: string
		options: { value: string; label: string }[]
		default: string
	}

export type EffectParams = Record<string, number | string>

export interface EffectDef {
	kind: string
	label: string
	group: string
	stream: EffectStream
	/** One line, shown under the control. Say what it does, not what it is. */
	description: string
	params: EffectParam[]
	/** An ffmpeg filter fragment, or '' when the settings amount to no change. */
	build(params: EffectParams): string
	/**
	 * A CSS `filter` fragment for the monitor, where one exists.
	 *
	 * These are APPROXIMATIONS and the mismatch is deliberate: ffmpeg's `eq`
	 * brightness is additive while CSS's is multiplicative, so they are matched
	 * at midtone and drift at the extremes. Geometry (framing, transitions,
	 * captions) must match exactly and does; colour is judged by eye, and an
	 * honest approximation now beats no preview at all. The render cache is the
	 * exact answer when colour eventually needs one.
	 */
	css?(params: EffectParams): string
}

// ===== Parameter access =====

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** Read a numeric parameter, falling back to the definition's identity value. */
export function num(params: EffectParams, param: EffectParam): number {
	if (param.kind !== 'number') return 0
	const raw = params[param.key]
	const value = typeof raw === 'number' ? raw : Number(raw)
	if (!Number.isFinite(value)) return param.default
	return clamp(value, param.min, param.max)
}

/** Trim to 4 decimals; ffmpeg does not need more and the strings stay readable. */
const fmt = (n: number) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')

/** The identity settings for an effect — what a freshly added one carries. */
export function defaultParams(def: EffectDef): EffectParams {
	const out: EffectParams = {}
	for (const p of def.params) out[p.key] = p.default
	return out
}

// ===== Definitions =====

const number = (
	key: string, label: string, min: number, max: number, step: number, def: number, unit?: string
): EffectParam => ({ kind: 'number', key, label, min, max, step, default: def, unit })

/**
 * One slider, one idea. `eq` could carry brightness, contrast, saturation and
 * gamma in a single filter, but as separate effects a clip holds only what it
 * needs and the inspector shows a slider per idea rather than a wall of four.
 */
const adjust = (
	kind: string, label: string, description: string, param: EffectParam,
	build: (value: number) => string,
	css?: (value: number) => string
): EffectDef => ({
	kind, label, group: 'Adjust', stream: 'video', description,
	params: [param],
	build: (p) => build(num(p, param)),
	...(css ? { css: (p: EffectParams) => css(num(p, param)) } : {})
})

const ADJUST: EffectDef[] = [
	adjust('exposure', 'Exposure', 'Lifts or drops the whole picture.',
		number('amount', 'Amount', -0.5, 0.5, 0.01, 0),
		(v) => (v === 0 ? '' : `eq=brightness=${fmt(v)}`),
		// Matched at midtone: `eq` ADDS v to a 0.5 pixel, CSS MULTIPLIES it, so
		// the equivalent factor is 1 + 2v. They drift at the extremes on purpose.
		(v) => (v === 0 ? '' : `brightness(${fmt(1 + v * 2)})`)),

	adjust('contrast', 'Contrast', 'Pushes shadows down and highlights up.',
		number('amount', 'Amount', 0, 3, 0.01, 1),
		(v) => (v === 1 ? '' : `eq=contrast=${fmt(v)}`),
		(v) => (v === 1 ? '' : `contrast(${fmt(v)})`)),

	adjust('saturation', 'Saturation', 'How strong the colours are. Zero is black and white.',
		number('amount', 'Amount', 0, 3, 0.01, 1),
		(v) => (v === 1 ? '' : `eq=saturation=${fmt(v)}`),
		(v) => (v === 1 ? '' : `saturate(${fmt(v)})`)),

	// No CSS equivalent exists for gamma, so the monitor shows this one
	// unchanged rather than guessing.
	adjust('gamma', 'Gamma', 'Midtones only — brightens without blowing the highlights.',
		number('amount', 'Amount', 0.3, 3, 0.01, 1),
		(v) => (v === 1 ? '' : `eq=gamma=${fmt(v)}`)),

	adjust('warmth', 'Warmth', 'Cools toward blue or warms toward orange.',
		number('kelvin', 'Temperature', 2000, 12000, 100, 6500, 'K'),
		(v) => (v === 6500 ? '' : `colortemperature=temperature=${fmt(v)}`)),

	adjust('hue', 'Hue', 'Rotates every colour around the wheel.',
		number('degrees', 'Rotation', -180, 180, 1, 0, '\u00b0'),
		(v) => (v === 0 ? '' : `hue=h=${fmt(v)}`),
		(v) => (v === 0 ? '' : `hue-rotate(${fmt(v)}deg)`))
]

/**
 * Looks: one click, no parameters. These are ffmpeg's own curve presets, which
 * cost nothing to ship and are genuinely usable — a `.cube` library on top of
 * them is a pack, not a prerequisite.
 */
const LOOKS: EffectDef[] = [
	['look-vintage', 'Vintage', 'vintage', 'Faded film, lifted blacks.'],
	['look-cross', 'Cross process', 'cross_process', 'Cyan shadows, warm highlights.'],
	['look-punch', 'Punch', 'strong_contrast', 'Hard contrast for small screens.'],
	['look-soft', 'Soft', 'linear_contrast', 'Gentle contrast that keeps detail.'],
	['look-medium', 'Medium', 'medium_contrast', 'A middle-ground contrast bump.'],
	['look-darker', 'Darker', 'darker', 'Drops the whole curve.'],
	['look-lighter', 'Lighter', 'lighter', 'Raises the whole curve.'],
	['look-negative', 'Negative', 'color_negative', 'Inverted film negative.']
].map(([kind, label, preset, description]) => ({
	kind, label, group: 'Looks', stream: 'video' as const, description,
	params: [],
	build: () => `curves=preset=${preset}`
}))

const detail = (
	kind: string, label: string, description: string, param: EffectParam,
	build: (value: number) => string,
	css?: (value: number) => string
): EffectDef => ({
	kind, label, group: 'Detail', stream: 'video', description,
	params: [param],
	build: (p) => build(num(p, param)),
	...(css ? { css: (p: EffectParams) => css(num(p, param)) } : {})
})

const DETAIL: EffectDef[] = [
	// 5x5 is unsharp's default kernel; only the strength is worth exposing.
	detail('sharpen', 'Sharpen', 'Crisps up edges. A little goes a long way.',
		number('amount', 'Amount', 0, 2, 0.05, 0),
		(v) => (v === 0 ? '' : `unsharp=5:5:${fmt(v)}:5:5:0`)),

	detail('vibrance', 'Vibrance', 'Saturation that leaves already-strong colours alone.',
		number('intensity', 'Intensity', -1, 1, 0.02, 0),
		(v) => (v === 0 ? '' : `vibrance=intensity=${fmt(v)}`)),

	detail('blur', 'Blur', 'Softens the picture. Useful behind text.',
		number('radius', 'Radius', 0, 20, 0.5, 0, 'px'),
		(v) => (v === 0 ? '' : `gblur=sigma=${fmt(v)}`),
		(v) => (v === 0 ? '' : `blur(${fmt(v)}px)`))
]

// ===== Registry =====

const registry = new Map<string, EffectDef>()

/**
 * Add definitions to the catalogue. Called once for the built-ins below, and
 * again by the pack loader for anything found on disk.
 *
 * A duplicate kind REPLACES the earlier one, so a pack can override a built-in
 * deliberately — but never silently: the caller gets the list of kinds it
 * displaced.
 */
export function registerEffects(defs: EffectDef[]): string[] {
	const replaced: string[] = []
	for (const def of defs) {
		if (registry.has(def.kind)) replaced.push(def.kind)
		registry.set(def.kind, def)
	}
	return replaced
}

registerEffects([...ADJUST, ...LOOKS, ...DETAIL])

export const allEffects = (): EffectDef[] => [...registry.values()]

export const effectDef = (kind: string): EffectDef | undefined => registry.get(kind)

/** Whether a kind is one this build can actually render — the gate at plan time. */
export const isEffectKind = (kind: string): boolean => registry.has(kind)

/** Catalogue grouped for display, in registration order within each group. */
export function effectGroups(stream?: EffectStream): { group: string; effects: EffectDef[] }[] {
	const groups: { group: string; effects: EffectDef[] }[] = []
	for (const def of registry.values()) {
		if (stream && def.stream !== stream) continue
		const existing = groups.find((g) => g.group === def.group)
		if (existing) existing.effects.push(def)
		else groups.push({ group: def.group, effects: [def] })
	}
	return groups
}

// ===== Resolving a clip's effect list =====

/** What a `TimelineItem` carries: a kind plus its settings. */
export interface AppliedEffect {
	id: string
	kind: string
	params?: EffectParams
}

/**
 * The filter fragments for one clip's effects, in order.
 *
 * An unknown kind is SKIPPED rather than throwing: a project made with a pack
 * installed must still open without it, minus that look.
 */
export function effectChain(effects: AppliedEffect[] | undefined, stream: EffectStream): string[] {
	if (!effects?.length) return []
	const out: string[] = []
	for (const applied of effects) {
		const def = registry.get(applied.kind)
		if (!def || def.stream !== stream) continue
		const fragment = def.build(applied.params ?? {})
		if (fragment) out.push(fragment)
	}
	return out
}

/** The monitor's approximation of the same list, as a CSS `filter` value. */
export function effectCss(effects: AppliedEffect[] | undefined): string {
	if (!effects?.length) return ''
	const parts: string[] = []
	for (const applied of effects) {
		const def = registry.get(applied.kind)
		if (!def || def.stream !== 'video' || !def.css) continue
		const fragment = def.css(applied.params ?? {})
		if (fragment) parts.push(fragment)
	}
	return parts.join(' ')
}

/** True when this clip needs the region path — the fast path applies no filters. */
export const hasRenderableEffects = (effects: AppliedEffect[] | undefined): boolean =>
	effectChain(effects, 'video').length > 0 || effectChain(effects, 'audio').length > 0
