import { describe, expect, it } from 'vitest'
import { GUIDES, guideById, guidesFor, isVertical, safeArea } from './guides'

const vertical = { width: 1080, height: 1920 }
const landscape = { width: 1920, height: 1080 }

describe('isVertical', () => {
	it('knows a phone frame from a screen one', () => {
		expect(isVertical(vertical)).toBe(true)
		expect(isVertical(landscape)).toBe(false)
		expect(isVertical({ width: 1080, height: 1080 })).toBe(false)
	})
})

describe('guidesFor', () => {
	it('offers the grids anywhere', () => {
		const ids = guidesFor(landscape).map((g) => g.id)
		expect(ids).toContain('thirds')
		expect(ids).toContain('centre')
	})

	it('does not offer a vertical safe area on a 16:9 sequence', () => {
		// A TikTok overlay on a landscape edit is noise, not guidance.
		expect(guidesFor(landscape).map((g) => g.id)).not.toContain('tiktok')
		expect(guidesFor(vertical).map((g) => g.id)).toContain('tiktok')
	})
})

describe('the guide definitions', () => {
	it('keeps every band inside the frame', () => {
		for (const guide of GUIDES) {
			for (const band of guide.bands) {
				expect(band.x, `${guide.id}/${band.label}`).toBeGreaterThanOrEqual(0)
				expect(band.y, `${guide.id}/${band.label}`).toBeGreaterThanOrEqual(0)
				expect(band.x + band.w, `${guide.id}/${band.label}`).toBeLessThanOrEqual(1.0001)
				expect(band.y + band.h, `${guide.id}/${band.label}`).toBeLessThanOrEqual(1.0001)
			}
		}
	})

	it('gives every safe guide some bands and every grid none', () => {
		for (const guide of GUIDES) {
			if (guide.kind === 'safe') expect(guide.bands.length, guide.id).toBeGreaterThan(0)
			else expect(guide.bands, guide.id).toEqual([])
		}
	})

	it('labels everything, because the overlay draws the labels', () => {
		for (const guide of GUIDES) {
			expect(guide.label.trim(), guide.id).not.toBe('')
			expect(guide.note.trim(), guide.id).not.toBe('')
			for (const band of guide.bands) expect(band.label.trim(), guide.id).not.toBe('')
		}
	})
})

describe('safeArea', () => {
	it('is derived from the bands, so the two cannot disagree', () => {
		const area = safeArea(guideById('tiktok')!)!
		// Below the top bar, above the caption, clear of the action rail.
		expect(area.y).toBeCloseTo(0.08, 3)
		expect(area.y + area.h).toBeCloseTo(0.78, 3)
		expect(area.w).toBeCloseTo(0.82, 3)
	})

	it('leaves a real rectangle for every safe guide', () => {
		for (const guide of GUIDES.filter((g) => g.kind === 'safe')) {
			const area = safeArea(guide)!
			expect(area.h, guide.id).toBeGreaterThan(0.4)
			expect(area.w, guide.id).toBeGreaterThan(0.6)
		}
	})

	it('says nothing for a grid', () => {
		expect(safeArea(guideById('thirds')!)).toBeNull()
	})
})
