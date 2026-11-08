import { describe, expect, it } from 'vitest'
import {
	RenderTracker, estimateBurnSec, estimateMotionSec, estimateRegionsSec
} from './renderProgress'
import { formatEta } from '@shared/renderEta'

const clock = () => {
	let t = 1_000_000
	return { now: () => t, advance: (sec: number) => { t += sec * 1000 } }
}
const plans = [
	{ id: 'motion', label: 'Drawing motion layers', estSec: 600 },
	{ id: 'regions', label: 'Rendering segments', estSec: 300 },
	{ id: 'join', label: 'Joining', estSec: 10 }
]

describe('RenderTracker', () => {
	it('starts with every step pending, 0%, and the estimates as the time left', () => {
		const c = clock()
		const snap = new RenderTracker(plans, c.now).snapshot()
		expect(snap.steps.map((s) => s.state)).toEqual(['pending', 'pending', 'pending'])
		expect(snap.percent).toBe(0)
		expect(snap.etaSec).toBe(910)
	})

	it('weights the bar by each step\'s time, not by how many steps there are', () => {
		const c = clock()
		const t = new RenderTracker(plans, c.now)
		t.complete('motion')
		// The motion step is 600 of 910 estimated seconds: it is two thirds of the bar.
		expect(Math.round(t.snapshot().percent)).toBe(66)
	})

	it('measures the active step once it has run a while, and stops trusting its estimate', () => {
		const c = clock()
		const t = new RenderTracker(plans, c.now)
		t.begin('motion')
		c.advance(60)
		t.progress('motion', 0.1) // 10% in 60 s: the step will take 600 s, 540 more
		const snap = t.snapshot()
		expect(snap.etaSec).toBe(540 + 300 + 10)
		// A step twice as slow as estimated says so: 10% in 120 s is 1080 s more.
		const slow = new RenderTracker(plans, c.now)
		slow.begin('motion'); c.advance(120); slow.progress('motion', 0.1)
		expect(slow.snapshot().etaSec).toBe(1080 + 300 + 10)
	})

	it('does not extrapolate from a step that has barely begun', () => {
		const c = clock()
		const t = new RenderTracker(plans, c.now)
		t.begin('motion'); c.advance(2); t.progress('motion', 0.01)
		expect(t.snapshot().etaSec).toBe(Math.round(600 * 0.99 + 300 + 10))
	})

	it('finishes earlier steps when a later one begins, and never goes backwards', () => {
		const c = clock()
		const t = new RenderTracker(plans, c.now)
		t.begin('regions')
		expect(t.snapshot().steps.map((s) => s.state)).toEqual(['done', 'active', 'pending'])
		t.progress('regions', 0.6); t.progress('regions', 0.4)
		expect(t.snapshot().percent).toBeGreaterThan(60)
		t.progress('regions', 0.5)
		const before = t.snapshot().percent
		t.progress('regions', 0.2)
		expect(t.snapshot().percent).toBe(before)
	})

	it('a step already done (cached) costs no time but is still listed', () => {
		const c = clock()
		const t = new RenderTracker([{ id: 'motion', label: 'm', estSec: 0 }, ...plans.slice(1)], c.now)
		t.complete('motion', 'All 46 layers were already drawn')
		const snap = t.snapshot()
		expect(snap.steps[0]).toMatchObject({ state: 'done', detail: 'All 46 layers were already drawn' })
		expect(snap.etaSec).toBe(310)
	})

	it('reaches 100% and no time left when finished', () => {
		const t = new RenderTracker(plans, clock().now)
		t.finishAll()
		expect(t.snapshot()).toMatchObject({ percent: 100, etaSec: 0 })
	})

	it('ignores a step it was not given', () => {
		const t = new RenderTracker(plans, clock().now)
		t.begin('nope'); t.progress('nope', 1); t.complete('nope')
		expect(t.snapshot().percent).toBe(0)
	})
})

describe('estimates', () => {
	it('match what was measured: 4K frames are far dearer than 480p ones', () => {
		const uhd = estimateMotionSec(1000, 3840 * 2160)
		const small = estimateMotionSec(1000, 854 * 480)
		expect(uhd).toBeGreaterThan(small * 4)
		expect(uhd).toBeGreaterThan(60) // about 90 s per thousand frames
		expect(uhd).toBeLessThan(130)
	})

	it('regions and the text pass cost more at 4K than at 480p', () => {
		expect(estimateRegionsSec(100, 3840 * 2160)).toBeGreaterThan(estimateRegionsSec(100, 854 * 480))
		expect(estimateBurnSec(100, 3840 * 2160)).toBeGreaterThan(estimateBurnSec(100, 854 * 480))
	})
})

describe('formatEta', () => {
	it('says it in words, rounded so it does not twitch', () => {
		expect(formatEta(null)).toBe('')
		expect(formatEta(4)).toBe('Almost done')
		expect(formatEta(43)).toBe('About 45 s left')
		expect(formatEta(95)).toBe('About 2 min left')
		expect(formatEta(1500)).toBe('About 25 min left')
		expect(formatEta(3 * 3600 + 20 * 60)).toBe('About 3 h 20 min left')
		expect(formatEta(2 * 3600)).toBe('About 2 h left')
	})
})
