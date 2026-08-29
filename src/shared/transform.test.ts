import { describe, expect, it } from 'vitest'
import { hasTransform, sameTransform, transformCss, transformFilter } from './transform'

const filter = (t: Parameters<typeof transformFilter>[0]) => transformFilter(t, 1920, 1080)

describe('hasTransform', () => {
	it('is false for anything that changes nothing', () => {
		expect(hasTransform(undefined)).toBe(false)
		expect(hasTransform({})).toBe(false)
		expect(hasTransform({ x: 0, y: 0, scale: 1, rotation: 0 })).toBe(false)
	})

	it('is true as soon as one value moves', () => {
		expect(hasTransform({ scale: 1.2 })).toBe(true)
		expect(hasTransform({ x: -0.1 })).toBe(true)
		expect(hasTransform({ rotation: 90 })).toBe(true)
	})
})

describe('transformFilter', () => {
	it('emits nothing when there is nothing to do', () => {
		expect(filter(undefined)).toBe('')
		expect(filter({ scale: 1 })).toBe('')
	})

	it('scales and crops back to the frame', () => {
		expect(filter({ scale: 2 })).toBe('scale=3840:2160,crop=1920:1080:960:540')
	})

	it('pads when the clip is smaller than the frame, so the crop has room', () => {
		const chain = filter({ scale: 0.5 })
		expect(chain).toContain('scale=960:540')
		expect(chain).toContain('pad=1920:1080')
		expect(chain).toContain('crop=1920:1080:0:0')
	})

	it('moves the crop window opposite the content', () => {
		// Asking for the picture 10% right means taking the window 192px left.
		const chain = filter({ x: 0.1 })
		expect(chain).toContain('pad=2304:1080')
		expect(chain).toContain('crop=1920:1080:0:0')
		const left = filter({ x: -0.1 })
		expect(left).toContain('crop=1920:1080:384:0')
	})

	it('grows the pad to cover the offset, rather than clamping the move', () => {
		// Clamping would silently refuse to move a clip as far as it was asked.
		const chain = filter({ x: 0.5, scale: 0.5 })
		expect(chain).toContain('pad=3840:1080')
	})

	it('keeps every dimension even, because h264 cannot encode an odd one', () => {
		for (const scale of [0.333, 0.7, 1.11, 1.9]) {
			for (const n of filter({ scale }).match(/\d+/g) ?? []) {
				expect(Number(n) % 2, `${scale}: ${n}`).toBe(0)
			}
		}
	})

	it('rotates in radians, which is what ffmpeg wants', () => {
		expect(filter({ rotation: 90 })).toContain('rotate=1.5708:ow=1920:oh=1080')
		expect(filter({ rotation: -180 })).toContain('rotate=-3.1416')
	})

	it('clamps a scale that would melt the encoder', () => {
		expect(filter({ scale: 500 })).toContain('scale=9600:5400')
		expect(filter({ scale: -3 })).toContain('scale=96:54')
	})
})

describe('transformCss', () => {
	it('is the same operation in the other syntax', () => {
		// CSS applies its list right to left, so this reads scale, then rotate,
		// then translate — the order the filter chain runs in.
		expect(transformCss({ x: 0.1, y: -0.2, scale: 1.5, rotation: 45 }))
			.toBe('translate(10%, -20%) rotate(45deg) scale(1.5)')
	})

	it('omits what is at rest', () => {
		expect(transformCss({ scale: 2 })).toBe('scale(2)')
		expect(transformCss({ x: 0.25 })).toBe('translate(25%, 0%)')
		expect(transformCss(undefined)).toBe('')
	})

	it('clamps the same way the filter does, so they cannot disagree', () => {
		expect(transformCss({ scale: 500 })).toBe('scale(5)')
	})
})

describe('sameTransform', () => {
	it('compares by value, so undo sees a real edit', () => {
		expect(sameTransform({ scale: 2 }, { scale: 2 })).toBe(true)
		expect(sameTransform({ scale: 2 }, { scale: 2.5 })).toBe(false)
	})

	it('treats absent and inert as the same thing', () => {
		expect(sameTransform(undefined, {})).toBe(true)
		expect(sameTransform(undefined, { scale: 1, x: 0 })).toBe(true)
		expect(sameTransform(undefined, { scale: 1.2 })).toBe(false)
	})
})
