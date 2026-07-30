import { describe, expect, it } from 'vitest'
import type { TimelineItem, Track } from './types'
import { closeTimelineGaps, rippleAfterRemoval } from './timeline'

const track = (id: string): Track => ({
	id, kind: 'video', name: id, order: 0, muted: false, locked: false, hidden: false, height: 72
})

/** Items of the given [start, duration] pairs on one track. */
const items = (spec: [number, number][], trackId = 'v1'): TimelineItem[] =>
	spec.map(([start, duration], i) => ({
		id: `${trackId}-${i}`, trackId, sourceAssetId: 'a',
		timelineStart: start, in: 0, out: duration, speed: 1, preservePitch: true, duration
	}))

const starts = (list: TimelineItem[]) =>
	[...list].sort((a, b) => a.timelineStart - b.timelineStart).map((i) => i.timelineStart)

describe('closeTimelineGaps', () => {
	it('closes an internal gap', () => {
		const timeline = items([[0, 10], [30, 10], [40, 10]])
		expect(closeTimelineGaps({ tracks: [track('v1')], timeline })).toBe(true)
		expect(starts(timeline)).toEqual([0, 10, 20])
	})

	it('closes a leading gap', () => {
		const timeline = items([[25, 10], [35, 10]])
		expect(closeTimelineGaps({ tracks: [track('v1')], timeline })).toBe(true)
		expect(starts(timeline)).toEqual([0, 10])
	})

	it('reports no change when the track is already contiguous', () => {
		const timeline = items([[0, 10], [10, 10]])
		expect(closeTimelineGaps({ tracks: [track('v1')], timeline })).toBe(false)
		expect(starts(timeline)).toEqual([0, 10])
	})

	it('also resolves overlaps', () => {
		const timeline = items([[0, 10], [5, 10]])
		expect(closeTimelineGaps({ tracks: [track('v1')], timeline })).toBe(true)
		expect(starts(timeline)).toEqual([0, 10])
	})

	it('treats each track independently', () => {
		const timeline = [...items([[0, 10], [40, 10]], 'v1'), ...items([[0, 5], [20, 5]], 'a1')]
		closeTimelineGaps({ tracks: [track('v1'), track('a1')], timeline })
		expect(starts(timeline.filter((i) => i.trackId === 'v1'))).toEqual([0, 10])
		expect(starts(timeline.filter((i) => i.trackId === 'a1'))).toEqual([0, 5])
	})

	it('can be limited to specific tracks', () => {
		const timeline = [...items([[0, 10], [40, 10]], 'v1'), ...items([[20, 5]], 'a1')]
		closeTimelineGaps({ tracks: [track('v1'), track('a1')], timeline }, { trackIds: ['v1'] })
		expect(starts(timeline.filter((i) => i.trackId === 'v1'))).toEqual([0, 10])
		// The untouched track keeps its position.
		expect(starts(timeline.filter((i) => i.trackId === 'a1'))).toEqual([20])
	})

	it('accounts for speed when measuring an item', () => {
		const timeline = items([[0, 10], [30, 10]])
		timeline[0].speed = 2   // 10s of source plays in 5s
		expect(closeTimelineGaps({ tracks: [track('v1')], timeline })).toBe(true)
		expect(starts(timeline)).toEqual([0, 5])
	})
})

describe('rippleAfterRemoval', () => {
	it('takes back exactly the time the removal freed', () => {
		const all = items([[0, 10], [10, 10], [20, 10], [30, 10]])
		const removed = [all[1]]
		const survivors = all.filter((i) => i !== removed[0])
		expect(rippleAfterRemoval(survivors, removed)).toBe(true)
		expect(starts(survivors)).toEqual([0, 10, 20])
	})

	it('leaves items before the removal alone', () => {
		const all = items([[0, 10], [10, 10], [20, 10]])
		const removed = [all[2]]
		const survivors = all.slice(0, 2)
		expect(rippleAfterRemoval(survivors, removed)).toBe(false)
		expect(starts(survivors)).toEqual([0, 10])
	})

	it('preserves a gap it did not create', () => {
		// Conservative on purpose: only the removed duration comes back, so the
		// deliberate 10s hole between the 2nd and 3rd clip survives.
		const all = items([[0, 10], [10, 10], [30, 10]])
		const removed = [all[0]]
		const survivors = all.slice(1)
		rippleAfterRemoval(survivors, removed)
		expect(starts(survivors)).toEqual([0, 20])
	})

	it('does nothing when nothing was removed', () => {
		const survivors = items([[0, 10], [10, 10]])
		expect(rippleAfterRemoval(survivors, [])).toBe(false)
	})

	it('only ripples within the same track', () => {
		const removed = items([[0, 10]], 'v1')
		const survivors = items([[20, 10]], 'a1')
		expect(rippleAfterRemoval(survivors, removed)).toBe(false)
		expect(starts(survivors)).toEqual([20])
	})
})
