import type { TimelineItemTransform } from './types'

/**
 * Moving, scaling and rotating a clip inside the sequence frame.
 *
 * Distinct from `framing.ts`, which answers the narrow question of how a source
 * of one shape fills a frame of another. This is the free transform: where the
 * picture sits once it is already the right shape, and what PiP is built on.
 *
 * It runs AFTER the conform, in frame space — a scale applied in source pixels
 * would be undone by `vnorm` scaling back to the frame, and a position would
 * mean nothing until there was a frame to be positioned in.
 *
 * Position is in FRACTIONS of the frame, so it survives a change of sequence
 * shape for the same reason `ItemFraming.pan` and a title's x/y do.
 */

export const TRANSFORM_DEFAULTS = { x: 0, y: 0, scale: 1, rotation: 0 }

export const SCALE_RANGE = { min: 0.05, max: 5 }
/** ±1 puts the clip a whole frame off centre, which is off screen. */
export const OFFSET_RANGE = { min: -1.5, max: 1.5 }

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

const read = (transform: TimelineItemTransform | undefined) => ({
	x: clamp(Number(transform?.x ?? 0) || 0, OFFSET_RANGE.min, OFFSET_RANGE.max),
	y: clamp(Number(transform?.y ?? 0) || 0, OFFSET_RANGE.min, OFFSET_RANGE.max),
	scale: clamp(Number(transform?.scale ?? 1) || 1, SCALE_RANGE.min, SCALE_RANGE.max),
	rotation: Number(transform?.rotation ?? 0) || 0
})

/** Whether this transform does anything at all. */
export function hasTransform(transform: TimelineItemTransform | undefined): boolean {
	if (!transform) return false
	const t = read(transform)
	return t.x !== 0 || t.y !== 0 || t.scale !== 1 || t.rotation !== 0
}

const fmt = (n: number) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
/** h264 cannot encode an odd dimension, and `scale` will happily produce one. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
/** An even value inside [lo, hi], for a crop origin. */
const snap = (n: number, lo: number, hi: number) =>
	Math.max(lo, Math.min(hi, Math.round(clamp(n, lo, hi) / 2) * 2))

/**
 * The ffmpeg fragment, for a picture already conformed to `width`×`height`.
 *
 * Scale, rotate, then pad and crop to put the result back in the frame. The pad
 * is grown to cover the offset as well as the scale, so the crop window is
 * always inside its input — the alternative is clamping the offset, which would
 * silently refuse to move a clip as far as the user asked.
 */
export function transformFilter(
	transform: TimelineItemTransform | undefined,
	width: number,
	height: number,
	/**
	 * True for a compositing layer, where the area a scale or an offset vacates
	 * must be TRANSPARENT rather than black — black would paint over whatever
	 * sits underneath, which is the whole picture in a picture-in-picture.
	 */
	alpha = false
): string {
	if (!hasTransform(transform)) return ''
	const t = read(transform)
	const parts: string[] = []
	const fill = alpha ? 'black@0' : 'black'

	let w = width
	let h = height
	if (t.scale !== 1) {
		w = even(width * t.scale)
		h = even(height * t.scale)
		parts.push(`scale=${w}:${h}`)
	}
	if (t.rotation !== 0) {
		// Same size in, same size out: the corners that rotate out of frame go
		// black, which is what every editor does with a rotated full-frame clip.
		parts.push(`rotate=${fmt((t.rotation * Math.PI) / 180)}:ow=${w}:oh=${h}:c=${fill}`)
	}

	const dx = Math.round(t.x * width)
	const dy = Math.round(t.y * height)
	const padW = even(Math.max(width + 2 * Math.abs(dx), w))
	const padH = even(Math.max(height + 2 * Math.abs(dy), h))
	if (padW !== w || padH !== h) {
		parts.push(`pad=${padW}:${padH}:(ow-iw)/2:(oh-ih)/2:${fill}`)
	}
	// Moving the CONTENT right means moving the crop window left, hence the minus.
	// The offsets are snapped to even as well: on 4:2:0 an odd crop origin shifts
	// chroma half a sample against luma, which reads as a coloured fringe.
	const cx = snap((padW - width) / 2 - dx, 0, padW - width)
	const cy = snap((padH - height) / 2 - dy, 0, padH - height)
	parts.push(`crop=${width}:${height}:${cx}:${cy}`)
	return parts.join(',')
}

/**
 * The same operation as a CSS `transform`, for the monitor.
 *
 * CSS applies the list right to left, so this reads scale, then rotate, then
 * translate — the same order the filter chain does. Unlike the colour
 * approximations, this one is exact: both are affine transforms of the frame.
 */
export function transformCss(transform: TimelineItemTransform | undefined): string {
	if (!hasTransform(transform)) return ''
	const t = read(transform)
	const parts: string[] = []
	if (t.x !== 0 || t.y !== 0) parts.push(`translate(${fmt(t.x * 100)}%, ${fmt(t.y * 100)}%)`)
	if (t.rotation !== 0) parts.push(`rotate(${fmt(t.rotation)}deg)`)
	if (t.scale !== 1) parts.push(`scale(${fmt(t.scale)})`)
	return parts.join(' ')
}

/** Value comparison, for the undo diff. Writers replace, never mutate. */
export function sameTransform(
	a: TimelineItemTransform | undefined,
	b: TimelineItemTransform | undefined
): boolean {
	if (a === b) return true
	if (!a || !b) return !hasTransform(a) && !hasTransform(b)
	const [x, y] = [read(a), read(b)]
	return x.x === y.x && x.y === y.y && x.scale === y.scale && x.rotation === y.rotation
}
