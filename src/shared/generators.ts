/**
 * Generated layers: a clip with no footage behind it.
 *
 * A background does not have to be something someone filmed. `lavfi` can
 * synthesise one, and the region graph already knows how to take a synthetic
 * input — it uses one for the black under a gap and the silence under a region
 * with no audio. This makes that available as a timeline item.
 *
 * The point is compositing: a keyed subject needs something to sit in front of,
 * and "shoot a background too" is the reason most people never try it.
 */

export type GeneratorKind = 'solid' | 'gradient' | 'bars' | 'noise'

export interface GeneratorSpec {
	kind: GeneratorKind
	/** '#RRGGBB'. */
	colour?: string
	/** Second colour, for a gradient. */
	colour2?: string
	/** Gradient shape. */
	shape?: 'linear' | 'radial' | 'circular' | 'spiral' | 'square'
	/** 0..1. How fast a gradient turns; 0 holds still. */
	speed?: number
	/** 0..1. How much grain, for noise. */
	amount?: number
}

export const GENERATOR_DEFAULTS = {
	colour: '#101820',
	colour2: '#2A4B7C',
	shape: 'linear' as const,
	speed: 0.02,
	amount: 0.3
}

export const GENERATORS: { kind: GeneratorKind; label: string; description: string }[] = [
	{ kind: 'gradient', label: 'Gradient', description: 'Two colours, optionally turning.' },
	{ kind: 'solid', label: 'Solid', description: 'One flat colour.' },
	{ kind: 'noise', label: 'Grain', description: 'Moving grain over a colour.' },
	{ kind: 'bars', label: 'Test bars', description: 'SMPTE bars, for lining a monitor up.' }
]

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
	typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback

const fmt = (n: number) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')

/** '#RRGGBB' to ffmpeg's `0xRRGGBB`. */
export function ffColour(hex: string | undefined, fallback: string): string {
	const match = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim())
	return `0x${(match ? match[1] : fallback.replace('#', '')).toUpperCase()}`
}

export const isGenerator = (spec: GeneratorSpec | undefined): boolean =>
	!!spec && GENERATORS.some((g) => g.kind === spec.kind)

/**
 * The lavfi source string for one generated layer.
 *
 * Sized and timed to the region it fills, because a synthetic source is
 * infinite otherwise and the graph's length assertion would have nothing to
 * check against.
 */
export function generatorSource(
	spec: GeneratorSpec,
	frame: { width: number; height: number; fps: number },
	durationSec: number
): string {
	const size = `${frame.width}x${frame.height}`
	const rate = `${frame.fps}`
	const d = fmt(Math.max(0.04, durationSec))
	const colour = ffColour(spec.colour, GENERATOR_DEFAULTS.colour)

	switch (spec.kind) {
		case 'gradient': {
			const shapes = ['linear', 'radial', 'circular', 'spiral', 'square']
			const type = shapes.includes(spec.shape ?? '') ? spec.shape : GENERATOR_DEFAULTS.shape
			return [
				`gradients=s=${size}:r=${rate}:d=${d}`,
				`c0=${colour}`,
				`c1=${ffColour(spec.colour2, GENERATOR_DEFAULTS.colour2)}`,
				`type=${type}`,
				`speed=${fmt(clamp(spec.speed, 0, 1, GENERATOR_DEFAULTS.speed))}`,
				// Fixed, so the same project renders the same way twice — the
				// default is random and a re-export would not match the preview.
				'seed=1'
			].join(':')
		}
		case 'bars':
			return `smptehdbars=s=${size}:r=${rate}:d=${d}`
		case 'noise':
		case 'solid':
		default:
			return `color=c=${colour}:s=${size}:r=${rate}:d=${d}`
	}
}

/**
 * The filter chain applied to a generated source, or '' when it needs none.
 *
 * Grain is the one generator that is a source plus a filter rather than a
 * source alone — `noise` has no lavfi source of its own worth using.
 */
export function generatorFilter(spec: GeneratorSpec): string {
	if (spec.kind !== 'noise') return ''
	const amount = clamp(spec.amount, 0, 1, GENERATOR_DEFAULTS.amount)
	// `t` makes the grain move; without it every frame carries the same speckle
	// and it reads as dirt on the lens rather than as grain.
	return `noise=alls=${Math.round(amount * 60)}:allf=t+u`
}

/** Value comparison for the undo diff. Writers replace, never mutate. */
export function sameGenerator(
	a: GeneratorSpec | undefined,
	b: GeneratorSpec | undefined
): boolean {
	if (a === b) return true
	if (!a || !b) return !isGenerator(a) && !isGenerator(b)
	const keys: (keyof GeneratorSpec)[] = ['kind', 'colour', 'colour2', 'shape', 'speed', 'amount']
	return keys.every((k) => a[k] === b[k])
}

/**
 * A CSS background for the monitor, or '' when there is no honest one.
 *
 * Solid and gradient map onto CSS exactly; grain and bars do not, and get
 * nothing rather than a guess — the frame says so instead. The drift is not
 * animated here: a still gradient is the right shape, and a CSS animation that
 * ran at a different rate to the render would be a worse lie than a still one.
 */
export function generatorCss(spec: GeneratorSpec | undefined): string {
	if (!spec) return ''
	const colour = /^#[0-9a-f]{6}$/i.test(spec.colour ?? '') ? spec.colour! : GENERATOR_DEFAULTS.colour
	if (spec.kind === 'solid') return colour
	if (spec.kind !== 'gradient') return ''
	const to = /^#[0-9a-f]{6}$/i.test(spec.colour2 ?? '') ? spec.colour2! : GENERATOR_DEFAULTS.colour2
	switch (spec.shape ?? GENERATOR_DEFAULTS.shape) {
		case 'radial':
		case 'circular':
			return `radial-gradient(circle at 50% 50%, ${colour}, ${to})`
		case 'square':
			return `linear-gradient(135deg, ${colour}, ${to})`
		default:
			return `linear-gradient(90deg, ${colour}, ${to})`
	}
}

/** Whether the monitor can show this generator honestly. */
export const hasGeneratorCss = (spec: GeneratorSpec | undefined): boolean =>
	generatorCss(spec) !== ''
