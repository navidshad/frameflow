import { describe, expect, it } from 'vitest'
import type { TimelineItem } from './types'
import {
	DEFAULT_TRANSITION_SEC,
	JUNCTION_GAP_EPS,
	MAX_TRANSITION_SEC,
	MIN_TRANSITION_SEC,
	findJunctions,
	junctionLimits,
	planTransition,
	planTransitions,
	sourceDurationsFrom,
	transitionAt,
	type Junction,
	type SourceDurations
} from './transitionPlan'

// ===== Fixtures =====

let seq = 0

/** One item on track v1. `in`/`out` are SOURCE seconds; duration follows speed. */
const clip = (start: number, over: Partial<TimelineItem> = {}): TimelineItem => {
	const inSec = over.in ?? 0
	const outSec = over.out ?? inSec + 10
	const speed = over.speed ?? 1
	return {
		id: over.id ?? `i${seq++}`,
		trackId: over.trackId ?? 'v1',
		sourceAssetId: over.sourceAssetId ?? 'a',
		timelineStart: start,
		in: inSec,
		out: outSec,
		speed,
		preservePitch: true,
		duration: (outSec - inSec) / speed,
		...over
	}
}

/**
 * Two butt-joined clips. `tail` is the source left after the outgoing clip's
 * out-point, `head` is the source before the incoming clip's in-point — the two
 * handle budgets every case here is really about.
 */
const seam = (opts: {
	tail?: number
	head?: number
	outDur?: number
	inDur?: number
	outSpeed?: number
	inSpeed?: number
}) => {
	const { tail = 0, head = 0, outDur = 10, inDur = 10, outSpeed = 1, inSpeed = 1 } = opts
	const a = clip(0, { id: 'A', sourceAssetId: 'srcA', in: 0, out: outDur * outSpeed, speed: outSpeed })
	const b = clip(outDur, {
		id: 'B', sourceAssetId: 'srcB',
		in: head * inSpeed, out: head * inSpeed + inDur * inSpeed, speed: inSpeed
	})
	const sources: SourceDurations = new Map([
		['srcA', a.out + tail * outSpeed],
		['srcB', b.out + 1000]
	])
	return { items: [a, b], a, b, sources }
}

const only = (items: TimelineItem[]): Junction => findJunctions(items)[0]
const dissolve = (duration = DEFAULT_TRANSITION_SEC) => ({ kind: 'fade', duration })

// ===== findJunctions =====

describe('findJunctions', () => {
	it('pairs adjacent items on the same track', () => {
		const { items } = seam({})
		const junctions = findJunctions(items)
		expect(junctions).toHaveLength(1)
		expect(junctions[0].outgoing.id).toBe('A')
		expect(junctions[0].incoming.id).toBe('B')
		expect(junctions[0].cut).toBeCloseTo(10, 6)
	})

	it('ignores a gap wider than the tolerance', () => {
		const items = [clip(0), clip(10 + JUNCTION_GAP_EPS * 2)]
		expect(findJunctions(items)).toEqual([])
	})

	it('pairs across a gap inside the tolerance', () => {
		const items = [clip(0), clip(10 + JUNCTION_GAP_EPS / 2)]
		expect(findJunctions(items)).toHaveLength(1)
	})

	it('never pairs across tracks', () => {
		const items = [clip(0, { trackId: 'v1' }), clip(10, { trackId: 'v2' })]
		expect(findJunctions(items)).toEqual([])
	})

	it('finds both seams in a run of three', () => {
		const items = [clip(0), clip(10), clip(20)]
		expect(findJunctions(items)).toHaveLength(2)
	})

	it('orders junctions by cut time whatever the input order', () => {
		const items = [clip(20, { id: 'c' }), clip(0, { id: 'a' }), clip(10, { id: 'b' })]
		expect(findJunctions(items).map((j) => j.cut)).toEqual([10, 20])
	})

	it('ignores an item with an inverted range', () => {
		const items = [clip(0, { in: 5, out: 5 }), clip(10)]
		expect(findJunctions(items)).toEqual([])
	})

	it('locates the cut through speed, not the stored duration', () => {
		// 20 source seconds at 2x = 10 on the timeline.
		const items = [clip(0, { in: 0, out: 20, speed: 2, duration: 999 }), clip(10)]
		expect(only(items).cut).toBeCloseTo(10, 6)
	})

	it('gives stable ids', () => {
		const { items } = seam({})
		expect(only(items).id).toBe('A->B')
	})

	it('returns nothing for a single item or an empty timeline', () => {
		expect(findJunctions([clip(0)])).toEqual([])
		expect(findJunctions([])).toEqual([])
	})
})

// ===== junctionLimits =====

describe('junctionLimits', () => {
	it('measures each handle from the unused source either side', () => {
		const { items, sources } = seam({ tail: 3, head: 2 })
		const limits = junctionLimits(only(items), sources)
		expect(limits.tailHandle).toBeCloseTo(3, 6)
		expect(limits.headHandle).toBeCloseTo(2, 6)
	})

	it('divides both handles by speed', () => {
		const { items, sources } = seam({ tail: 3, head: 2, outSpeed: 2, inSpeed: 2 })
		const limits = junctionLimits(only(items), sources)
		expect(limits.tailHandle).toBeCloseTo(3, 6)
		expect(limits.headHandle).toBeCloseTo(2, 6)
	})

	it('costs the tail handle but keeps the head handle when the asset is unprobed', () => {
		const { items } = seam({ tail: 3, head: 2 })
		const limits = junctionLimits(only(items), new Map())
		expect(limits.tailHandle).toBe(0)
		expect(limits.headHandle).toBeCloseTo(2, 6)
	})

	it('reports no tail handle rather than a negative one past the asset end', () => {
		// REGRESSION. applyTimelineDiff tolerates out slightly past the probed
		// duration, and a negative handle would invert the source range.
		const { items, a } = seam({ tail: 0 })
		const sources: SourceDurations = new Map([['srcA', a.out - 0.5]])
		expect(junctionLimits(only(items), sources).tailHandle).toBe(0)
	})

	it('reports no head handle when the clip starts at source zero', () => {
		const { items, sources } = seam({ head: 0 })
		expect(junctionLimits(only(items), sources).headHandle).toBe(0)
	})

	it('caps the longest window at half of each neighbour, summed', () => {
		const { items, sources } = seam({ tail: 99, head: 99, outDur: 3, inDur: 5 })
		expect(junctionLimits(only(items), sources).maxDuration).toBeCloseTo(1.5 + 2.5, 6)
	})

	it('caps the longest window at the ceiling', () => {
		const { items, sources } = seam({ tail: 99, head: 99, outDur: 60, inDur: 60 })
		expect(junctionLimits(only(items), sources).maxDuration).toBe(MAX_TRANSITION_SEC)
	})

	it('reports no freeze-free length when neither clip is trimmed', () => {
		const { items, sources } = seam({ tail: 0, head: 0 })
		expect(junctionLimits(only(items), sources).freeDuration).toBe(0)
	})

	it('bounds the freeze-free length by the clip too short to spend its handle', () => {
		// A is 1s long so it can give at most 0.5s, however much tail it owns.
		const { items, sources } = seam({ tail: 0, head: 10, outDur: 1, inDur: 60 })
		const limits = junctionLimits(only(items), sources)
		expect(limits.freeDuration).toBeCloseTo(0.5, 6)
	})
})

// ===== planTransition — geometry =====

describe('planTransition — geometry', () => {
	it('centres the window on the cut when both clips have handles to spare', () => {
		const { items, sources } = seam({ tail: 5, head: 5 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.duration).toBeCloseTo(2, 6)
		expect(w.front).toBeCloseTo(1, 6)
		expect(w.back).toBeCloseTo(1, 6)
		expect(w.start).toBeCloseTo(9, 6)
		expect(w.end).toBeCloseTo(11, 6)
	})

	it('clamps a request longer than the geometry allows', () => {
		const { items, sources } = seam({ tail: 99, head: 99, outDur: 2, inDur: 2 })
		expect(planTransition(only(items), dissolve(5), sources)!.duration).toBeCloseTo(2, 6)
	})

	it('clamps a request above the ceiling', () => {
		const { items, sources } = seam({ tail: 99, head: 99, outDur: 60, inDur: 60 })
		expect(planTransition(only(items), dissolve(30), sources)!.duration).toBe(MAX_TRANSITION_SEC)
	})

	it('degrades to a cut below the floor', () => {
		const { items, sources } = seam({ tail: 5, head: 5 })
		expect(planTransition(only(items), dissolve(MIN_TRANSITION_SEC / 2), sources)).toBeNull()
	})

	it('degrades to a cut when the clips are too short to reach the floor', () => {
		const { items, sources } = seam({ tail: 5, head: 5, outDur: 0.05, inDur: 0.05 })
		expect(planTransition(only(items), dissolve(2), sources)).toBeNull()
	})

	it('rejects a non-finite or non-positive request', () => {
		const { items, sources } = seam({ tail: 5, head: 5 })
		expect(planTransition(only(items), dissolve(Number.NaN), sources)).toBeNull()
		expect(planTransition(only(items), dissolve(0), sources)).toBeNull()
		expect(planTransition(only(items), dissolve(-1), sources)).toBeNull()
	})

	it('carries the preset kind through verbatim', () => {
		const { items, sources } = seam({ tail: 5, head: 5 })
		expect(planTransition(only(items), { kind: 'wipeleft', duration: 2 }, sources)!.kind).toBe('wipeleft')
	})
})

// ===== planTransition — where the repeated frames land =====

describe('planTransition — the freeze split', () => {
	it('repeats nothing when the handles cover the window', () => {
		const { items, sources } = seam({ tail: 5, head: 5 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.outgoing.freeze).toBe(0)
		expect(w.incoming.freeze).toBe(0)
	})

	it('repeats both sides equally when neither clip is trimmed', () => {
		// The beginner's timeline: two clips dragged straight in, no handles at all.
		const { items, sources } = seam({ tail: 0, head: 0 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.duration).toBeCloseTo(2, 6)
		expect(w.front).toBeCloseTo(1, 6)
		expect(w.outgoing.freeze).toBeCloseTo(1, 6)
		expect(w.incoming.freeze).toBeCloseTo(1, 6)
	})

	it('slides off centre rather than repeating frames it does not have to', () => {
		// REGRESSION. Clamping the centre into the GEOMETRIC range alone froze 1.0s
		// of the incoming clip while leaving 1.8s of the outgoing clip's tail handle
		// unused. The split must land on the freeze-minimising band first.
		const { items, sources } = seam({ tail: 1.8, head: 0 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.front).toBeCloseTo(0.2, 6)
		expect(w.back).toBeCloseTo(1.8, 6)
		expect(w.incoming.freeze).toBeCloseTo(0.2, 6)
		expect(w.outgoing.freeze).toBe(0)
	})

	it('mirrors the slide when the incoming clip is the trimmed one', () => {
		const { items, sources } = seam({ tail: 0, head: 1.8 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.front).toBeCloseTo(1.8, 6)
		expect(w.back).toBeCloseTo(0.2, 6)
		expect(w.outgoing.freeze).toBeCloseTo(0.2, 6)
		expect(w.incoming.freeze).toBe(0)
	})

	it('slides no further than it must', () => {
		// Ample handles both sides: it should stay centred, not chase the larger one.
		const { items, sources } = seam({ tail: 9, head: 4 })
		expect(planTransition(only(items), dissolve(2), sources)!.front).toBeCloseTo(1, 6)
	})

	it('repeats the same total however the split falls', () => {
		const { items, sources } = seam({ tail: 0.3, head: 0.2 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.outgoing.freeze + w.incoming.freeze).toBeCloseTo(2 - 0.3 - 0.2, 6)
	})

	it('reports exactly zero, not a float residue, when the handles match', () => {
		const { items, sources } = seam({ tail: 1, head: 1 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.outgoing.freeze).toBe(0)
		expect(w.incoming.freeze).toBe(0)
	})

	it('lets the geometry force a repeat past half the window', () => {
		// A is 3s long, so it can only give 1.5s of a 5s window and must hold the
		// rest. Documented as intended: hostile geometry, not a planner bug.
		const { items, sources } = seam({ tail: 0, head: 10, outDur: 3, inDur: 60 })
		const w = planTransition(only(items), dissolve(5), sources)!
		expect(w.front).toBeCloseTo(1.5, 6)
		expect(w.outgoing.freeze).toBeCloseTo(3.5, 6)
	})
})

// ===== planTransition — source ranges =====

describe('planTransition — source ranges', () => {
	it('reads the outgoing clip past its out-point into the tail handle', () => {
		const { items, sources, a } = seam({ tail: 5, head: 5 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.outgoing.in).toBeCloseTo(a.out - 1, 6)
		expect(w.outgoing.out).toBeCloseTo(a.out + 1, 6)
	})

	it('reads the incoming clip before its in-point into the head handle', () => {
		const { items, sources, b } = seam({ tail: 5, head: 5 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.incoming.in).toBeCloseTo(b.in - 1, 6)
		expect(w.incoming.out).toBeCloseTo(b.in + 1, 6)
	})

	it('maps the window through each clip speed', () => {
		const { items, sources, a, b } = seam({ tail: 5, head: 5, outSpeed: 2, inSpeed: 2 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.outgoing.in).toBeCloseTo(a.out - 2, 6)   // 1s of timeline = 2s of source
		expect(w.incoming.out).toBeCloseTo(b.in + 2, 6)
	})

	it('never seeks past the asset end or before source zero', () => {
		const { items, sources } = seam({ tail: 0, head: 0 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.outgoing.out).toBeLessThanOrEqual(sources.get('srcA')! + 1e-9)
		expect(w.incoming.in).toBeGreaterThanOrEqual(-1e-9)
	})

	it('never seeks outside its own trimmed range on the far side', () => {
		const { items, sources, a, b } = seam({ tail: 5, head: 5 })
		const w = planTransition(only(items), dissolve(2), sources)!
		expect(w.outgoing.in).toBeGreaterThanOrEqual(a.in - 1e-9)
		expect(w.incoming.out).toBeLessThanOrEqual(b.out + 1e-9)
	})

	it('has each side supply the whole window between played and repeated seconds', () => {
		const { items, sources } = seam({ tail: 0.4, head: 0 })
		const w = planTransition(only(items), dissolve(2), sources)!
		const played = (side: { in: number; out: number; item: TimelineItem }) =>
			(side.out - side.in) / (side.item.speed || 1)
		expect(played(w.outgoing) + w.outgoing.freeze).toBeCloseTo(w.duration, 6)
		expect(played(w.incoming) + w.incoming.freeze).toBeCloseTo(w.duration, 6)
	})
})

// ===== planTransition — invariants =====

describe('planTransition — invariants', () => {
	it('holds every safety property across a sweep of geometries', () => {
		for (const tail of [0, 0.2, 1.8, 5, 50]) {
			for (const head of [0, 0.2, 1.8, 5, 50]) {
				for (const outDur of [0.4, 1, 3, 10, 60]) {
					for (const inDur of [0.4, 1, 3, 10, 60]) {
						for (const requested of [0.1, 0.5, 2, 5, 30]) {
							const { items, sources, a, b } = seam({ tail, head, outDur, inDur })
							const junction = only(items)
							const w = planTransition(junction, dissolve(requested), sources)
							if (!w) continue

							expect(w.front + w.back).toBeCloseTo(w.duration, 9)
							expect(w.duration).toBeGreaterThanOrEqual(MIN_TRANSITION_SEC)
							expect(w.duration).toBeLessThanOrEqual(MAX_TRANSITION_SEC + 1e-9)
							// never past either clip's midpoint — what keeps windows disjoint
							expect(w.front).toBeLessThanOrEqual(outDur / 2 + 1e-9)
							expect(w.back).toBeLessThanOrEqual(inDur / 2 + 1e-9)
							// source reads stay inside the real media
							expect(w.outgoing.in).toBeGreaterThanOrEqual(a.in - 1e-9)
							expect(w.outgoing.out).toBeLessThanOrEqual(sources.get('srcA')! + 1e-9)
							expect(w.incoming.in).toBeGreaterThanOrEqual(-1e-9)
							expect(w.incoming.out).toBeLessThanOrEqual(b.out + 1e-9)
							// freeze is real, non-negative, and never exceeds the window
							expect(w.outgoing.freeze).toBeGreaterThanOrEqual(0)
							expect(w.incoming.freeze).toBeGreaterThanOrEqual(0)
							expect(w.outgoing.freeze).toBeLessThanOrEqual(w.duration + 1e-9)
							expect(w.incoming.freeze).toBeLessThanOrEqual(w.duration + 1e-9)
						}
					}
				}
			}
		}
	})

	it('is idempotent', () => {
		const { items, sources } = seam({ tail: 1.8, head: 0.3 })
		const first = planTransition(only(items), dissolve(2), sources)
		const second = planTransition(only(items), dissolve(2), sources)
		expect(first).toEqual(second)
	})
})

// ===== planTransitions =====

describe('planTransitions', () => {
	it('resolves an annotation on the outgoing clip', () => {
		const { items, sources } = seam({ tail: 5, head: 5 })
		items[0].transition = { out: dissolve(2) }
		const seams = planTransitions(items, sources)
		expect(seams).toHaveLength(1)
		expect(seams[0].window!.duration).toBeCloseTo(2, 6)
	})

	it('ignores an annotation on the incoming clip', () => {
		const { items, sources } = seam({ tail: 5, head: 5 })
		items[1].transition = { out: dissolve(2) }
		expect(planTransitions(items, sources)[0].window).toBeUndefined()
	})

	it('reports limits for every junction, annotated or not', () => {
		const { items, sources } = seam({ tail: 3, head: 2 })
		const seams = planTransitions(items, sources)
		expect(seams[0].window).toBeUndefined()
		expect(seams[0].limits.freeDuration).toBeCloseTo(5, 6)
	})

	it('keeps the request visible when it did not resolve to a window', () => {
		// Trimming the clips below the floor must not make the badge vanish silently.
		const { items, sources } = seam({ tail: 5, head: 5, outDur: 0.05, inDur: 0.05 })
		items[0].transition = { out: dissolve(2) }
		const seam0 = planTransitions(items, sources)[0]
		expect(seam0.requested).toBeDefined()
		expect(seam0.window).toBeUndefined()
	})

	it('ignores an annotation across a real gap', () => {
		const items = [clip(0, { id: 'A', transition: { out: dissolve(2) } }), clip(12)]
		expect(planTransitions(items, new Map())).toEqual([])
	})

	it('resolves both seams around one clip without them overlapping', () => {
		const a = clip(0, { id: 'A', transition: { out: dissolve(5) } })
		const b = clip(10, { id: 'B', transition: { out: dissolve(5) } })
		const c = clip(20, { id: 'C' })
		const windows = planTransitions([a, b, c], new Map()).map((s) => s.window!)
		expect(windows).toHaveLength(2)
		expect(windows[0].end).toBeLessThanOrEqual(windows[1].start + 1e-9)
	})
})

// ===== transitionAt =====

describe('transitionAt', () => {
	const built = () => {
		const { items, sources } = seam({ tail: 5, head: 5 })
		items[0].transition = { out: dissolve(2) }
		return planTransitions(items, sources)
	}

	it('ramps linearly across the window', () => {
		const seams = built()
		expect(transitionAt(seams, 9)!.progress).toBeCloseTo(0, 6)
		expect(transitionAt(seams, 10)!.progress).toBeCloseTo(0.5, 6)
		expect(transitionAt(seams, 10.5)!.progress).toBeCloseTo(0.75, 6)
	})

	it('includes the start instant and excludes the end instant', () => {
		const seams = built()
		expect(transitionAt(seams, 9)).not.toBeNull()
		expect(transitionAt(seams, 11)).toBeNull()
	})

	it('returns null outside every window and on an empty plan', () => {
		expect(transitionAt(built(), 3)).toBeNull()
		expect(transitionAt([], 3)).toBeNull()
	})

	it('does not assume the window is centred', () => {
		// An off-centre window's midpoint is NOT the cut — a player that assumed
		// otherwise would show the crossover in the wrong place.
		const { items, sources } = seam({ tail: 1.8, head: 0 })
		items[0].transition = { out: dissolve(2) }
		const seams = planTransitions(items, sources)
		expect(transitionAt(seams, 10)!.progress).toBeCloseTo(0.1, 6)
	})
})

// ===== sourceDurationsFrom =====

describe('sourceDurationsFrom', () => {
	it('maps asset id to its probed duration', () => {
		expect(sourceDurationsFrom([{ id: 'a', metadata: { duration: 12 } }]).get('a')).toBe(12)
	})

	it('omits an asset with no usable duration', () => {
		const map = sourceDurationsFrom([
			{ id: 'a' },
			{ id: 'b', metadata: {} },
			{ id: 'c', metadata: { duration: 0 } },
			{ id: 'd', metadata: { duration: Number.NaN } }
		])
		expect(map.size).toBe(0)
	})
})
