import { describe, expect, it } from 'vitest'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from '@shared/types'
import { DEFAULT_TRANSITION_SEC } from '@shared/transitionPlan'
import { computeRegions, fastPathMatchesFrame, isFastPathEligible } from './render'
import { allSlices, type OverlapRegion, type RegionPlan } from './renderBuilders'

// ===== Fixtures =====

const asset = (id: string, duration = 1000): MediaAsset => ({
	id, kind: 'video', name: `${id}.mp4`, originalPath: `/tmp/${id}.mp4`,
	metadata: { duration, width: 1920, height: 1080, fps: 30, hasAudio: true } as MediaAsset['metadata'],
	preprocessing: {}, clips: [], createdAt: 0
})

const track = (id: string, over: Partial<Track> = {}): Track => ({
	id, kind: 'video', name: id.toUpperCase(), order: 0,
	muted: false, locked: false, hidden: false, height: 72, ...over
})

let seq = 0

/** A clip on v1. `in`/`out` are SOURCE seconds; on-timeline duration follows speed. */
const item = (start: number, over: Partial<TimelineItem> = {}): TimelineItem => {
	const inSec = over.in ?? 0
	const outSec = over.out ?? inSec + 10
	const speed = over.speed ?? 1
	return {
		id: over.id ?? `it${seq++}`, trackId: over.trackId ?? 'v1',
		sourceAssetId: over.sourceAssetId ?? 'a',
		timelineStart: start, in: inSec, out: outSec, speed, preservePitch: true,
		duration: (outSec - inSec) / speed, ...over
	}
}

const doc = (over: Partial<EditorDocument> = {}): EditorDocument => ({
	schemaVersion: 1,
	media: over.media ?? [asset('a')],
	tracks: over.tracks ?? [track('v1')],
	timeline: over.timeline ?? [],
	timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 },
	activePersonaId: 'podcast-editor',
	turns: [],
	historyRef: { currentStepId: 'step-0', stepCount: 0 },
	...over
})

const plan = (over: Partial<EditorDocument> = {}): RegionPlan => computeRegions(doc(over), 'original')
const total = (p: RegionPlan) => p.regions.reduce((s, r) => s + r.duration, 0)
const kinds = (p: RegionPlan) => p.regions.map((r) => r.kind)
const overlaps = (p: RegionPlan) => p.regions.filter((r): r is OverlapRegion => r.kind === 'overlap')
const dissolve = (duration = DEFAULT_TRANSITION_SEC) => ({ out: { kind: 'fade', duration } })

/** Two butt-joined clips with handles either side, and a transition on the first. */
const withTransition = (opts: { tail?: number; head?: number; duration?: number } = {}) => {
	const { tail = 5, head = 5, duration = 2 } = opts
	const a = item(0, { id: 'A', sourceAssetId: 'sa', in: 0, out: 10, transition: dissolve(duration) })
	const b = item(10, { id: 'B', sourceAssetId: 'sb', in: head, out: head + 10 })
	return doc({
		media: [asset('sa', 10 + tail), asset('sb', head + 10 + 100)],
		timeline: [a, b]
	})
}

// ===== The partition invariant =====

describe('computeRegions — partition', () => {
	it('covers the whole timeline exactly', () => {
		const p = plan({ timeline: [item(0), item(10), item(20)] })
		expect(total(p)).toBeCloseTo(30, 6)
		expect(p.duration).toBeCloseTo(30, 6)
	})

	it('emits one region per clip and one per gap', () => {
		const p = plan({ timeline: [item(0), item(15)] })
		expect(p.regions).toHaveLength(3)   // clip, gap, clip
		expect(total(p)).toBeCloseTo(25, 6)
	})

	it('gives every slice the whole region on a timeline without transitions', () => {
		const p = plan({ timeline: [item(0), item(10)] })
		for (const region of p.regions) {
			for (const slice of allSlices(region)) {
				expect(slice.offset).toBe(0)
				expect(slice.duration).toBeCloseTo(region.duration, 6)
			}
		}
	})

	it('reports no overlap for an ordinary timeline', () => {
		expect(plan({ timeline: [item(0), item(10)] }).hasOverlap).toBe(false)
	})

	it('throws on an empty timeline', () => {
		expect(() => plan({ timeline: [] })).toThrow(/empty/i)
	})

	it('names every clip whose media is gone', () => {
		expect(() => plan({ timeline: [item(0, { sourceAssetId: 'ghost', label: 'Wide' })] }))
			.toThrow(/Wide/)
	})

	it('renders a legally-trimmed 50ms clip instead of dropping it', () => {
		// REGRESSION. The walker used to `continue` past any span <= 0.05s, and
		// MIN_ITEM_DURATION is exactly 0.05 — so a clip trimmed to the legal minimum
		// silently vanished from the export and the file came out short.
		const p = plan({ timeline: [item(0, { in: 0, out: 0.05 }), item(0.05)] })
		expect(total(p)).toBeCloseTo(10.05, 6)
	})
})

// ===== Overlap regions =====

describe('computeRegions — transitions', () => {
	it('emits one atomic overlap region per annotated junction', () => {
		const p = computeRegions(withTransition(), 'original')
		expect(kinds(p)).toEqual(['cut', 'overlap', 'cut'])
		expect(p.hasOverlap).toBe(true)
	})

	it('leaves the total duration untouched', () => {
		const withOut = plan({
			media: [asset('sa', 15), asset('sb', 115)],
			timeline: [
				item(0, { id: 'A', sourceAssetId: 'sa', in: 0, out: 10 }),
				item(10, { id: 'B', sourceAssetId: 'sb', in: 5, out: 15 })
			]
		})
		const withIn = computeRegions(withTransition(), 'original')
		expect(total(withIn)).toBeCloseTo(total(withOut), 6)
		expect(total(withIn)).toBeCloseTo(20, 6)
	})

	it('centres the window on the cut and shrinks its neighbours to meet it', () => {
		const p = computeRegions(withTransition({ duration: 2 }), 'original')
		expect(p.regions[0].duration).toBeCloseTo(9, 6)
		expect(p.regions[1].duration).toBeCloseTo(2, 6)
		expect(p.regions[2].duration).toBeCloseTo(9, 6)
		expect(overlaps(p)[0].cutAt).toBeCloseTo(1, 6)
	})

	it('carries both clips, each spanning the whole window', () => {
		const p = computeRegions(withTransition(), 'original')
		const region = overlaps(p)[0]
		expect(region.from.item.id).toBe('A')
		expect(region.to.item.id).toBe('B')
		expect(region.from.duration).toBeCloseTo(region.duration, 6)
		expect(region.to.duration).toBeCloseTo(region.duration, 6)
	})

	it('reads the outgoing clip past its out-point and the incoming before its in-point', () => {
		const region = overlaps(computeRegions(withTransition(), 'original'))[0]
		expect(region.from.out).toBeCloseTo(11, 6)   // 1s into A's tail handle
		expect(region.to.in).toBeCloseTo(4, 6)       // 1s into B's head handle
	})

	it('carries the preset kind', () => {
		const region = overlaps(computeRegions(withTransition(), 'original'))[0]
		expect(region.transition.kind).toBe('fade')
	})

	it('keeps the transitioning clips out of the mix bus', () => {
		// Their audio must be crossfaded, not amixed — mixing both at full level
		// is audible double-talk.
		const region = overlaps(computeRegions(withTransition(), 'original'))[0]
		expect(region.audioSources).toEqual([])
		expect(region.fromAudioActive).toBe(true)
		expect(region.toAudioActive).toBe(true)
	})

	it('repeats frames instead of refusing when neither clip is trimmed', () => {
		// The beginner's timeline. Degrading to a cut here would make the whole
		// feature look broken on the commonest project there is.
		const p = computeRegions(withTransition({ tail: 0, head: 0 }), 'original')
		const region = overlaps(p)[0]
		expect(region.duration).toBeCloseTo(2, 6)
		expect(region.from.freezeTail).toBeCloseTo(1, 6)
		expect(region.to.freezeHead).toBeCloseTo(1, 6)
		expect(total(p)).toBeCloseTo(20, 6)
	})

	it('has each side cover the window between played and repeated seconds', () => {
		const region = overlaps(computeRegions(withTransition({ tail: 0.4, head: 0 }), 'original'))[0]
		for (const slice of [region.from, region.to]) {
			const played = (slice.out - slice.in) / (slice.item.speed || 1)
			expect(slice.freezeHead + played + slice.freezeTail).toBeCloseTo(region.duration, 6)
		}
	})

	it('ignores a transition annotated across a real gap', () => {
		const p = plan({
			timeline: [item(0, { id: 'A', transition: dissolve() }), item(14, { id: 'B' })]
		})
		expect(p.hasOverlap).toBe(false)
	})

	it('resolves two transitions around one clip', () => {
		const p = plan({
			media: [asset('a', 1000)],
			timeline: [
				item(0, { id: 'A', in: 100, out: 110, transition: dissolve() }),
				item(10, { id: 'B', in: 100, out: 110, transition: dissolve() }),
				item(20, { id: 'C', in: 100, out: 110 })
			]
		})
		expect(overlaps(p)).toHaveLength(2)
		expect(total(p)).toBeCloseTo(30, 6)
	})
})

// ===== Cut suppression and snapping =====

describe('computeRegions — boundaries', () => {
	it('does not let a music bed edge split the window', () => {
		// Atomicity under pressure: an xfade cannot start mid-ramp, so a bystander
		// starting inside the window must not become a region boundary.
		const base = withTransition()
		const p = computeRegions(doc({
			media: [...base.media, asset('music', 500)],
			tracks: [track('v1'), track('a1', { kind: 'audio', order: 0 })],
			timeline: [
				...base.timeline,
				item(9.4, { id: 'BED', trackId: 'a1', sourceAssetId: 'music', in: 0, out: 5 })
			]
		}), 'original')
		expect(overlaps(p)).toHaveLength(1)
		expect(overlaps(p)[0].duration).toBeCloseTo(2, 6)
		expect(total(p)).toBeCloseTo(20, 6)
	})

	it('gives a bystander starting inside the window a region-local offset', () => {
		const base = withTransition()
		const p = computeRegions(doc({
			media: [...base.media, asset('music', 500)],
			tracks: [track('v1'), track('a1', { kind: 'audio', order: 0 })],
			timeline: [
				...base.timeline,
				item(9.4, { id: 'BED', trackId: 'a1', sourceAssetId: 'music', in: 0, out: 5 })
			]
		}), 'original')
		const bed = overlaps(p)[0].audioSources.find((s) => s.item.id === 'BED')!
		expect(bed.offset).toBeCloseTo(0.4, 6)
		expect(bed.duration).toBeCloseTo(1.6, 6)
	})

	it('exports two same-track clips separated by less than the snap threshold', () => {
		// REGRESSION. Collapsing the two near-coincident edges leaves the second clip
		// starting inside the first's region. That used to throw "only partly covers
		// its region" on a perfectly ordinary timeline; the renderer now places it.
		const p = plan({ timeline: [item(0, { in: 0, out: 9.98 }), item(10)] })
		expect(total(p)).toBeCloseTo(20, 6)
		const late = p.regions.flatMap(allSlices).find((sl) => sl.offset > 0)!
		expect(late.offset).toBeCloseTo(0.02, 6)
	})

	it('gives a bed starting just after a clip ends a region-local offset', () => {
		// The audio half of the same collapse: without an offset the bed would be
		// rendered from the top of the region, ahead of the picture.
		const p = plan({
			media: [asset('a'), asset('music', 500)],
			tracks: [track('v1'), track('a1', { kind: 'audio', order: 0 })],
			timeline: [
				item(0, { in: 0, out: 9.98 }),
				item(10, { id: 'BED', trackId: 'a1', sourceAssetId: 'music', in: 0, out: 10 })
			]
		})
		const bed = p.regions.flatMap(allSlices).find((sl) => sl.item.id === 'BED')!
		expect(bed.offset).toBeCloseTo(0.02, 6)
		expect(total(p)).toBeCloseTo(20, 6)
	})

	it('snaps a near-coincident edge instead of dropping a sliver of the timeline', () => {
		// An item edge 20ms from a window edge would have produced a sub-SNAP_EPS
		// span, which the old walker deleted — shortening the export.
		const base = withTransition()
		const p = computeRegions(doc({
			media: [...base.media, asset('music', 500)],
			tracks: [track('v1'), track('a1', { kind: 'audio', order: 0 })],
			timeline: [
				...base.timeline,
				item(8.98, { id: 'BED', trackId: 'a1', sourceAssetId: 'music', in: 0, out: 5 })
			]
		}), 'original')
		expect(total(p)).toBeCloseTo(20, 6)
		for (const region of p.regions) expect(region.duration).toBeGreaterThan(0.05)
	})
})

// ===== Loud failures =====

describe('computeRegions — guards', () => {
	it('throws when another video track crosses a transition', () => {
		const base = withTransition()
		expect(() => computeRegions(doc({
			media: [...base.media],
			tracks: [track('v1'), track('v2', { order: 1 })],
			timeline: [...base.timeline, item(9.5, { id: 'PIP', trackId: 'v2', sourceAssetId: 'sb', in: 0, out: 2 })]
		}), 'original')).toThrow(/overlaps a transition/i)
	})

	it('throws rather than silently rendering one of two overlapping clips', () => {
		expect(() => plan({
			timeline: [item(0, { id: 'A', label: 'One' }), item(5, { id: 'B', label: 'Two' })]
		})).toThrow(/overlap/i)
	})
})

// ===== Sequence geometry =====

describe('computeRegions — sequence geometry', () => {
	it('takes the frame from the sequence when the project has one', () => {
		// This is what makes a 9:16 export from 16:9 footage possible at all.
		const p = plan({
			timeline: [item(0)],
			timelineMeta: { fps: 30, width: 1080, height: 1920, duration: 0, frameChosen: true }
		})
		expect([p.width, p.height]).toEqual([1080, 1920])
	})

	it('falls back to the largest source when the sequence has none', () => {
		// Nothing has ever written these fields, so every existing project takes
		// this branch and must render exactly as it did before.
		const p = plan({
			timeline: [item(0)],
			timelineMeta: { fps: 30, width: 0, height: 0, duration: 0 } as never
		})
		expect([p.width, p.height]).toEqual([1920, 1080])
	})

	it('keeps frame dimensions even', () => {
		const p = plan({
			timeline: [item(0)],
			timelineMeta: { fps: 30, width: 1081, height: 1921, duration: 0, frameChosen: true }
		})
		expect(p.width % 2).toBe(0)
		expect(p.height % 2).toBe(0)
	})
})

// ===== The fast path =====

describe('isFastPathEligible', () => {
	const gapless = [item(0, { id: 'A' }), item(10, { id: 'B' })]

	it('accepts a butt-joined single-source timeline', () => {
		expect(isFastPathEligible(gapless, track('v1'))).toBe(true)
	})

	it('rejects a timeline carrying an outgoing transition', () => {
		// REGRESSION. assembleVideo has no blend, so without this the commonest
		// timeline a beginner applies a transition to exported hard cuts, with no
		// error and no log.
		const items = [item(0, { id: 'A', transition: dissolve() }), item(10, { id: 'B' })]
		expect(isFastPathEligible(items, track('v1'))).toBe(false)
	})

	it('rejects a clip asked to fill a differently-shaped frame', () => {
		// assembleVideo emits no scale or crop filter at all, so a fill would come
		// out letterboxed at the source's own size with no error.
		const items = [item(0, { id: 'A', framing: { mode: 'fill', pan: 0.5 } }), item(10, { id: 'B' })]
		expect(isFastPathEligible(items, track('v1'))).toBe(false)
	})

	it('still accepts a clip explicitly set to fit', () => {
		// Fit IS what the fast path does, so it stays eligible.
		const items = [item(0, { id: 'A', framing: { mode: 'fit' } }), item(10, { id: 'B' })]
		expect(isFastPathEligible(items, track('v1'))).toBe(true)
	})

	it('rejects a timeline carrying an incoming transition', () => {
		const items = [item(0, { id: 'A' }), item(10, { id: 'B', transition: { in: { kind: 'fade', duration: 1 } } })]
		expect(isFastPathEligible(items, track('v1'))).toBe(false)
	})

	it('rejects the cases it always did', () => {
		expect(isFastPathEligible([], track('v1'))).toBe(false)
		expect(isFastPathEligible(gapless, track('v1'), true)).toBe(false)
		expect(isFastPathEligible(gapless, track('v1', { muted: true }))).toBe(false)
		expect(isFastPathEligible([item(0), item(10, { sourceAssetId: 'other' })], track('v1'))).toBe(false)
		expect(isFastPathEligible([item(0, { speed: 2 })], track('v1'))).toBe(false)
		expect(isFastPathEligible([item(0, { muted: true })], track('v1'))).toBe(false)
		expect(isFastPathEligible([item(0, { fadeInSec: 1 })], track('v1'))).toBe(false)
		expect(isFastPathEligible([item(5)], track('v1'))).toBe(false)          // leading gap
		expect(isFastPathEligible([item(0), item(15)], track('v1'))).toBe(false) // internal gap
	})
})

// ===== allSlices =====

describe('allSlices', () => {
	it('enumerates every slice of an ordinary region', () => {
		const p = plan({ timeline: [item(0)] })
		expect(allSlices(p.regions[0]).map((s) => s.item.id)).toHaveLength(2) // picture + its own audio
	})

	it('enumerates the transitioning pair, so neither escapes the pre-flight', () => {
		const region = overlaps(computeRegions(withTransition(), 'original'))[0]
		expect(allSlices(region).map((s) => s.item.id).sort()).toEqual(['A', 'B'])
	})
})

describe('fastPathMatchesFrame', () => {
	// The fast path re-muxes the source untouched, so it can only serve a
	// sequence that already has the source's shape.
	const frame = { width: 1920, height: 1080 }

	it('accepts a source that already is the frame', () => {
		expect(fastPathMatchesFrame({ width: 1920, height: 1080 }, frame)).toBe(true)
	})

	it('declines a reframed sequence', () => {
		expect(fastPathMatchesFrame({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }))
			.toBe(false)
	})

	it('declines a source whose shape is unknown', () => {
		expect(fastPathMatchesFrame(undefined, frame)).toBe(false)
		expect(fastPathMatchesFrame({}, frame)).toBe(false)
	})
})
