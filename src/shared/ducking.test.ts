import { describe, expect, it } from 'vitest'
import {
	DUCK_DEFAULTS, duckExpression, mergeIntervals, speechIntervals, type Interval
} from './ducking'
import type { TimelineItem, Track } from './types'

const vtrack: Track = {
	id: 'v1', kind: 'video', name: 'V1', order: 0,
	muted: false, locked: false, hidden: false, height: 72
}
const bed: Track = { ...vtrack, id: 'm1', kind: 'audio', name: 'A1', role: 'music' }

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'i1', trackId: 'v1', sourceAssetId: 'a1', timelineStart: 0,
	in: 0, out: 10, speed: 1, preservePitch: true, duration: 10, ...over
})

const doc = (timeline: TimelineItem[], tracks: Track[] = [vtrack, bed]) => ({ timeline, tracks })

describe('mergeIntervals', () => {
	it('folds overlaps into one span', () => {
		expect(mergeIntervals([{ start: 0, end: 3 }, { start: 2, end: 5 }]))
			.toEqual([{ start: 0, end: 5 }])
	})

	it('folds a gap smaller than the threshold, so the bed does not pop between words', () => {
		const spans = [{ start: 0, end: 2 }, { start: 2.3, end: 4 }]
		expect(mergeIntervals(spans, 0.6)).toEqual([{ start: 0, end: 4 }])
		expect(mergeIntervals(spans, 0.1)).toHaveLength(2)
	})

	it('sorts first, so input order does not matter', () => {
		expect(mergeIntervals([{ start: 5, end: 6 }, { start: 0, end: 1 }]))
			.toEqual([{ start: 0, end: 1 }, { start: 5, end: 6 }])
	})

	it('drops a zero-length span', () => {
		expect(mergeIntervals([{ start: 2, end: 2 }])).toEqual([])
	})
})

describe('speechIntervals', () => {
	it('uses the whole clip when there is no transcript', () => {
		expect(speechIntervals(doc([item({ timelineStart: 5, duration: 4 })])))
			.toEqual([{ start: 5, end: 9 }])
	})

	it('uses the phrases when there is one, so the bed lifts in the pauses', () => {
		const transcripts = {
			a1: [
				{ start: 0, end: 2, text: 'first phrase here' },
				{ start: 6, end: 8, text: 'second phrase here' }
			]
		}
		const spans = speechIntervals(doc([item()]), transcripts)
		expect(spans).toHaveLength(2)
		expect(spans[0].start).toBeCloseTo(0, 3)
		expect(spans[1].end).toBeCloseTo(8, 3)
	})

	it('never counts the bed as speech', () => {
		expect(speechIntervals(doc([item({ id: 'b', trackId: 'm1' })]))).toEqual([])
	})

	it('ignores what cannot be heard, and titles', () => {
		expect(speechIntervals(doc([item({ muted: true })]))).toEqual([])
		expect(speechIntervals(doc([item()], [{ ...vtrack, muted: true }, bed]))).toEqual([])
		expect(speechIntervals(doc([item({ text: { content: 'hi' } })]))).toEqual([])
	})
})

describe('duckExpression', () => {
	const speech: Interval[] = [{ start: 4, end: 8 }]
	const slice = { start: 0, duration: 20 }

	it('says nothing when no speech reaches this slice', () => {
		expect(duckExpression([], slice)).toBe('')
		expect(duckExpression(speech, { start: 40, duration: 5 })).toBe('')
	})

	it('is a volume envelope, not a compressor', () => {
		// A compressor's state resets at every region boundary and the bed pumps;
		// an envelope over absolute time cannot, which is the whole point.
		const expression = duckExpression(speech, slice)
		expect(expression).toMatch(/^volume='/)
		expect(expression).toContain(':eval=frame')
		expect(expression).not.toContain('sidechain')
	})

	it('shifts the interval into slice-local time', () => {
		// The filter sees `t` from the start of its own slice, so a bed starting
		// at 2s must see speech at 4s as t = 2.
		expect(duckExpression(speech, { start: 2, duration: 20 })).toContain('(t-2+0.4)')
		expect(duckExpression(speech, { start: 0, duration: 20 })).toContain('(t-4+0.4)')
	})

	it('combines troughs with min, so overlapping speech never ducks twice as far', () => {
		const expression = duckExpression(
			[{ start: 2, end: 4 }, { start: 3, end: 6 }, { start: 10, end: 11 }], slice
		)
		// One trough per interval, folded together — not summed, which would
		// drive the bed to silence wherever two phrases overlap.
		expect(expression.match(/\(1-0\.75\*/g)?.length).toBe(3)
		expect(expression).not.toContain('+(1-')
	})

	it('only carries the speech that reaches this slice', () => {
		// A long interview under a long bed would otherwise put every phrase in
		// the project into one filter argument.
		const many = Array.from({ length: 50 }, (_, i) => ({ start: i * 10, end: i * 10 + 2 }))
		const short = duckExpression(many, { start: 0, duration: 5 })
		expect(short.length).toBeLessThan(200)
	})

	it('does nothing when the depth is 1, because that is no duck at all', () => {
		expect(duckExpression(speech, slice, { depth: 1 })).toBe('')
	})

	it('defaults to a duck you can hear but not notice', () => {
		expect(DUCK_DEFAULTS.depth).toBeLessThan(0.5)
		expect(DUCK_DEFAULTS.ramp).toBeGreaterThan(0.1)
	})
})
