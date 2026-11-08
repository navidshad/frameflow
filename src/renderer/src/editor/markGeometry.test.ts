import { describe, expect, it } from 'vitest'
import {
	fontPx, handleAt, hitMark, markBounds, markLabels, moveMark, resizeBox, resizeMark, SIZE_DEFAULT, SIZE_MAX, strokePx,
	type FrameMark, type Measure
} from './markGeometry'

// A 1000×500 picture; text measures half its font size per character.
const W = 1000
const H = 500
const measure: Measure = (text, px) => ({ width: text.length * px * 0.5 })
const mark = (tool: FrameMark['tool'], points: [number, number][], extra: Partial<FrameMark> = {}): FrameMark =>
	({ tool, color: '#ff0000', points: points.map(([x, y]) => ({ x, y })), ...extra })

describe('sizes', () => {
	it('are relative to the short side, so a mark looks the same at any resolution', () => {
		expect(strokePx({ size: 10 }, W, H)).toBe(5)
		expect(strokePx({ size: 10 }, 2 * W, 2 * H)).toBe(10)
		// Old marks had no size: they keep the width they were drawn with.
		expect(strokePx({}, W, H)).toBe((500 * SIZE_DEFAULT) / 1000)
		expect(strokePx({ size: 999 }, W, H)).toBe((500 * SIZE_MAX) / 1000)
		expect(fontPx({ size: 10 }, W, H)).toBe(25)
	})
})

describe('bounds', () => {
	it('spans a shape’s points whichever way it was drawn', () => {
		expect(markBounds(mark('rect', [[0.5, 0.8], [0.1, 0.2]]), W, H, measure)).toEqual({ x: 100, y: 100, w: 400, h: 300 })
	})

	it('measures text: widest line, one line height per line', () => {
		const t = mark('text', [[0.1, 0.1]], { size: 10, text: 'ab\nabcd' })
		expect(markBounds(t, W, H, measure)).toEqual({ x: 100, y: 50, w: 4 * 25 * 0.5, h: 2 * 25 * 1.25 })
	})
})

describe('what a click lands on', () => {
	const arrow = mark('arrow', [[0.1, 0.1], [0.5, 0.1]])
	const ring = mark('ellipse', [[0.2, 0.2], [0.8, 0.8]])
	const box = mark('rect', [[0.05, 0.05], [0.95, 0.95]])
	const pen = mark('pen', [[0.6, 0.9], [0.7, 0.9], [0.7, 0.95]])
	const words = mark('text', [[0.3, 0.45]], { size: 10, text: 'hi' })

	it('finds lines by distance, within the tolerance', () => {
		expect(hitMark([arrow], { x: 300, y: 53 }, W, H, measure, 6)).toBe(0)
		expect(hitMark([arrow], { x: 300, y: 70 }, W, H, measure, 6)).toBe(-1)
		expect(hitMark([pen], { x: 700, y: 460 }, W, H, measure, 6)).toBe(0)
	})

	it('prefers a mark’s line over the inside of a box or ring around it', () => {
		// The arrow lies inside the big box, which was drawn later.
		expect(hitMark([arrow, box], { x: 300, y: 50 }, W, H, measure, 6)).toBe(0)
		// Inside the ring, on nothing else: the ring.
		expect(hitMark([ring], { x: 500, y: 250 }, W, H, measure, 6)).toBe(0)
		// On the ring's edge (its right end), even with the box over it.
		expect(hitMark([ring, box], { x: 800, y: 250 }, W, H, measure, 6)).toBe(0)
		// The box's own edge.
		expect(hitMark([ring, box], { x: 52, y: 250 }, W, H, measure, 6)).toBe(1)
	})

	it('finds text anywhere in its block, and nothing on empty picture', () => {
		expect(hitMark([ring, words], { x: 310, y: 230 }, W, H, measure, 6)).toBe(1)
		expect(hitMark([arrow], { x: 900, y: 450 }, W, H, measure, 6)).toBe(-1)
	})
})

describe('moving and resizing', () => {
	it('moves a mark, stopping it at the picture’s edge without bending it', () => {
		const r = mark('rect', [[0.1, 0.1], [0.3, 0.2]])
		expect(moveMark(r, 0.2, 0.1).points.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)])).toEqual([[0.3, 0.2], [0.5, 0.3]])
		expect(moveMark(r, 0.9, -0.5).points.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)])).toEqual([[0.8, 0], [1, 0.1]])
	})

	it('drags a corner with the opposite corner fixed, and never inside out', () => {
		const b = { x: 100, y: 100, w: 200, h: 100 }
		expect(handleAt(b, { x: 302, y: 199 }, 6)).toBe('se')
		expect(handleAt(b, { x: 200, y: 150 }, 6)).toBeNull()
		expect(resizeBox(b, 'se', { x: 400, y: 300 })).toEqual({ x: 100, y: 100, w: 300, h: 200 })
		// Past the fixed corner: the box flips over it rather than going negative.
		expect(resizeBox(b, 'se', { x: 50, y: 50 })).toEqual({ x: 50, y: 50, w: 50, h: 50 })
		expect(resizeBox(b, 'nw', { x: 300, y: 200 }, 4)).toEqual({ x: 300, y: 200, w: 4, h: 4 })
	})

	it('stretches a shape’s points into the new box', () => {
		const r = mark('ellipse', [[0.1, 0.2], [0.3, 0.4]])
		const from = markBounds(r, W, H, measure)
		const out = resizeMark(r, from, { x: 100, y: 100, w: 400, h: 200 }, W, H)
		expect(out.points.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)])).toEqual([[0.1, 0.2], [0.5, 0.6]])
	})

	it('keeps a straight arrow straight (a box with no height)', () => {
		const a = mark('arrow', [[0.1, 0.5], [0.3, 0.5]])
		const out = resizeMark(a, markBounds(a, W, H, measure), { x: 100, y: 300, w: 400, h: 10 }, W, H)
		expect(out.points.map((p) => [+p.x.toFixed(3), +p.y.toFixed(3)])).toEqual([[0.1, 0.6], [0.5, 0.6]])
	})

	it('grows text by its size, not by stretching it', () => {
		const t = mark('text', [[0.1, 0.1]], { size: 4, text: 'hi' })
		const from = markBounds(t, W, H, measure)
		const out = resizeMark(t, from, { x: 50, y: 20, w: from.w * 3, h: from.h * 2 }, W, H)
		expect(out.size).toBe(8)
		expect(out.points).toEqual([{ x: 0.05, y: 0.04 }])
	})
})

it('lists the words written on a frame', () => {
	expect(markLabels([mark('text', [[0, 0]], { text: ' smaller ' }), mark('arrow', [[0, 0], [1, 1]]), mark('text', [[0, 0]], { text: '  ' })])).toEqual(['smaller'])
})
