import { describe, expect, it } from 'vitest'
import { applyStepCap } from './editor-history'

const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}` }))
const kf = (...ids: string[]) => ids.map((stepId) => ({ stepId }))

describe('applyStepCap', () => {
	it('does nothing at or under the cap', () => {
		const r = applyStepCap(steps(50), kf('s0'), 50)
		expect(r.prunedIds).toEqual([])
		expect(r.steps).toHaveLength(50)
	})

	it('keeps the newest `max` and reports the evicted ids', () => {
		const r = applyStepCap(steps(53), [], 50)
		expect(r.prunedIds).toEqual(['s0', 's1', 's2'])
		expect(r.steps[0].id).toBe('s3')
		expect(r.steps).toHaveLength(50)
	})

	// Without this the oldest surviving steps have no snapshot to replay from.
	it('promotes the newest evicted keyframe to the front as the baseline', () => {
		const r = applyStepCap(steps(53), kf('s0', 's2', 's40'), 50)
		expect(r.keyframes.map((k) => k.stepId)).toEqual(['s2', 's40'])
	})

	it('drops evicted keyframes older than the baseline', () => {
		const r = applyStepCap(steps(53), kf('s0', 's1', 's2'), 50)
		expect(r.keyframes.map((k) => k.stepId)).toEqual(['s2'])
	})

	it('leaves keyframes alone when nothing is evicted', () => {
		const r = applyStepCap(steps(10), kf('s0', 's5'), 50)
		expect(r.keyframes.map((k) => k.stepId)).toEqual(['s0', 's5'])
	})

	it('copes with no keyframes at all', () => {
		expect(applyStepCap(steps(53), [], 50).keyframes).toEqual([])
	})

	it('does not mutate its inputs', () => {
		const s = steps(53); const k = kf('s0')
		applyStepCap(s, k, 50)
		expect(s).toHaveLength(53)
		expect(k).toHaveLength(1)
	})
})
