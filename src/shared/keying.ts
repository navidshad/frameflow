/**
 * Keying: deriving an alpha channel from a clip's own pixels.
 *
 * This is the half of "layers" that makes compositing worth having. Phase 3
 * built the compositor — every covering video track, bottom-up, with anything a
 * layer does not cover left transparent. But a layer could only be transparent
 * where it was EMPTY. Keying makes it transparent where the picture says so, so
 * a subject can sit in front of a background rather than beside it.
 *
 * ## What this is not
 *
 * It is not a learned matte. A segmentation model would key a subject shot
 * against any background; this keys a colour or a luminance, which means green
 * screen, black-background footage, and generated graphics. That covers real
 * work today and — more to the point — it builds and proves the entire alpha
 * path: derive, conform with alpha, transform with alpha, composite, encode.
 * A model becomes another way to produce the same alpha, not another engine.
 */

export type KeyKind = 'chroma' | 'luma'

export interface KeySpec {
	kind: KeyKind
	/** '#RRGGBB' — the colour to remove. Chroma only. */
	colour?: string
	/** 0..1. How far from the target still counts as background. */
	similarity?: number
	/** 0..1. Edge softness; a little stops a cut-out looking pasted on. */
	blend?: number
	/** 0..1. How much of the key colour to pull out of what remains. */
	despill?: number
	/** 0..1. Luma only: brightness below (or above) which the picture goes. */
	threshold?: number
	/** Luma only: key the DARK end rather than the bright end. */
	keepBright?: boolean
}

export const KEY_DEFAULTS = {
	colour: '#00B140',   // the standard chroma-green screens are printed in
	similarity: 0.25,
	blend: 0.08,
	despill: 0.5,
	threshold: 0.1,
	keepBright: true
}

const clamp = (n: unknown, lo: number, hi: number, fallback: number) =>
	typeof n === 'number' && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback

const fmt = (n: number) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')

/** '#RRGGBB' to the `0xRRGGBB` ffmpeg colour syntax, or the default. */
export function keyColour(hex: string | undefined): string {
	const match = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim())
	return `0x${(match ? match[1] : KEY_DEFAULTS.colour.slice(1)).toUpperCase()}`
}

export function hasKey(spec: KeySpec | undefined): boolean {
	return !!spec && (spec.kind === 'chroma' || spec.kind === 'luma')
}

/**
 * Which spill colour `despill` should pull, from the key colour itself.
 *
 * `despill` only knows green and blue, which is not a limitation in practice:
 * they are the two colours screens are made in, and a red screen would key the
 * skin tones with it.
 */
function despillType(hex: string | undefined): 'green' | 'blue' | null {
	const match = /^#?([0-9a-f]{6})$/i.exec((hex ?? KEY_DEFAULTS.colour).trim())
	if (!match) return 'green'
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(match[1].slice(i, i + 2), 16))
	if (g > r && g > b) return 'green'
	if (b > r && b > g) return 'blue'
	return null
}

/**
 * The filter fragment that turns this clip's background into transparency.
 *
 * Runs BEFORE the conform, on source pixels: keying after a letterbox pad would
 * have to decide what the bars are, and keying after a scale keys resampled
 * edges — both worse than keying the picture as shot.
 */
export function keyFilter(spec: KeySpec | undefined): string {
	if (!hasKey(spec)) return ''
	const key = spec as KeySpec
	const similarity = clamp(key.similarity, 0.01, 1, KEY_DEFAULTS.similarity)
	const blend = clamp(key.blend, 0, 1, KEY_DEFAULTS.blend)

	if (key.kind === 'luma') {
		const threshold = clamp(key.threshold, 0, 1, KEY_DEFAULTS.threshold)
		// `lumakey` removes the DARK end. To key the bright end instead, invert,
		// key, and invert back — the picture is unchanged, only the alpha is not.
		const core = `lumakey=threshold=${fmt(threshold)}:tolerance=${fmt(similarity)}:softness=${fmt(blend)}`
		return key.keepBright === false
			? `format=yuva420p,negate=alpha=0,${core},negate=alpha=0`
			: `format=yuva420p,${core}`
	}

	const parts = [
		`chromakey=color=${keyColour(key.colour)}:similarity=${fmt(similarity)}:blend=${fmt(blend)}`
	]
	// Spill is the reason a keyed subject looks fake: green bouncing off a
	// shoulder survives the key and then sits on top of a background it was
	// never lit for.
	const despill = clamp(key.despill, 0, 1, KEY_DEFAULTS.despill)
	const type = despillType(key.colour)
	if (despill > 0 && type) parts.push(`despill=type=${type}:mix=${fmt(despill)}`)
	return parts.join(',')
}

/** Value comparison for the undo diff. Writers replace, never mutate. */
export function sameKey(a: KeySpec | undefined, b: KeySpec | undefined): boolean {
	if (a === b) return true
	if (!a || !b) return !hasKey(a) && !hasKey(b)
	const keys: (keyof KeySpec)[] =
		['kind', 'colour', 'similarity', 'blend', 'despill', 'threshold', 'keepBright']
	return keys.every((k) => a[k] === b[k])
}

// ===== Health =====

export interface KeyHealth {
	/** Fraction of the frame the key removes, 0..1. */
	removed: number
	verdict: 'good' | 'thin' | 'heavy' | 'unknown'
	note: string
}

/**
 * Whether a key is doing a sensible amount of work, from the share of the frame
 * it removes.
 *
 * The transcript step already reports its own health rather than failing
 * silently, and a key deserves the same: a bad edge is worse than no feature,
 * and the two ways it goes wrong are visible in one number. Removing almost
 * nothing means the colour is wrong or the tolerance is too tight; removing
 * almost everything means the tolerance is eating the subject.
 */
export function judgeKey(removedFraction: number): KeyHealth {
	if (!Number.isFinite(removedFraction)) {
		return { removed: 0, verdict: 'unknown', note: 'Could not sample this clip.' }
	}
	const removed = Math.max(0, Math.min(1, removedFraction))
	if (removed < 0.05) {
		return {
			removed,
			verdict: 'thin',
			note: 'Almost nothing was removed — the colour is probably wrong, or the tolerance is too tight.'
		}
	}
	if (removed > 0.9) {
		return {
			removed,
			verdict: 'heavy',
			note: 'Nearly the whole frame went — the tolerance is eating the subject as well as the screen.'
		}
	}
	return { removed, verdict: 'good', note: `Removes ${Math.round(removed * 100)}% of the frame.` }
}
