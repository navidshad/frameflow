import { describe, expect, it } from 'vitest'
import { crossCorrelate, fft, fitLine, onsetEnvelope, standardize, type LagPoint } from './correlate'

// A seeded generator, so a failure reproduces.
function noise(n: number, seed = 1): Float64Array {
	let s = seed
	const out = new Float64Array(n)
	for (let i = 0; i < n; i++) {
		s = (s * 1664525 + 1013904223) >>> 0
		out[i] = s / 2 ** 32 - 0.5
	}
	return out
}

describe('fft', () => {
	it('round-trips', () => {
		const re = noise(1024, 3), im = new Float64Array(1024)
		const original = Float64Array.from(re)
		fft(re, im)
		fft(re, im, true)
		for (let i = 0; i < 1024; i++) expect(re[i]).toBeCloseTo(original[i], 9)
	})

	it('puts a pure tone in its bin', () => {
		const n = 256, re = new Float64Array(n), im = new Float64Array(n)
		for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 8 * i) / n)
		fft(re, im)
		expect(Math.hypot(re[8], im[8])).toBeCloseTo(n / 2, 6)
		expect(Math.hypot(re[9], im[9])).toBeCloseTo(0, 6)
	})
})

describe('crossCorrelate', () => {
	const a = noise(8000, 7)

	it('finds where b sits inside a, whichever side', () => {
		const b = a.slice(1234, 1234 + 3000)
		expect(crossCorrelate(a, b, 4000).lag).toBeCloseTo(1234, 3)
		// b longer on the left: a starts 500 samples into b.
		const longer = Float64Array.from([...noise(500, 9), ...a.slice(0, 3000)])
		expect(crossCorrelate(a, longer, 4000).lag).toBeCloseTo(-500, 3)
	})

	it('reads a clear match as a tall, unambiguous peak', () => {
		const est = crossCorrelate(a, a.slice(2000, 5000), 4000, { phat: true, guard: 50 })
		expect(est.z).toBeGreaterThan(20)
		expect(est.ratio).toBeGreaterThan(3)
		expect(crossCorrelate(a, noise(3000, 99), 4000, { phat: true, guard: 50 }).z).toBeLessThan(8)
	})

	it('lands between samples when the truth does', () => {
		// b = a delayed by 10.5 samples, made by averaging two whole-sample delays.
		const b = new Float64Array(3000)
		for (let i = 0; i < 3000; i++) b[i] = (a[i + 1000 + 10] + a[i + 1000 + 11]) / 2
		expect(crossCorrelate(a, b, 2000).lag).toBeCloseTo(1010.5, 0)
	})
})

describe('onsetEnvelope', () => {
	it('is standardized and marks where sound starts', () => {
		const x = new Float32Array(8000)
		for (let i = 4000; i < 8000; i++) x[i] = Math.sin(i / 3)
		const env = onsetEnvelope(x, 80)
		expect(env.length).toBe(100)
		expect(env.indexOf(Math.max(...env))).toBe(50)
		expect(standardize([1, 1, 1])).toEqual(new Float64Array(3))
	})
})

describe('fitLine', () => {
	const truth = (at: number) => 1.37 + at * 60e-6
	const points: LagPoint[] = Array.from({ length: 20 }, (_, i) => ({ at: i * 180, lag: truth(i * 180) + ((i % 3) - 1) * 0.002, z: 30 }))

	it('recovers offset and drift and ignores a wrong window', () => {
		const fit = fitLine([...points, { at: 900, lag: 3.9, z: 9 }])!
		expect(fit.offset).toBeCloseTo(1.37, 2)
		expect((fit.rate - 1) * 1e6).toBeCloseTo(60, -0.5)
		expect(fit.inliers).toHaveLength(20)
	})

	it('does not read drift into two windows close together', () => {
		const fit = fitLine([{ at: 10, lag: 1.37, z: 20 }, { at: 40, lag: 1.375, z: 20 }])!
		expect(fit.rate).toBe(1)
		expect(fit.offset).toBeCloseTo(1.3725, 6)
	})
})
