import { describe, expect, it } from 'vitest'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from '@shared/types'
import { DEFAULT_TRANSITION_SEC } from '@shared/transitionPlan'
import { computeRegions, fastPathMatchesFrame, isFastPathEligible, proxyFrameFor, regionConcurrency } from './render'
import { allSlices, type OverlapRegion, type RegionPlan } from './renderBuilders'
import { MOTION_MAX_FPS } from './render'
import { motionConcurrency } from '../motion'
import { stillFrameRange, rebasedSlice } from './exactMotion'
import { migrateProjectFrame, usedVideoSources } from '@shared/resolution'

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

	it('lets a camera cut that lands 30 ms after a layer edge render: the sliver holds a frame', () => {
		// A cut between two touching clips at 5.00 s, a layer on v2 ending at 4.97 s: the boundary set
		// collapses 5.00 into 4.97, so the region [4.97, 10] holds the last 30 ms of A as well as B.
		// Found exporting a multicam podcast with 26 motion layers over 228 camera cuts.
		const p = plan({
			tracks: [track('v1'), track('v2', { order: 1 })],
			timeline: [
				item(0, { id: 'A', in: 0, out: 5 }), item(5, { id: 'B', in: 20, out: 25 }),
				item(1, { id: 'L', trackId: 'v2', in: 0, out: 3.97 })
			]
		})
		expect(total(p)).toBeCloseTo(10, 6)
		const region = p.regions.find((r) => r.kind === 'cut' && r.videoLayers.some((l) => l.item.id === 'B'))!
		const b = (region as any).videoLayers.find((l: any) => l.item.id === 'B')
		expect(b.offset).toBe(0)
		expect(b.freezeHead).toBeCloseTo(0.03, 6)
		expect(b.freezeHead + (b.out - b.in) + b.freezeTail).toBeCloseTo(region.duration, 6)
	})

	it('throws rather than silently rendering one of two overlapping clips', () => {
		expect(() => plan({
			timeline: [item(0, { id: 'A', label: 'One' }), item(5, { id: 'B', label: 'Two' })]
		})).toThrow(/overlap/i)
	})
})

// ===== Titles are not a picture layer =====
//
// A title lives on a VIDEO track now that tracks come in two families. It burns
// over the finished file with the captions, so the compositor must not try to
// build a layer out of it: `toSlice` would look up its empty `sourceAssetId`
// and throw `Missing media asset`, which would fail the export of every project
// containing a title.

describe('computeRegions — titles', () => {
	const title = (start: number, over: Partial<TimelineItem> = {}) => item(start, {
		id: 'TTL', sourceAssetId: '', in: 0, out: 3,
		label: 'Chapter One', text: { content: 'Chapter One' }, ...over
	})

	it('does not build a layer from a title sharing the base track', () => {
		const p = plan({ timeline: [item(0, { in: 0, out: 10 }), title(10)] })
		expect(total(p)).toBeCloseTo(10, 5)
		expect(p.regions.flatMap(allSlices).some((s) => s.item.id === 'TTL')).toBe(false)
	})

	it('does not build a layer from a title on its own lane', () => {
		const p = computeRegions(doc({
			tracks: [track('v1'), track('t1', { name: 'T1', order: 1 })],
			timeline: [item(0, { in: 0, out: 10 }), title(2, { trackId: 't1' })]
		}), 'original')
		expect(total(p)).toBeCloseTo(10, 5)
		expect(p.regions.flatMap(allSlices).some((s) => s.item.id === 'TTL')).toBe(false)
	})

	it('leaves a title alone over a transition', () => {
		// The layer-crosses-a-transition guard is about pictures. A title crossing
		// a dissolve is ordinary, and refusing it would ban titles over cuts.
		const base = withTransition()
		expect(() => computeRegions(doc({
			media: [...base.media],
			tracks: [track('v1'), track('t1', { name: 'T1', order: 1 })],
			timeline: [...base.timeline, title(9.5, { trackId: 't1', out: 2 })]
		}), 'original')).not.toThrow()
	})

	it('refuses the fast path if a title reaches it as an item', () => {
		const items = [item(0, { in: 0, out: 10 })]
		expect(isFastPathEligible(items, track('v1'))).toBe(true)
		// The caller already filters titles out; this is the belt to that braces,
		// because the fast path re-muxes ONE source file and a title is not one.
		expect(isFastPathEligible([...items, title(10)], track('v1'))).toBe(false)
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

describe('the fast preview frame', () => {
	// A preview export reads 480p proxies. Rendering at the sequence's 4K would
	// upscale them and spend the encode on pixels with nothing in them.
	it('is 480 lines high with the width following the aspect, even', () => {
		expect(proxyFrameFor({ width: 3840, height: 2160 })).toEqual({ width: 854, height: 480 })
		expect(proxyFrameFor({ width: 1920, height: 1080 })).toEqual({ width: 854, height: 480 })
		expect(proxyFrameFor({ width: 1080, height: 1920 })).toEqual({ width: 270, height: 480 })
		expect(proxyFrameFor({ width: 1080, height: 1080 })).toEqual({ width: 480, height: 480 })
	})

	it('never makes a frame larger', () => {
		expect(proxyFrameFor({ width: 640, height: 360 })).toEqual({ width: 640, height: 360 })
	})

	const one = doc({ timeline: [item(0, { in: 0, out: 10 })] })

	it('is what the plan renders at when asked, and the full frame otherwise', () => {
		const small = computeRegions(one, 'preview', {}, { proxyFrame: true })
		expect([small.width, small.height]).toEqual([854, 480])
		const full = computeRegions(one, 'preview')
		expect([full.width, full.height]).toEqual([1920, 1080])
	})

	it('is drawn at the proxies\' frame rate, not the footage\'s', () => {
		// Proxies are made at no more than 30 fps; a 60 fps preview would draw
		// each frame twice, and every motion layer is captured frame by frame.
		const sixty = doc({
			media: [{ ...asset('a'), metadata: { duration: 1000, width: 3840, height: 2160, fps: 60, hasAudio: true } as MediaAsset['metadata'] }],
			timeline: [item(0, { in: 0, out: 10 })]
		})
		expect(computeRegions(sixty, 'preview', {}, { proxyFrame: true }).fps).toBe(30)
		expect(computeRegions(sixty, 'original').fps).toBe(60)
		expect(computeRegions(sixty, 'preview').fps).toBe(60)
	})

	it('lets the fast path serve a preview from the proxy, whose frame is that size', () => {
		const source = { width: 3840, height: 2160 }
		expect(fastPathMatchesFrame(source, { width: 854, height: 480 }, true)).toBe(true)
		expect(fastPathMatchesFrame(source, { width: 854, height: 480 })).toBe(false)
		expect(fastPathMatchesFrame(source, { width: 3840, height: 2160 }, true)).toBe(false)
	})

	it('renders regions in parallel only where the hardware encoder can take them', () => {
		expect(regionConcurrency()).toBe(process.platform === 'darwin' ? 3 : 1)
	})
})

describe('motion layers draw at no more than MOTION_MAX_FPS', () => {
	const sixty = (): EditorDocument => doc({
		media: [{ ...asset('a'), metadata: { duration: 1000, width: 3840, height: 2160, fps: 60, hasAudio: true } as MediaAsset['metadata'] }],
		tracks: [track('v1'), track('v2', { order: 1 })],
		timeline: [
			item(0, { in: 0, out: 10 }),
			item(2, { id: 'title', trackId: 'v2', sourceAssetId: '', in: 0, out: 4, duration: 4, motion: { template: 'lower-third' } })
		]
	})
	const motionSlice = (p: RegionPlan) => p.regions.flatMap(allSlices).find((s) => s.motion)!

	it('a 60 fps sequence draws its motion at 30, and keeps the sequence at 60', () => {
		const p = computeRegions(sixty(), 'original')
		expect(p.fps).toBe(60)
		expect(motionSlice(p).motion!.fps).toBe(MOTION_MAX_FPS)
	})

	it('leaves a sequence already at or below the cap as it was', () => {
		const slow = sixty()
		slow.media[0].metadata = { ...slow.media[0].metadata, fps: 24 } as MediaAsset['metadata']
		expect(motionSlice(computeRegions(slow, 'original')).motion!.fps).toBe(24)
	})

	it('the exact frame counts the clip\'s frames at the clip\'s own rate', () => {
		// A still at 2.0 s into the clip is frame 60 of a 30 fps clip, not of a 60 fps one.
		const slice = { ...motionSlice(computeRegions(sixty(), 'original')), in: 2, out: 2 + 1 / 60 }
		const range = stillFrameRange(slice, slice.motion!.fps)
		expect(range.first).toBe(59)
		expect(rebasedSlice(slice, range.first, slice.motion!.fps, '/s.mov').in).toBeCloseTo(2 - 59 / 30, 6)
	})

	it('draws fewer at once when the frame is big, where the main thread is the limit', () => {
		const job = (w: number, h: number) => ({ item: {} as any, frame: { width: w, height: h, fps: 30 }, outputPath: '/x.mov' })
		expect(motionConcurrency([job(854, 480)])).toBe(4)
		expect(motionConcurrency([job(1920, 1080)])).toBe(4)
		expect(motionConcurrency([job(3840, 2160)])).toBe(2)
	})
})

describe('a resolution choice', () => {
	const uhd = (): EditorDocument => doc({
		media: [{ ...asset('a'), metadata: { duration: 1000, width: 3840, height: 2160, fps: 60, hasAudio: true } as MediaAsset['metadata'] }],
		timeline: [item(0, { in: 0, out: 10 })]
	})

	it('scales the frame to that many lines and leaves the frame rate alone', () => {
		const p = computeRegions(uhd(), 'original', {}, { frameHeight: 1080 })
		expect([p.width, p.height, p.fps]).toEqual([1920, 1080, 60])
		const q = computeRegions(uhd(), 'original', {}, { frameHeight: 720 })
		expect([q.width, q.height]).toEqual([1280, 720])
	})

	it('never makes a frame larger than the project', () => {
		const p = computeRegions(doc({ timeline: [item(0, { in: 0, out: 10 })] }), 'original', {}, { frameHeight: 2160 })
		expect([p.width, p.height]).toEqual([1920, 1080])
	})

	it('is no longer the fast path\'s frame, so a smaller export takes the region path', () => {
		const p = computeRegions(uhd(), 'original', {}, { frameHeight: 1080 })
		expect(fastPathMatchesFrame({ width: 3840, height: 2160 }, p)).toBe(false)
	})
})


// ===== Project resolution =====

describe('computeRegions — project resolution and export size', () => {
	const uhd = (id = 'a'): MediaAsset => ({
		...asset(id),
		metadata: { duration: 1000, width: 3840, height: 2160, fps: 30, hasAudio: true } as MediaAsset['metadata']
	})
	const sized = (over: Partial<EditorDocument>, frameHeight?: number) =>
		computeRegions(doc(over), 'original', undefined, { frameHeight })
	const at = (p: RegionPlan) => [p.width, p.height]

	it('an old project with no chosen frame exports at its largest source, before and after migrating', () => {
		const old = doc({
			media: [uhd()], timeline: [item(0)],
			timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 } // the seeded literal nothing read
		})
		const before = computeRegions(old, 'original')
		expect(at(before)).toEqual([3840, 2160])

		const migrated = { ...old, timelineMeta: migrateProjectFrame(old.timelineMeta, usedVideoSources(old)) }
		expect(migrated.timelineMeta).toMatchObject({ width: 3840, height: 2160, frameChosen: true })
		expect(at(computeRegions(migrated, 'original'))).toEqual(at(before))
	})

	it('an old portrait phone project keeps its frame through the migration', () => {
		const phone: MediaAsset = {
			...asset('a'),
			metadata: { duration: 1000, width: 2160, height: 3840, fps: 30, hasAudio: true } as MediaAsset['metadata']
		}
		const old = doc({ media: [phone], timeline: [item(0)], timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 } })
		const before = computeRegions(old, 'original')
		const migrated = { ...old, timelineMeta: migrateProjectFrame(old.timelineMeta, usedVideoSources(old)) }
		expect(at(before)).toEqual([2160, 3840])
		expect(at(computeRegions(migrated, 'original'))).toEqual([2160, 3840])
	})

	it('renders a lower rung with the short side at that many lines', () => {
		const base = { media: [uhd()], timeline: [item(0)] }
		const landscape = { ...base, timelineMeta: { fps: 30, width: 3840, height: 2160, duration: 0, frameChosen: true } }
		expect(at(sized(landscape, 1440))).toEqual([2560, 1440])
		expect(at(sized(landscape, 1080))).toEqual([1920, 1080])
		expect(at(sized(landscape, 720))).toEqual([1280, 720])
		// Vertical: the rung is the SHORT side, so 1080p is 1080 wide, not 1080 tall.
		const vertical = { ...base, timelineMeta: { fps: 30, width: 2160, height: 3840, duration: 0, frameChosen: true } }
		expect(at(sized(vertical, 1080))).toEqual([1080, 1920])
		expect(at(sized(vertical, 1440))).toEqual([1440, 2560])
	})

	it('never upscales: a rung at or above the project size changes nothing', () => {
		const hd = { media: [asset('a')], timeline: [item(0)], timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0, frameChosen: true } }
		expect(at(sized(hd, 2160))).toEqual([1920, 1080])
		expect(at(sized(hd, 1080))).toEqual([1920, 1080])
	})
})
