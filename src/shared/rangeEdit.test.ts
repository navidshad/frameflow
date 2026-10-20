import { describe, expect, it } from 'vitest'
import { MIN_RANGE_SEC, planRangeRemoval, tidyRanges } from './rangeEdit'
import type { TimelineItem } from './types'

let counter = 0
const makeId = () => `new-${++counter}`

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'i1', trackId: 'v1', sourceAssetId: 'a1', timelineStart: 0,
	in: 10, out: 20, speed: 1, preservePitch: true, duration: 10, ...over
})

describe('tidyRanges', () => {
	it('sorts and merges what overlaps', () => {
		expect(tidyRanges([{ start: 5, end: 8 }, { start: 0, end: 6 }]))
			.toEqual([{ start: 0, end: 8 }])
	})

	it('drops anything too short to be a cut', () => {
		expect(tidyRanges([{ start: 1, end: 1.01 }])).toEqual([])
	})

	it('rights a range given backwards', () => {
		expect(tidyRanges([{ start: 9, end: 2 }])).toEqual([{ start: 2, end: 9 }])
	})
})

describe('planRangeRemoval', () => {
	it('removes a clip the range covers entirely', () => {
		const plan = planRangeRemoval([item()], [{ start: -1, end: 99 }], makeId)
		expect(plan.removeIds).toEqual(['i1'])
		expect(plan.updated).toEqual([])
		expect(plan.removedSec).toBe(10)
	})

	it('trims when the range takes one end', () => {
		const plan = planRangeRemoval([item()], [{ start: 0, end: 4 }], makeId)
		expect(plan.removeIds).toEqual([])
		expect(plan.added).toEqual([])
		const [kept] = plan.updated
		expect(kept.timelineStart).toBe(4)
		expect(kept.in).toBe(14)   // 4s in at 1x = 4s of source
		expect(kept.out).toBe(20)
		expect(kept.duration).toBe(6)
	})

	it('splits when the range falls in the middle — the case that needs a new item', () => {
		const plan = planRangeRemoval([item()], [{ start: 3, end: 6 }], makeId)
		expect(plan.removeIds).toEqual([])
		expect(plan.updated[0]).toMatchObject({ id: 'i1', timelineStart: 0, in: 10, out: 13 })
		expect(plan.added[0]).toMatchObject({ timelineStart: 6, in: 16, out: 20 })
		expect(plan.removedSec).toBe(3)
	})

	it('keeps the original id on the first surviving piece', () => {
		// A selection, and anything else holding the id, survives the edit.
		const plan = planRangeRemoval([item()], [{ start: 3, end: 6 }], makeId)
		expect(plan.updated[0].id).toBe('i1')
	})

	it('maps through a retime', () => {
		const plan = planRangeRemoval([item({ speed: 2, duration: 5 })], [{ start: 0, end: 2 }], makeId)
		// Two timeline seconds at 2x is four source seconds.
		expect(plan.updated[0].in).toBe(14)
	})

	it('respects where the clip actually sits', () => {
		const plan = planRangeRemoval([item({ timelineStart: 100 })], [{ start: 102, end: 104 }], makeId)
		expect(plan.updated[0]).toMatchObject({ timelineStart: 100, out: 12 })
		expect(plan.added[0]).toMatchObject({ timelineStart: 104, in: 14 })
	})

	it('handles several ranges in one clip', () => {
		const plan = planRangeRemoval([item()], [{ start: 2, end: 3 }, { start: 6, end: 7 }], makeId)
		expect(plan.updated).toHaveLength(1)
		expect(plan.added).toHaveLength(2)
		expect(plan.removedSec).toBe(2)
	})

	it('leaves a clip the ranges never touch alone', () => {
		const plan = planRangeRemoval([item({ timelineStart: 50 })], [{ start: 0, end: 5 }], makeId)
		expect(plan).toMatchObject({ removeIds: [], updated: [], added: [] })
	})

	it('does not leave a sliver behind', () => {
		// Removing all but a hundredth of a second should remove the clip, not
		// keep an unplayable fragment.
		const plan = planRangeRemoval([item()], [{ start: 0, end: 9.99 }], makeId)
		expect(plan.removeIds).toEqual(['i1'])
	})

	it('keeps the outgoing transition on the LAST surviving piece only', () => {
		// It belongs to the cut at the clip's original end, and a split in the
		// middle would otherwise soften a cut the user just created.
		const withTransition = item({ transition: { out: { kind: 'fade', duration: 1 } } })
		const plan = planRangeRemoval([withTransition], [{ start: 3, end: 6 }], makeId)
		expect(plan.updated[0].transition).toBeUndefined()
		expect(plan.added[0].transition?.out?.kind).toBe('fade')
	})

	it('carries the clip’s own look onto both halves', () => {
		const graded = item({ effects: [{ id: 'e', kind: 'look-vintage' }] })
		const plan = planRangeRemoval([graded], [{ start: 3, end: 6 }], makeId)
		expect(plan.updated[0].effects).toHaveLength(1)
		expect(plan.added[0].effects).toHaveLength(1)
	})

	it('does nothing for no ranges', () => {
		expect(planRangeRemoval([item()], [], makeId).removedSec).toBe(0)
		expect(planRangeRemoval([item()], [{ start: 1, end: 1 + MIN_RANGE_SEC / 2 }], makeId).removedSec).toBe(0)
	})
})
