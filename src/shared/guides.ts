/**
 * Guides: what the monitor draws ON TOP of the picture to help you frame it.
 *
 * Two kinds, and they answer different questions.
 *
 *   A GRID answers "is this composed" — thirds, centre.
 *   A SAFE AREA answers "will the platform cover this" — and that is the one
 *   that matters here, because the whole point of the reframing work is that
 *   people post the result. A title placed dead centre of a 9:16 frame lands
 *   under TikTok's caption block, and you cannot see that until it is live.
 *
 * Everything is a FRACTION of the frame, never pixels, so a guide follows the
 * sequence when its shape changes — the same rule titles, framing pan and the
 * transform all follow.
 *
 * ## About the numbers
 *
 * They are deliberately GENEROUS approximations of published platform
 * guidance, not measured pixel specs, and they err toward covering more than
 * the app actually does. A guide that says "this is safe" and is wrong is worse
 * than one that is slightly pessimistic — the failure it exists to prevent is
 * discovering the problem after publishing.
 */

export interface GuideBand {
	/** Fractions of the frame: 0,0 top-left, 1,1 bottom-right. */
	x: number
	y: number
	w: number
	h: number
	label: string
}

export interface GuideDef {
	id: string
	label: string
	/** One line under the name in the menu. */
	note: string
	kind: 'grid' | 'safe'
	/** Which sequence shapes it means anything for. */
	appliesTo: 'vertical' | 'any'
	/** Regions the platform's own UI sits over. Empty for a grid. */
	bands: GuideBand[]
}

/** Roughly 9:16 or taller. A safe area for vertical says nothing about 16:9. */
export const isVertical = (frame: { width: number; height: number }): boolean =>
	frame.height > frame.width * 1.2

export const GUIDES: GuideDef[] = [
	{
		id: 'thirds',
		label: 'Thirds',
		note: 'The composition grid.',
		kind: 'grid',
		appliesTo: 'any',
		bands: []
	},
	{
		id: 'centre',
		label: 'Centre',
		note: 'Crosshair on the middle of the frame.',
		kind: 'grid',
		appliesTo: 'any',
		bands: []
	},
	{
		id: 'tiktok',
		label: 'TikTok',
		note: 'Caption block, action rail and the nav bar.',
		kind: 'safe',
		appliesTo: 'vertical',
		bands: [
			{ x: 0, y: 0, w: 1, h: 0.08, label: 'Top bar' },
			{ x: 0.82, y: 0.38, w: 0.18, h: 0.42, label: 'Actions' },
			{ x: 0, y: 0.78, w: 0.82, h: 0.14, label: 'Caption' },
			{ x: 0, y: 0.92, w: 1, h: 0.08, label: 'Nav' }
		]
	},
	{
		id: 'reels',
		label: 'Reels',
		note: 'Instagram’s caption area and action rail.',
		kind: 'safe',
		appliesTo: 'vertical',
		bands: [
			{ x: 0, y: 0, w: 1, h: 0.07, label: 'Top bar' },
			{ x: 0.84, y: 0.40, w: 0.16, h: 0.40, label: 'Actions' },
			{ x: 0, y: 0.76, w: 0.84, h: 0.16, label: 'Caption' },
			{ x: 0, y: 0.92, w: 1, h: 0.08, label: 'Nav' }
		]
	},
	{
		id: 'shorts',
		label: 'Shorts',
		note: 'YouTube’s title, action rail and progress bar.',
		kind: 'safe',
		appliesTo: 'vertical',
		bands: [
			{ x: 0, y: 0, w: 1, h: 0.06, label: 'Top bar' },
			{ x: 0.85, y: 0.42, w: 0.15, h: 0.38, label: 'Actions' },
			{ x: 0, y: 0.80, w: 0.85, h: 0.12, label: 'Title' },
			{ x: 0, y: 0.92, w: 1, h: 0.08, label: 'Controls' }
		]
	}
]

export const guideById = (id: string | null): GuideDef | undefined =>
	GUIDES.find((g) => g.id === id)

/** Guides worth offering for this frame — a vertical safe area on 16:9 is noise. */
export function guidesFor(frame: { width: number; height: number }): GuideDef[] {
	const vertical = isVertical(frame)
	return GUIDES.filter((g) => g.appliesTo === 'any' || vertical)
}

/**
 * The rectangle NOTHING important should leave, given a guide's bands.
 *
 * Derived rather than declared: a safe area that disagreed with the bands
 * drawn beside it would be the one thing a guide must never do.
 */
export function safeArea(guide: GuideDef): GuideBand | null {
	if (guide.kind !== 'safe' || !guide.bands.length) return null
	// Bands are edge-anchored in practice, so the safe area is what is left
	// after the full-width ones take off the top and bottom and the side ones
	// take off the edge.
	let top = 0
	let bottom = 1
	let right = 1
	for (const band of guide.bands) {
		const spansWidth = band.w > 0.9
		if (spansWidth && band.y <= 0.5) top = Math.max(top, band.y + band.h)
		else if (spansWidth) bottom = Math.min(bottom, band.y)
		else if (band.x > 0.5) right = Math.min(right, band.x)
		if (!spansWidth && band.y + band.h > 0.5 && band.x <= 0.5) {
			bottom = Math.min(bottom, band.y)
		}
	}
	// The caption band is not full width, so fold it in too.
	for (const band of guide.bands) {
		if (band.w <= 0.9 && band.x <= 0.5) bottom = Math.min(bottom, band.y)
	}
	return {
		x: 0, y: top, w: right, h: Math.max(0, bottom - top),
		label: 'Safe'
	}
}
