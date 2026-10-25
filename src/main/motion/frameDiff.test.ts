import { describe, expect, it } from 'vitest'
import { inflateSync } from 'zlib'
import { compareFrames, encodePng, evidenceImage } from './frameDiff'

const W = 64
const H = 32
/** A premultiplied BGRA frame with an opaque white rectangle. */
const frame = (rect: { x: number; y: number; w: number; h: number }, edge?: { x: number; value: number }) => {
	const buf = Buffer.alloc(W * H * 4)
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) buf.fill(255, (y * W + x) * 4, (y * W + x) * 4 + 4)
		// A partly covered column, as anti-aliasing at a fractional edge gives.
		if (edge) buf.fill(edge.value, (y * W + edge.x) * 4, (y * W + edge.x) * 4 + 4)
	}
	return buf
}

describe('compareFrames', () => {
	it('boxes a block that moved, in sequence pixels, and calls it state', () => {
		const d = compareFrames(frame({ x: 10, y: 4, w: 8, h: 8 }), frame({ x: 20, y: 4, w: 8, h: 8 }), { width: W, height: H }, 3)
		expect(d.pixels).toBe(128)
		expect(d.maxDelta).toBe(255)
		expect(d.box).toEqual({ x: 30, y: 12, width: 54, height: 24 })
		expect(d.looksSubPixel).toBe(false)
	})

	it('calls a faint one-column change along an edge sub-pixel', () => {
		const d = compareFrames(
			frame({ x: 10, y: 4, w: 8, h: 8 }, { x: 18, value: 70 }),
			frame({ x: 10, y: 4, w: 8, h: 8 }, { x: 18, value: 110 }),
			{ width: W, height: H })
		expect(d.pixels).toBe(8)
		expect(d.maxDelta).toBe(40)
		expect(d.box).toEqual({ x: 18, y: 4, width: 1, height: 8 })
		expect(d.looksSubPixel).toBe(true)
	})

	it('finds nothing in identical frames', () => {
		const a = frame({ x: 1, y: 1, w: 3, h: 3 })
		expect(compareFrames(a, Buffer.from(a), { width: W, height: H })).toMatchObject({ pixels: 0, box: { width: 0 } })
	})
})

describe('evidenceImage', () => {
	it('is a PNG of three panels side by side, enlarged when the area is small', () => {
		const a = frame({ x: 10, y: 4, w: 8, h: 8 }, { x: 18, value: 70 })
		const b = frame({ x: 10, y: 4, w: 8, h: 8 }, { x: 18, value: 110 })
		const png = Buffer.from(evidenceImage(a, b, { width: W, height: H }, compareFrames(a, b, { width: W, height: H })), 'base64')
		expect(png.subarray(1, 4).toString()).toBe('PNG')
		const width = png.readUInt32BE(16)
		const height = png.readUInt32BE(20)
		// The 1×8 change padded by 8 px: rows 0–19 (clipped at the top), columns
		// widened to the 24-px minimum (6–30), zoomed 8×, three panels, two 4-px gaps.
		expect(height).toBe(20 * 8)
		expect(width).toBe(25 * 8 * 3 + 8)
	})
})

describe('encodePng', () => {
	it('round-trips the pixels', () => {
		const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128])
		const png = encodePng(rgba, 2, 1)
		const idat = png.indexOf('IDAT')
		const length = png.readUInt32BE(idat - 4)
		expect([...inflateSync(png.subarray(idat + 4, idat + 4 + length))]).toEqual([0, ...rgba])
	})
})
