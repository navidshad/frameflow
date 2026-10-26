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

/**
 * The gain ffmpeg's `colortemperature` puts on red, green and blue, from its
 * blackbody fit (libavfilter/vf_colortemperature.c, `kelvin2rgb`). With the
 * filter's defaults (mix 1, no lightness preservation) that gain is all it
 * does to a pixel, so the monitor can copy it exactly.
 */
export function kelvinGains(kelvin: number): [number, number, number] {
	const k = kelvin / 100
	let r: number, g: number
	if (k <= 66) {
		r = 1
		g = 0.39008157876901960784 * Math.log(k) - 0.63184144378862745098
	} else {
		const t = Math.max(k - 60, 0)
		r = 1.29293618606274509804 * Math.pow(t, -0.1332047592)
		g = 1.12989086089529411765 * Math.pow(t, -0.0755148492)
	}
	const b = k >= 66 ? 1 : k <= 19 ? 0 : 0.54320678911019607843 * Math.log(k - 10) - 1.19625408914
	return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)]
}

/**
 * CSS has no colour temperature, but an SVG colour matrix is a per-channel
 * gain, which is exactly what ffmpeg does. `sRGB` interpolation matters: SVG
 * filters work in linear light by default, ffmpeg works on the stored values.
 */
function warmthCss(kelvin: number): string {
	const [r, g, b] = kelvinGains(kelvin).map((v) => Number(v.toFixed(4)))
	const svg = "<svg xmlns='http://www.w3.org/2000/svg'><filter id='w' color-interpolation-filters='sRGB'>" +
		`<feColorMatrix type='matrix' values='${r} 0 0 0 0 0 ${g} 0 0 0 0 0 ${b} 0 0 0 0 0 1 0'/></filter></svg>`
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}#w")`
}

/**
 * `eq=brightness` ADDS the same amount to every pixel: v on the 0..255 luma
 * codes, and the 16..235 luma range spans the whole of RGB, so every channel
 * moves by v * 255 * 255/219 levels (measured against the real filter to within
 * five levels from -0.5 to 0.5, see exposure.test.ts). CSS `brightness()` MULTIPLIES, which
 * brightens highlights far more than shadows and shifts colours (a clip with
 * warmth and +0.07 came out 10 levels too blue in the monitor). An SVG
 * component transfer is the same addition, in the same stored values (`sRGB`).
 */
function exposureCss(v: number): string {
	const shift = Number(((v * 255) / 219).toFixed(4))
	const svg = "<svg xmlns='http://www.w3.org/2000/svg'><filter id='e' color-interpolation-filters='sRGB'><feComponentTransfer>" +
		['R', 'G', 'B'].map((c) => `<feFunc${c} type='linear' slope='1' intercept='${shift}'/>`).join('') +
		'</feComponentTransfer></filter></svg>'
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}#e")`
}

/** The shift `exposureCss` makes, in 0..255 levels: what the monitor adds for an `exposure` amount. */
export function exposureShiftLevels(v: number): number {
	return (v * 255 * 255) / 219
}

const ADJUST: EffectDef[] = [
	adjust('exposure', 'Exposure', 'Lifts or drops the whole picture.',
		number('amount', 'Amount', -0.5, 0.5, 0.01, 0),
		(v) => (v === 0 ? '' : `eq=brightness=${fmt(v)}`),
		(v) => (v === 0 ? '' : exposureCss(v))),

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
		(v) => (v === 6500 ? '' : `colortemperature=temperature=${fmt(v)}`),
		(v) => (v === 6500 ? '' : warmthCss(v))),

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

/**
 * Audio repair. Recorded speech has four common problems and one filter each:
 * a noise floor, rumble under the voice, a level that wanders, and peaks that
 * stick out. Loudness is NOT here — it is a property of the finished mix, not
 * of one clip, and lives as a document setting instead.
 */
const repair = (
	kind: string, label: string, description: string, param: EffectParam,
	build: (value: number) => string
): EffectDef => ({
	kind, label, group: 'Repair', stream: 'audio', description,
	params: [param],
	build: (p) => build(num(p, param))
})

const REPAIR: EffectDef[] = [
	repair('denoise', 'Denoise', 'Pulls out steady background hiss and hum.',
		number('amount', 'Amount', 0, 40, 1, 0, 'dB'),
		(v) => (v === 0 ? '' : `afftdn=nr=${fmt(v)}:nf=-40`)),

	// 80Hz is under the male speaking range and above most handling noise, so
	// the default position of the slider is the one that helps most voices.
	repair('rumble', 'Remove rumble', 'Cuts traffic, aircon and handling noise below the voice.',
		number('hz', 'Below', 0, 300, 5, 0, 'Hz'),
		(v) => (v === 0 ? '' : `highpass=f=${fmt(v)}`)),

	repair('level', 'Even out level', 'Lifts quiet speech toward the loud parts.',
		number('strength', 'Strength', 1, 8, 0.5, 1, '\u00d7'),
		(v) => (v === 1 ? '' : `speechnorm=e=${fmt(v)}:p=0.95`)),

	repair('compress', 'Compress', 'Tames peaks so nothing jumps out.',
		number('ratio', 'Ratio', 1, 12, 0.5, 1, ':1'),
		(v) => (v === 1 ? '' : `acompressor=threshold=0.125:ratio=${fmt(v)}:attack=20:release=250`))
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

registerEffects([...ADJUST, ...LOOKS, ...DETAIL, ...REPAIR])

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
	/** Switched off (compare with and without): skipped everywhere, settings kept. */
	disabled?: boolean
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
		if (applied.disabled) continue
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
		if (applied.disabled) continue
		const def = registry.get(applied.kind)
		if (!def || def.stream !== 'video' || !def.css) continue
		const fragment = def.css(applied.params ?? {})
		if (fragment) parts.push(fragment)
	}
	return parts.join(' ')
}

/**
 * How honestly the monitor can show this effect.
 *
 * DERIVED from whether a CSS approximation exists, never hand-listed — a
 * curated list of "what previews" is exactly the bug class the transition
 * cache key fell into. 'approximate' means the monitor shows something matched
 * at midtone; 'export-only' means the picture does not change until export
 * (or until the exact frame is rendered), and the control should say so.
 */
export type PreviewFidelity = 'approximate' | 'export-only'

export const previewFidelity = (def: EffectDef): PreviewFidelity =>
	def.css ? 'approximate' : 'export-only'

/** True when this clip needs the region path — the fast path applies no filters. */
export const hasRenderableEffects = (effects: AppliedEffect[] | undefined): boolean =>
	effectChain(effects, 'video').length > 0 || effectChain(effects, 'audio').length > 0
