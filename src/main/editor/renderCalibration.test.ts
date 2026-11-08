import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { calibrate, loadCalibration, recordActuals, saveCalibration } from './renderCalibration'
import { RenderTracker } from './renderProgress'
import { formatEta } from '@shared/renderEta'

const clock = () => {
	let t = 1_000_000
	return { now: () => t, advance: (sec: number) => { t += sec * 1000 } }
}

describe('calibration', () => {
	it('leaves a step it has never seen as a first guess', () => {
		expect(calibrate({}, 'regions', 100)).toEqual({ estSec: 100, calibrated: false })
	})

	it('learns the factor from one export, then moves halfway toward each new one', () => {
		// The segment step was guessed at 173 s and took 1600 s: about nine times.
		const first = recordActuals({}, [{ id: 'regions', rawEstSec: 173, actualSec: 1560 }])
		expect(first.regions.factor).toBeCloseTo(9.02, 1)
		expect(calibrate(first, 'regions', 100)).toEqual({ estSec: expect.closeTo(902, 0), calibrated: true })
		// A faster run (a quiet machine) pulls it down by half the difference, not all of it.
		const second = recordActuals(first, [{ id: 'regions', rawEstSec: 173, actualSec: 346 }]) // ratio 2
		expect(second.regions.factor).toBeCloseTo((9.02 + 2) / 2, 1)
		expect(second.regions.runs).toBe(2)
	})

	it('cannot be swung off by one absurd export', () => {
		expect(recordActuals({}, [{ id: 'join', rawEstSec: 2, actualSec: 5000 }]).join.factor).toBe(12)
		expect(recordActuals({}, [{ id: 'join', rawEstSec: 100, actualSec: 1 }]).join.factor).toBe(0.25)
	})

	describe('on disk', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-cal-'))
		afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

		it('round-trips, and a missing or broken file is just no history', () => {
			const file = path.join(dir, 'sub', 'render-calibration.json')
			expect(loadCalibration(file)).toEqual({})
			saveCalibration(file, { regions: { factor: 4, runs: 2 } })
			expect(loadCalibration(file)).toEqual({ regions: { factor: 4, runs: 2 } })
			fs.writeFileSync(file, '{not json')
			expect(loadCalibration(file)).toEqual({})
			fs.writeFileSync(file, JSON.stringify({ a: { factor: 'x' }, b: { factor: -1 }, c: { factor: 3 } }))
			expect(Object.keys(loadCalibration(file))).toEqual(['c'])
		})
	})
})

describe('the time left when work does not go at one speed', () => {
	const plans = [
		{ id: 'regions', label: 'Segments', estSec: 100, calibrated: true },
		{ id: 'join', label: 'Join', estSec: 10, calibrated: true }
	]

	it('trusts the slower recent pace over the quick start', () => {
		const c = clock()
		const t = new RenderTracker(plans, c.now)
		t.begin('regions')
		// 60% in the first 60 s...
		for (let i = 1; i <= 12; i++) { c.advance(5); t.progress('regions', 0.05 * i) }
		// ...then it slows to 1% every 5 s (the long, heavy cuts).
		for (let i = 1; i <= 24; i++) { c.advance(5); t.progress('regions', 0.6 + 0.01 * i) }
		const snap = t.snapshot()
		// 84% done after 180 s: the whole-step average says 34 s more; the last two minutes say 80 s more.
		expect(snap.etaSec).toBeGreaterThan(70 + 10)
	})

	it('is a wide guess before anything is measured, and narrows when the pace is steady and nothing left is guessed', () => {
		const c = clock()
		const t = new RenderTracker([{ id: 'regions', label: 'Segments', estSec: 100 }, { id: 'join', label: 'Join', estSec: 10 }], c.now)
		expect(t.snapshot().etaSpread).toBeGreaterThanOrEqual(0.5)
		const c2 = clock()
		const steady = new RenderTracker(plans, c2.now)
		steady.begin('regions')
		for (let i = 1; i <= 30; i++) { c2.advance(5); steady.progress('regions', 0.02 * i) }
		expect(steady.snapshot().etaSpread).toBeLessThan(0.2)
	})

	it('reports what each step really took, and skips one that was cached', () => {
		const c = clock()
		const t = new RenderTracker([{ id: 'motion', label: 'Motion', estSec: 0 }, { id: 'regions', label: 'Segments', estSec: 100, rawEstSec: 50 }], c.now)
		t.complete('motion')
		t.begin('regions'); c.advance(300); t.complete('regions')
		expect(t.actuals()).toEqual([{ id: 'regions', rawEstSec: 50, actualSec: 300 }])
	})
})

describe('formatEta as a range', () => {
	it('keeps one number when the spread is small and a range when it is not', () => {
		expect(formatEta(600)).toBe('About 10 min left')
		expect(formatEta(600, 0.05)).toBe('About 10 min left')
		expect(formatEta(600, 0.3)).toBe('About 7 to 13 min left')
		expect(formatEta(4800, 0.25)).toBe('About 1 h to 1 h 40 min left')
		expect(formatEta(30, 0.6)).toBe('About 30 s left')
		expect(formatEta(5, 0.6)).toBe('Almost done')
	})
})
