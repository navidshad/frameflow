import { describe, expect, it } from 'vitest'
import { clampPan, panFraction, panObjectPosition, sequenceFrame } from './framing'
import { vnorm } from '../main/editor/renderBuilders'

describe('clampPan', () => {
	it('keeps a pan inside the frame', () => {
		expect(clampPan(-5)).toBe(-1)
		expect(clampPan(5)).toBe(1)
		expect(clampPan(0.4)).toBe(0.4)
	})

	it('centres anything that is not a number', () => {
		expect(clampPan()).toBe(0)
		expect(clampPan(NaN)).toBe(0)
		expect(clampPan(Infinity)).toBe(0)
	})
})

describe('panFraction', () => {
	it('maps the pan range onto the overflow', () => {
		expect(panFraction(-1)).toBe(0)    // keep the left/top edge
		expect(panFraction(0)).toBe(0.5)   // centred
		expect(panFraction(1)).toBe(1)     // keep the right/bottom edge
	})
})

describe('panObjectPosition', () => {
	it('writes the fraction as a percentage on both axes', () => {
		expect(panObjectPosition(-1)).toBe('0% 0%')
		expect(panObjectPosition(0)).toBe('50% 50%')
		expect(panObjectPosition(1)).toBe('100% 100%')
		expect(panObjectPosition(0.5)).toBe('75% 75%')
	})
})

describe('the monitor and the export agree', () => {
	// The monitor cannot run ffmpeg, so it reproduces the crop in CSS. If these
	// two ever drift, the preview stops being a preview — which is the whole
	// reason the transition cache exists, and worth a test that says so.
	it('spends the same fraction in both syntaxes', () => {
		for (const pan of [-1, -0.5, 0, 0.25, 1]) {
			const css = panObjectPosition(pan)
			const fraction = parseFloat(css) / 100
			const chain = vnorm(1080, 1920, 30, { mode: 'fill', pan })
			const offset = chain.match(/crop=1080:1920:([^:]+):/)![1]
			// Either the centred shorthand or an explicit multiple of the overflow.
			const emitted = offset === '(iw-ow)/2'
				? 0.5
				: parseFloat(offset.replace('(iw-ow)*', ''))
			expect(emitted).toBeCloseTo(fraction, 6)
		}
	})
})

describe('sequenceFrame', () => {
	const sources = [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]

	it('honours a chosen frame', () => {
		expect(sequenceFrame({ width: 1080, height: 1920, frameChosen: true }, sources))
			.toEqual({ width: 1080, height: 1920 })
	})

	it('follows the largest source until one is chosen', () => {
		// Every project on disk predates the picker and takes this branch, so it
		// has to render exactly as it did before.
		expect(sequenceFrame({ width: 1080, height: 1920 }, sources))
			.toEqual({ width: 1920, height: 1080 })
		expect(sequenceFrame(undefined, sources)).toEqual({ width: 1920, height: 1080 })
	})

	it('falls back to 720p when nothing has a picture', () => {
		expect(sequenceFrame(undefined, [])).toEqual({ width: 1280, height: 720 })
		expect(sequenceFrame(undefined, [{}])).toEqual({ width: 1280, height: 720 })
	})

	it('rounds to even, because h264 cannot encode an odd dimension', () => {
		expect(sequenceFrame({ width: 1081, height: 1921, frameChosen: true }, []))
			.toEqual({ width: 1080, height: 1920 })
		expect(sequenceFrame(undefined, [{ width: 1, height: 1 }]))
			.toEqual({ width: 2, height: 2 })
	})
})
