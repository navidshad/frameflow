import { describe, expect, it } from 'vitest'
import type {
	Clip, EnrichedTimelineSegment, MediaAsset, TimelineDiff, TimelineItem, Track
} from './types'
import {
	MIN_ITEM_DURATION,
	TIMELINE_DIFF_SCHEMA_VERSION,
	applyTimelineDiff,
	clipsFromSegments,
	closeTimelineGaps,
	diffTimelines,
	findOverlaps,
	pruneOrphanItems,
	rippleAfterRemoval,
	rippleTimeline,
	segmentsToItems,
	solveTrim,
	srtToSeconds
} from './timeline'

const track = (id: string): Track => ({
	id, kind: 'video', name: id, order: 0, muted: false, locked: false, hidden: false, height: 72
})

/** Items of the given [start, duration] pairs on one track. */
const items = (spec: [number, number][], trackId = 'v1', assetId = 'a'): TimelineItem[] =>
	spec.map(([start, duration], i) => ({
		id: `${trackId}-${i}`, trackId, sourceAssetId: assetId,
		timelineStart: start, in: 0, out: duration, speed: 1, preservePitch: true, duration
	}))

const asset = (id: string, duration?: number): MediaAsset => ({
	id, kind: 'video', name: id, originalPath: `/tmp/${id}.mp4`,
	preprocessing: {}, clips: [], createdAt: 0,
	...(duration ? { metadata: { duration } as MediaAsset['metadata'] } : {})
})

const state = (spec: [number, number][], trackId = 'v1', assetId = 'a') => ({
	tracks: [track(trackId)],
	timeline: items(spec, trackId, assetId)
})

/** Writes a TrimSolution back onto a timeline, the way trimTick does. */
const applyTrim = (timeline: TimelineItem[], sol: NonNullable<ReturnType<typeof solveTrim>>) => {
	const byId = new Map(timeline.map((i) => [i.id, i]))
	const target = byId.get(sol.item.id)!
	Object.assign(target, {
		timelineStart: sol.item.timelineStart, in: sol.item.in,
		out: sol.item.out, duration: sol.item.duration
	})
	for (const s of sol.shifts) {
		const other = byId.get(s.id)
		if (other) other.timelineStart = s.timelineStart
	}
	return timeline
}

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

	it('never touches a locked track', () => {
		// A locked music bed reflowed to t=0 would fall out of sync with picture.
		const locked: Track = { ...track('a1'), locked: true }
		const timeline = [...items([[0, 10], [40, 10]], 'v1'), ...items([[30, 20]], 'a1')]
		closeTimelineGaps({ tracks: [track('v1'), locked], timeline })
		expect(starts(timeline.filter((i) => i.trackId === 'v1'))).toEqual([0, 10])
		expect(starts(timeline.filter((i) => i.trackId === 'a1'))).toEqual([30])
	})

	it('never touches a hidden track', () => {
		const hidden: Track = { ...track('a1'), hidden: true }
		const timeline = items([[30, 20]], 'a1')
		expect(closeTimelineGaps({ tracks: [hidden], timeline })).toBe(false)
		expect(starts(timeline)).toEqual([30])
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

	it('leaves pinned items where they are, but ripples the rest', () => {
		const all = items([[0, 10], [10, 10], [20, 10], [30, 10]])
		const removed = [all[0]]
		const survivors = all.slice(1)
		const changes = [{ trackId: 'v1', at: 0, delta: -10 }]
		expect(rippleTimeline(survivors, changes, new Set(['v1-3']))).toBe(true)
		// The first clip was removed, so the two unpinned survivors move up 10s;
		// the pinned one holds its position.
		expect(survivors.map((i) => [i.id, i.timelineStart])).toEqual([
			['v1-1', 0], ['v1-2', 10], ['v1-3', 30]
		])
	})

	it('only ripples within the same track', () => {
		const removed = items([[0, 10]], 'v1')
		const survivors = items([[20, 10]], 'a1')
		expect(rippleAfterRemoval(survivors, removed)).toBe(false)
		expect(starts(survivors)).toEqual([20])
	})
})

describe('solveTrim — head (left edge)', () => {
	it('moves the head and leaves the tail and the followers where they are', () => {
		const before = state([[0, 10], [10, 10]])
		const sol = solveTrim(before, 'v1-0', 'left', 3)!
		expect(sol.item).toMatchObject({ timelineStart: 3, in: 3, out: 10, duration: 7 })
		expect(sol.delta).toBeCloseTo(-3)
		expect(sol.shifts).toEqual([{ id: 'v1-1', timelineStart: 10 }])
	})

	it('stops at the previous clip, even though it is only ever shrinking', () => {
		const before = state([[0, 10], [10, 10]])
		before.timeline[1].in = 5
		before.timeline[1].out = 15
		const sol = solveTrim(before, 'v1-1', 'left', 2)!
		expect(sol.item.timelineStart).toBe(10)
		expect(sol.delta).toBeCloseTo(0)
	})

	it('never runs past the head of the source', () => {
		const before = state([[10, 6]])
		before.timeline[0].in = 4
		before.timeline[0].out = 10
		const sol = solveTrim(before, 'v1-0', 'left', 0)!
		expect(sol.item.timelineStart).toBeCloseTo(6)
		expect(sol.item.in).toBeCloseTo(0)
	})

	it('leaves at least MIN_ITEM_DURATION on the timeline', () => {
		const before = state([[0, 10]])
		const sol = solveTrim(before, 'v1-0', 'left', 100)!
		expect(sol.item.timelineStart).toBeCloseTo(10 - MIN_ITEM_DURATION)
	})

	it('honours speed when converting timeline seconds to source seconds', () => {
		const before = state([[0, 10]])
		before.timeline[0].speed = 2   // 10s of source plays in 5s
		const sol = solveTrim(before, 'v1-0', 'left', 2)!
		expect(sol.item.in).toBeCloseTo(4)
		expect(sol.item.duration).toBeCloseTo(3)
	})
})

describe('solveTrim — rippling head trim (the overlap bug)', () => {
	// REGRESSION. A head trim leaves the item's END fixed, so shifting the
	// followers by the duration delta pulled them UNDER the tail: trimming 3s
	// off the head of the middle clip used to leave it at [13,20] with the
	// follower at 17 — three seconds of genuine same-track overlap, which the
	// export silently dropped and a restart silently reverted.
	it('pins the head, pulls the tail in, and butts the follower against it', () => {
		const before = state([[0, 10], [10, 10], [20, 10]])
		const sol = solveTrim(before, 'v1-1', 'left', 13, { ripple: true })!
		expect(sol.item).toMatchObject({ timelineStart: 10, in: 3, out: 10, duration: 7 })
		expect(sol.delta).toBeCloseTo(-3)
		expect(sol.shifts).toEqual([{ id: 'v1-2', timelineStart: 17 }])
		// The item now ends exactly where the follower begins.
		expect(sol.item.timelineStart + sol.item.duration).toBeCloseTo(17)
	})

	it('grows the clip rightwards when the head is dragged earlier', () => {
		// Deliberately surprising but correct: the head is pinned, so restoring
		// trimmed-away source pushes the tail — and everything after it — right.
		const before = state([[0, 5], [10, 10], [20, 10]])
		before.timeline[1].in = 5
		before.timeline[1].out = 15
		const sol = solveTrim(before, 'v1-1', 'left', 7, { ripple: true })!
		expect(sol.item).toMatchObject({ timelineStart: 10, in: 2, duration: 13 })
		expect(sol.shifts).toEqual([{ id: 'v1-2', timelineStart: 23 }])
	})

	it('reports unshifted follower positions when not rippling', () => {
		// trimTick writes shifts unconditionally, so releasing Option mid-drag
		// puts the followers back instead of stranding them where they were.
		const before = state([[0, 10], [10, 10], [20, 10]])
		const sol = solveTrim(before, 'v1-1', 'left', 13, { ripple: false })!
		expect(sol.item.timelineStart).toBe(13)
		expect(sol.shifts).toEqual([{ id: 'v1-2', timelineStart: 20 }])
	})
})

describe('solveTrim — tail (right edge)', () => {
	it('rippling pulls everything downstream up by the freed time', () => {
		const before = state([[0, 10], [10, 10], [20, 10]])
		const sol = solveTrim(before, 'v1-0', 'right', 6, { ripple: true })!
		expect(sol.item).toMatchObject({ timelineStart: 0, in: 0, out: 6, duration: 6 })
		expect(sol.shifts).toEqual([
			{ id: 'v1-1', timelineStart: 6 }, { id: 'v1-2', timelineStart: 16 }
		])
	})

	it('stops at the next clip when not rippling', () => {
		const before = state([[0, 10], [10, 10]])
		const sol = solveTrim(before, 'v1-0', 'right', 15)!
		expect(sol.item.duration).toBeCloseTo(10)
		expect(sol.delta).toBeCloseTo(0)
	})

	it('never runs past the end of the source', () => {
		const before = state([[0, 10]])
		const sol = solveTrim(before, 'v1-0', 'right', 20, { sourceDuration: 12 })!
		expect(sol.item.out).toBeCloseTo(12)
	})

	it('does not shrink a clip whose out already exceeds the probed duration', () => {
		const before = state([[0, 10]])
		const sol = solveTrim(before, 'v1-0', 'right', 20, { sourceDuration: 8 })!
		expect(sol.item.out).toBeCloseTo(10)
	})
})

describe('solveTrim — contract', () => {
	it('is idempotent: the same pointer always yields the same layout', () => {
		const before = state([[0, 10], [10, 10], [20, 10]])
		const a = solveTrim(before, 'v1-1', 'left', 13, { ripple: true })
		const b = solveTrim(before, 'v1-1', 'left', 13, { ripple: true })
		expect(a).toEqual(b)
	})

	it('solving back at the original pointer restores the snapshot exactly', () => {
		const before = state([[0, 10], [10, 10], [20, 10]])
		solveTrim(before, 'v1-1', 'left', 18, { ripple: true })
		const back = solveTrim(before, 'v1-1', 'left', 10, { ripple: true })!
		expect(back.item).toMatchObject({ timelineStart: 10, in: 0, out: 10, duration: 10 })
		expect(back.shifts).toEqual([{ id: 'v1-2', timelineStart: 20 }])
		expect(back.delta).toBe(0)
	})

	it('returns null for an unknown item', () => {
		expect(solveTrim(state([[0, 10]]), 'nope', 'left', 1)).toBeNull()
	})

	it('returns null when the clamps leave no legal position', () => {
		// A clip already shorter than MIN_ITEM_DURATION has ceiling < floor.
		const before = state([[0, 0.02]])
		expect(solveTrim(before, 'v1-0', 'left', 0.01)).toBeNull()
	})

	it('never produces a same-track overlap, whatever the drag', () => {
		// This IS the restart-stability property: with no overlaps to repair,
		// the load-time repairOverlaps is a no-op and the project exports the
		// same before and after a restart.
		for (const edge of ['left', 'right'] as const) {
			for (const ripple of [false, true]) {
				for (const pointer of [-5, 0, 3, 9.99, 12, 17, 25, 60]) {
					const before = state([[0, 10], [10, 10], [20, 10]])
					const sol = solveTrim(before, 'v1-1', edge, pointer, { ripple })
					if (!sol) continue
					const after = applyTrim(items([[0, 10], [10, 10], [20, 10]]), sol)
					expect(findOverlaps({ tracks: [track('v1')], timeline: after }))
						.toEqual([])
				}
			}
		}
	})

	it('ignores items on other tracks', () => {
		const before = {
			tracks: [track('v1'), track('a1')],
			timeline: [...items([[0, 10], [10, 10]], 'v1'), ...items([[5, 10]], 'a1')]
		}
		const sol = solveTrim(before, 'v1-0', 'right', 6, { ripple: true })!
		expect(sol.shifts.map((s) => s.id)).toEqual(['v1-1'])
	})
})

describe('pruneOrphanItems', () => {
	it('drops items whose asset is gone and keeps the rest', () => {
		const s = state([[0, 10], [10, 10]])
		s.timeline[1].sourceAssetId = 'gone'
		const removed = pruneOrphanItems(s, new Set(['a']))
		expect(removed.map((i) => i.id)).toEqual(['v1-1'])
		expect(s.timeline.map((i) => i.id)).toEqual(['v1-0'])
	})

	it('does NOT ripple survivors — main purges the same way, so both agree', () => {
		const s = state([[0, 10], [10, 10]])
		s.timeline[0].sourceAssetId = 'gone'
		pruneOrphanItems(s, new Set(['a']))
		expect(s.timeline[0].timelineStart).toBe(10)
	})

	it('reassigns state.timeline, so a caller that forgets the write-back is caught', () => {
		const timeline = items([[0, 10]], 'v1', 'gone')
		const s = { tracks: [track('v1')], timeline }
		pruneOrphanItems(s, new Set(['a']))
		expect(s.timeline).toHaveLength(0)
		expect(timeline).toHaveLength(1)   // the caller's own array is untouched
	})

	it('leaves everything alone when every asset is present', () => {
		const s = state([[0, 10], [10, 10]])
		expect(pruneOrphanItems(s, new Set(['a']))).toEqual([])
		expect(s.timeline).toHaveLength(2)
	})

	it('sweeps every track', () => {
		const s = {
			tracks: [track('v1'), track('a1')],
			timeline: [...items([[0, 10]], 'v1', 'gone'), ...items([[0, 10]], 'a1', 'gone')]
		}
		expect(pruneOrphanItems(s, new Set(['a']))).toHaveLength(2)
		expect(s.timeline).toHaveLength(0)
	})

	it('mixes tracks and assets correctly', () => {
		const s = {
			tracks: [track('v1'), track('a1')],
			timeline: [...items([[0, 10]], 'v1', 'a'), ...items([[0, 10]], 'a1', 'gone')]
		}
		expect(pruneOrphanItems(s, new Set(['a'])).map((i) => i.trackId)).toEqual(['a1'])
		expect(s.timeline.map((i) => i.trackId)).toEqual(['v1'])
	})

	it('keeps an item whose sourceClipId dangles while its asset lives', () => {
		// A scene re-detect rebuilds every Clip id, and merged range items clear
		// sourceClipId on purpose — neither makes the item unrenderable.
		const s = state([[0, 10]])
		s.timeline[0].sourceClipId = 'a-clip-that-no-longer-exists'
		expect(pruneOrphanItems(s, new Set(['a']))).toEqual([])
	})

	it('drops everything when no assets remain', () => {
		const s = state([[0, 10], [10, 10]])
		expect(pruneOrphanItems(s, new Set())).toHaveLength(2)
		expect(s.timeline).toHaveLength(0)
	})
})

describe('applyTimelineDiff — media that left the project', () => {
	const add = (item: TimelineItem): TimelineDiff => ({
		schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION, addItems: [item]
	})

	it('rejects an add whose asset is not in the project, and names it', () => {
		const s = { tracks: [track('v1')], timeline: [] as TimelineItem[] }
		const result = applyTimelineDiff(s, add(items([[0, 10]], 'v1', 'gone')[0]), [asset('a')])
		expect(result.ok).toBe(false)
		expect(result.errors.join(' ')).toContain('gone')
		expect(s.timeline).toHaveLength(0)
	})

	it('still applies the other adds in the same diff', () => {
		const s = { tracks: [track('v1')], timeline: [] as TimelineItem[] }
		const good = items([[0, 10]], 'v1', 'a')[0]
		const bad = { ...items([[10, 10]], 'v1', 'gone')[0], id: 'bad' }
		applyTimelineDiff(s, {
			schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION, addItems: [bad, good]
		}, [asset('a')])
		expect(s.timeline.map((i) => i.id)).toEqual([good.id])
	})

	it('rejects nothing when the assets argument is omitted', () => {
		const s = { tracks: [track('v1')], timeline: [] as TimelineItem[] }
		expect(applyTimelineDiff(s, add(items([[0, 10]], 'v1', 'gone')[0])).ok).toBe(true)
		expect(s.timeline).toHaveLength(1)
	})

	it('still applies an update to an item whose asset is already missing', () => {
		// Adds only: a doc that predates the sweep must stay editable.
		const s = { tracks: [track('v1')], timeline: items([[0, 10]], 'v1', 'gone') }
		const result = applyTimelineDiff(s, {
			schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION,
			updateItems: [{ id: 'v1-0', timelineStart: 5 }]
		}, [asset('a')])
		expect(result.ok).toBe(true)
		expect(s.timeline[0].timelineStart).toBe(5)
	})

	it('still rejects an add whose out exceeds a known asset duration', () => {
		const s = { tracks: [track('v1')], timeline: [] as TimelineItem[] }
		const result = applyTimelineDiff(s, add(items([[0, 90]], 'v1', 'a')[0]), [asset('a', 60)])
		expect(result.ok).toBe(false)
		expect(s.timeline).toHaveLength(0)
	})

	it('undo cannot resurrect a removed asset’s clip', () => {
		// The full chain: an edit is recorded, the media is removed, the user
		// hits undo. diffTimelines stores a FULL item clone in the inverse.
		const tracks = [track('v1')]
		const before = { tracks, timeline: items([[0, 10]], 'v1', 'a') }
		const after = { tracks, timeline: [] as TimelineItem[] }
		const { inverse } = diffTimelines(before, after)!
		expect(inverse.addItems).toHaveLength(1)

		const doc = { tracks, timeline: [] as TimelineItem[] }
		const result = applyTimelineDiff(doc, inverse, [])   // asset 'a' is gone
		expect(doc.timeline).toHaveLength(0)
		expect(result.errors.join(' ')).toContain('a')
	})
})

describe('findOverlaps', () => {
	it('reports the offending pair', () => {
		expect(findOverlaps({ tracks: [track('v1')], timeline: items([[0, 10], [5, 10]]) }))
			.toEqual([['v1-0', 'v1-1']])
	})

	it('is silent on a contiguous track', () => {
		expect(findOverlaps({ tracks: [track('v1')], timeline: items([[0, 10], [10, 10]]) }))
			.toEqual([])
	})

	it('is silent on gaps', () => {
		expect(findOverlaps({ tracks: [track('v1')], timeline: items([[0, 10], [30, 10]]) }))
			.toEqual([])
	})

	it('does not compare across tracks', () => {
		const timeline = [...items([[0, 10]], 'v1'), ...items([[5, 10]], 'a1')]
		expect(findOverlaps({ tracks: [track('v1'), track('a1')], timeline })).toEqual([])
	})
})

// ===== Boundary: SRT strings <-> seconds =====

/** An EnrichedTimelineSegment from SRT endpoints. */
const seg = (
	index: number, start: string, end: string,
	extra?: Partial<EnrichedTimelineSegment>
): EnrichedTimelineSegment => ({
	index, start, end, text: `line ${index}`, duration: 0, visual: `visual ${index}`, ...extra
})

const clip = (id: string, inSec: number, outSec: number, assetId = 'a'): Clip => ({
	id, sourceAssetId: assetId, index: 1, in: inSec, out: outSec,
	duration: outSec - inSec, selected: false
})

describe('srtToSeconds', () => {
	it('parses SRT comma-milliseconds', () => {
		expect(srtToSeconds('00:01:02,500')).toBeCloseTo(62.5, 6)
	})

	it('parses MM:SS.mmm without an hours field', () => {
		expect(srtToSeconds('01:02.250')).toBeCloseTo(62.25, 6)
	})

	it('parses plain decimal seconds — the toFixed(3) form the editor export emits', () => {
		expect(srtToSeconds('12.500')).toBeCloseTo(12.5, 6)
	})

	it('parses bare integer seconds', () => {
		expect(srtToSeconds('7')).toBe(7)
	})

	it('parses a whole-hour timestamp', () => {
		expect(srtToSeconds('1:00:00')).toBe(3600)
	})

	it('tolerates surrounding whitespace', () => {
		expect(srtToSeconds(' 00:00:00,000 ')).toBe(0)
	})
})

describe('clipsFromSegments', () => {
	let n = 0
	const makeId = () => `c${n++}`
	const reset = () => { n = 0 }

	it('numbers clips 1..N positionally and converts endpoints to seconds', () => {
		reset()
		const clips = clipsFromSegments(
			[seg(1, '00:00:00,000', '00:00:10,000'), seg(2, '00:00:10,000', '00:00:25,500')],
			'asset-1', makeId
		)
		expect(clips.map((c) => c.index)).toEqual([1, 2])
		expect(clips[1].in).toBeCloseTo(10, 6)
		expect(clips[1].out).toBeCloseTo(25.5, 6)
		expect(clips[1].duration).toBeCloseTo(15.5, 6)
		expect(clips.every((c) => c.sourceAssetId === 'asset-1')).toBe(true)
		expect(clips.every((c) => c.selected === false)).toBe(true)
	})

	// runRetranscribeStep uses `every(c => c.masterSegmentIndex === undefined && c.text)`
	// as its "these pieces are mine to rebuild" marker. Setting it here would
	// silently downgrade Re-transcribe to a text-only refresh.
	it('leaves masterSegmentIndex undefined on every clip', () => {
		reset()
		const clips = clipsFromSegments(
			[seg(1, '0', '5'), seg(2, '5', '9')], 'asset-1', makeId
		)
		expect(clips.length).toBe(2)
		expect(clips.every((c) => c.masterSegmentIndex === undefined)).toBe(true)
	})

	it('clamps out to durationLimit and drops segments that start past it', () => {
		reset()
		const clips = clipsFromSegments(
			[seg(1, '0', '10'), seg(2, '10', '30'), seg(3, '40', '50')],
			'asset-1', makeId, { durationLimit: 20 }
		)
		expect(clips.length).toBe(2)
		expect(clips[1].out).toBe(20)
	})

	it('drops zero-length and inverted segments', () => {
		reset()
		const clips = clipsFromSegments(
			[seg(1, '5', '5'), seg(2, '9', '4'), seg(3, '0', '3')], 'asset-1', makeId
		)
		expect(clips.length).toBe(1)
		expect(clips[0].in).toBe(0)
	})

	it('drops the "no visual description" sentinel rather than storing it', () => {
		reset()
		const clips = clipsFromSegments(
			[seg(1, '0', '5', { visual: 'No visual description available.' }),
			 seg(2, '5', '9', { visual: 'a person at a whiteboard' })],
			'asset-1', makeId
		)
		expect(clips[0].visual).toBeUndefined()
		expect(clips[1].visual).toBe('a person at a whiteboard')
	})

	it('carries the transcript text through', () => {
		reset()
		const clips = clipsFromSegments([seg(1, '0', '5', { text: 'hello there' })], 'a', makeId)
		expect(clips[0].text).toBe('hello there')
	})
})

describe('segmentsToItems', () => {
	it('lays items back-to-back from zero with no gaps and no overlaps', () => {
		const items = segmentsToItems(
			[seg(1, '10', '20'), seg(2, '55', '60'), seg(3, '90', '99')],
			'v1', { assetId: 'a' }
		)
		expect(items.map((i) => i.timelineStart)).toEqual([0, 10, 15])
		expect(items.map((i) => i.duration)).toEqual([10, 5, 9])
		expect(findOverlaps({ tracks: [track('v1')], timeline: items })).toEqual([])
	})

	it('preserves source in/out while re-basing timelineStart', () => {
		const items = segmentsToItems([seg(1, '55', '60')], 'v1', { assetId: 'a' })
		expect(items[0].in).toBe(55)
		expect(items[0].out).toBe(60)
		expect(items[0].timelineStart).toBe(0)
	})

	it('donates sourceClipId when a clip matches the range', () => {
		const clips = [clip('clip-x', 10, 20), clip('clip-y', 55, 60)]
		const items = segmentsToItems([seg(1, '55', '60')], 'v1', { clips })
		expect(items[0].sourceClipId).toBe('clip-y')
		expect(items[0].sourceAssetId).toBe('a')
	})

	it('matches within epsilon, not exactly', () => {
		const clips = [clip('clip-x', 55.03, 60.02)]
		const items = segmentsToItems([seg(1, '55', '60')], 'v1', { clips })
		expect(items[0].sourceClipId).toBe('clip-x')
	})

	it('still yields a valid item when no clip matches', () => {
		const clips = [clip('clip-x', 0, 5)]
		const items = segmentsToItems([seg(1, '55', '60')], 'v1', { clips })
		expect(items.length).toBe(1)
		expect(items[0].sourceClipId).toBeUndefined()
		expect(items[0].in).toBe(55)
		expect(items[0].out).toBe(60)
		expect(items[0].speed).toBe(1)
		expect(items[0].preservePitch).toBe(true)
	})

	it('honours startAt', () => {
		const items = segmentsToItems([seg(1, '0', '5'), seg(2, '10', '13')], 'v1', {
			assetId: 'a', startAt: 100
		})
		expect(items.map((i) => i.timelineStart)).toEqual([100, 105])
	})

	it('skips segments with no asset to point at', () => {
		expect(segmentsToItems([seg(1, '0', '5')], 'v1')).toEqual([])
	})

	// The seeded timeline must clear the SAME validation the AI diff path must.
	it('produces items applyTimelineDiff accepts', () => {
		const items = segmentsToItems(
			[seg(1, '10', '20'), seg(2, '55', '60')], 'v1', { assetId: 'a' }
		)
		const target = { tracks: [track('v1')], timeline: [] as TimelineItem[] }
		const diff: TimelineDiff = {
			schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION,
			addItems: items
		}
		const result = applyTimelineDiff(target, diff, [asset('a', 120)])
		expect(result).toEqual({ ok: true, errors: [] })
		expect(target.timeline.length).toBe(2)
	})
})
