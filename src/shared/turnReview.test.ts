import { describe, expect, it } from 'vitest'
import type { EditorDocument, TimelineItem, Track } from './types'
import { reviewFacts, reviewMessage, WORKING_CHECKLIST } from './turnReview'

const track = (id: string, name: string): Track => ({ id, kind: 'video', name, order: 0, muted: false, locked: false, hidden: false, height: 64 })
const clip = (id: string, start: number, length: number, extra: Partial<TimelineItem> = {}): TimelineItem =>
	({ id, trackId: 'v1', sourceAssetId: 'a', timelineStart: start, in: 100 + start, out: 100 + start + length, speed: 1, duration: length, label: id, ...extra }) as TimelineItem
const layer = (id: string, start: number, length: number): TimelineItem =>
	({ id, trackId: 'm1', sourceAssetId: '', timelineStart: start, in: 0, out: length, speed: 1, duration: length, label: id, motion: { template: 'lower-third' } }) as TimelineItem
const doc = (timeline: TimelineItem[]): EditorDocument => ({ tracks: [track('v1', 'V1'), track('m1', 'M1')], timeline }) as unknown as EditorDocument

describe('reviewFacts', () => {
	// Before: two shots and a lower third across their join. After: a cut at 3–5 s.
	const before = doc([clip('a', 0, 4), clip('b', 4, 4), layer('card', 2, 4)])
	const after = doc([clip('a', 0, 3), clip('b2', 3, 3), clip('crumb', 6, 0.1), layer('card', 2, 1.0), layer('card-2', 3, 0.4)])

	it('measures the real change in length, not a claim', () => {
		const f = reviewFacts(before, after)
		expect(f.lengthBeforeSec).toBe(8)
		expect(f.lengthAfterSec).toBeCloseTo(6.1)
		expect([f.itemsBefore, f.itemsAfter]).toEqual([3, 5])
	})

	it('finds the joins the edit made, which are the places to look', () => {
		expect(reviewFacts(before, after).newJoinsSec).toEqual([3, 6])
		// An untouched timeline has none.
		expect(reviewFacts(before, before).newJoinsSec).toEqual([])
	})

	it('finds a motion layer a cut left in pieces, but not one that was already short', () => {
		const f = reviewFacts(before, after)
		expect(f.motionFragments.map((s) => s.label)).toEqual(['card-2'])
		const alreadyShort = doc([layer('tick', 0, 0.5)])
		expect(reviewFacts(alreadyShort, alreadyShort).motionFragments).toEqual([])
	})

	it('finds slivers of footage too short to see', () => {
		const [sliver, ...rest] = reviewFacts(before, after).slivers
		expect(rest).toEqual([])
		expect(sliver).toMatchObject({ label: 'crumb', atSec: 6 })
		expect(sliver.durationSec).toBeCloseTo(0.1)
	})

	it('ignores titles, generators and motion layers when it looks for joins and slivers', () => {
		const titled = doc([clip('a', 0, 2), clip('t', 2, 0.1, { text: { content: 'x' } as any })])
		const f = reviewFacts(doc([clip('a', 0, 2)]), titled)
		expect(f.newJoinsSec).toEqual([])
		expect(f.slivers).toEqual([])
	})
})

describe('reviewMessage', () => {
	const facts = reviewFacts(
		doc([clip('a', 0, 4), clip('b', 4, 4), layer('card', 2, 4)]),
		doc([clip('a', 0, 3), clip('b2', 3, 3), layer('card', 2, 1), layer('card-2', 3, 0.4)])
	)

	it('quotes what was measured and the request, then the checklist', () => {
		const text = reviewMessage({ request: 'Tighten the first minute', facts, revisions: ['V2'], lookedSinceEdit: false, round: 1 })
		expect(text).toMatch(/^\[FrameFlow review\]/)
		expect(text).toContain('0:08.0 before this turn, 0:06.0 now (−2.0 s)')
		expect(text).toContain('Revisions this turn: V2')
		expect(text).toContain('look at both sides of each): 0:03.0')
		expect(text).toContain('"card-2" at 0:03.0')
		expect(text).toContain('You have not looked at a frame since your last edit.')
		expect(text).toContain('"Tighten the first minute"')
		expect(text).toMatch(/render_frames at the new joins/)
		expect(text).toMatch(/with the measured numbers above, not estimates/)
	})

	it('says plainly when there is nothing to fix', () => {
		const clean = reviewFacts(doc([clip('a', 0, 4)]), doc([clip('a', 0, 4)]))
		const text = reviewMessage({ request: 'x', facts: clean, revisions: [], lookedSinceEdit: true, round: 1 })
		expect(text).toContain('No new joins between clips.')
		expect(text).toContain('No motion layer was left in pieces.')
		expect(text).not.toContain('have not looked')
	})

	it('a second review says why it came back', () => {
		expect(reviewMessage({ request: 'x', facts, revisions: [], lookedSinceEdit: true, round: 2 })).toMatch(/^\[FrameFlow review, again\]/)
	})

	it('the working checklist ends in a measured answer', () => {
		expect(WORKING_CHECKLIST).toMatch(/render_frames at each place you changed/)
		expect(WORKING_CHECKLIST).toMatch(/Answer with what you measured/)
	})
})
