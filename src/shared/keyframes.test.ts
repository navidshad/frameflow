import { describe, expect, it } from 'vitest'
import {
	hasKeyframes, isAnimatable, keyframeExpression, normalise, sameKeyframes,
	valueAt, type Keyframe
} from './keyframes'

const ramp: Keyframe[] = [{ t: 0, value: 0 }, { t: 2, value: 10 }]

describe('valueAt', () => {
	it('interpolates between keyframes', () => {
		expect(valueAt(ramp, 0)).toBe(0)
		expect(valueAt(ramp, 1)).toBe(5)
		expect(valueAt(ramp, 2)).toBe(10)
	})

	it('is flat outside the keyframes, never extrapolating', () => {
		expect(valueAt(ramp, -5)).toBe(0)
		expect(valueAt(ramp, 99)).toBe(10)
	})

	it('falls back when there is nothing to read', () => {
		expect(valueAt(undefined, 1, 0.5)).toBe(0.5)
		expect(valueAt([], 1, 0.5)).toBe(0.5)
	})

	it('pins a constant from a single keyframe', () => {
		expect(valueAt([{ t: 1, value: 7 }], 0, 0)).toBe(7)
		expect(valueAt([{ t: 1, value: 7 }], 99, 0)).toBe(7)
	})

	it('holds when asked to hold', () => {
		const held: Keyframe[] = [{ t: 0, value: 0, ease: 'hold' }, { t: 2, value: 10 }]
		expect(valueAt(held, 1.99)).toBe(0)
		expect(valueAt(held, 2)).toBe(10)
	})

	it('eases symmetrically about the midpoint', () => {
		const eased: Keyframe[] = [{ t: 0, value: 0, ease: 'ease' }, { t: 2, value: 10 }]
		expect(valueAt(eased, 1)).toBeCloseTo(5, 6)
		expect(valueAt(eased, 0.5)).toBeLessThan(2.5)   // slow out of the first
		expect(valueAt(eased, 1.5)).toBeGreaterThan(7.5) // slow into the last
	})

	it('sorts, so keyframes added out of order still read forwards', () => {
		const messy: Keyframe[] = [{ t: 2, value: 10 }, { t: 0, value: 0 }]
		expect(valueAt(messy, 1)).toBe(5)
	})

	it('drops a keyframe with no usable numbers', () => {
		expect(normalise([{ t: NaN, value: 1 }, { t: 0, value: 2 }])).toHaveLength(1)
	})
})

describe('keyframeExpression', () => {
	it('says nothing when there is no curve to draw', () => {
		expect(keyframeExpression(undefined)).toBe('')
		expect(keyframeExpression([{ t: 0, value: 5 }])).toBe('')
	})

	it('agrees with valueAt everywhere — the whole point of two consumers', () => {
		// The monitor evaluates the list; the export evaluates this string. If
		// they part company, the preview stops being a preview.
		const track: Keyframe[] = [
			{ t: 0, value: 0 },
			{ t: 1, value: 8, ease: 'ease' },
			{ t: 2, value: 8, ease: 'hold' },
			{ t: 3, value: -4 }
		]
		const expression = keyframeExpression(track)
		for (let t = -0.5; t <= 3.5; t += 0.1) {
			const expected = valueAt(track, t)
			expect(evaluate(expression, t)).toBeCloseTo(expected, 6)
		}
	})

	it('shifts clip time into the filter’s own frame', () => {
		// A slice does not necessarily start where its clip does, exactly as the
		// ducking envelope has to account for.
		const shifted = keyframeExpression(ramp, { offset: 1 })
		expect(evaluate(shifted, 0)).toBeCloseTo(5, 6)
	})

	it('uses whatever time variable the filter exposes', () => {
		expect(keyframeExpression(ramp, { time: 'time' })).toContain('time')
	})
})

describe('what is animatable', () => {
	it('only claims what the binary can actually vary per frame', () => {
		expect(isAnimatable('transform.x')).toBe(true)
		expect(isAnimatable('transform.rotation')).toBe(true)
		expect(isAnimatable('gain')).toBe(true)
		// crop's w/h are init-only in this build, so scale cannot ride on it.
		expect(isAnimatable('transform.scale')).toBe(false)
	})

	it('needs two keyframes before anything is animated', () => {
		expect(hasKeyframes({ 'transform.x': ramp })).toBe(true)
		expect(hasKeyframes({ 'transform.x': [{ t: 0, value: 1 }] })).toBe(false)
		expect(hasKeyframes({ 'transform.scale': ramp })).toBe(false)
		expect(hasKeyframes(undefined)).toBe(false)
	})
})

describe('sameKeyframes', () => {
	it('compares by value, so undo sees a real edit', () => {
		expect(sameKeyframes({ a: [...ramp] }, { a: [...ramp] })).toBe(true)
		expect(sameKeyframes({ a: ramp }, { a: [{ t: 0, value: 0 }, { t: 2, value: 11 }] })).toBe(false)
		expect(sameKeyframes(undefined, {})).toBe(true)
		expect(sameKeyframes(undefined, { a: ramp })).toBe(false)
	})
})

/** A tiny reader for the subset of ffmpeg expression syntax we emit. */
function evaluate(expression: string, t: number): number {
	const js = expression
		.replace(/\bif\(/g, '__if(')
		.replace(/\blt\(/g, '__lt(')
		.replace(/\bt\b/g, String(t))
	// eslint-disable-next-line no-new-func
	return new Function('__if', '__lt', `return ${js}`)(
		(c: number, a: number, b: number) => (c ? a : b),
		(a: number, b: number) => (a < b ? 1 : 0)
	)
}
