import { describe, expect, it } from 'vitest'
import {
	bridgeGap, clipSourceTime, clipTimelineTime, fillGaps, groupPeople, measuredFps, objectLost, thinSamples, trackAt, trackOnClip, trackSpans,
	TrackletLinker, type TrackSample
} from './tracking'

const face = (cx: number, cy: number, size = 50) => ({ cx, cy, w: size, h: size })
const sample = (t: number, cx = 0.5, extra: Partial<TrackSample> = {}): TrackSample => ({ t, cx, cy: 0.5, w: 0.1, h: 0.1, score: 0.9, ...extra })
/** A unit vector pointing mostly along axis `axis`, nudged by `noise` along the next one. */
const look = (axis: number, noise = 0): number[] => {
	const v = [0, 0, 0, 0]
	v[axis] = 1
	v[(axis + 1) % 4] = noise
	const n = Math.hypot(...v)
	return v.map((x) => x / n)
}

describe('joining faces into runs', () => {
	it('keeps two faces apart as they drift', () => {
		const linker = new TrackletLinker()
		const a = linker.step([face(100, 100), face(400, 100)])
		const b = linker.step([face(410, 104), face(108, 102)])
		expect(b).toEqual([a[1], a[0]])
	})

	it('ends a run instead of jumping to a face that is too far away', () => {
		const linker = new TrackletLinker()
		const [first] = linker.step([face(100, 100)])
		const [second] = linker.step([face(300, 100)])
		expect(second).not.toBe(first)
	})

	it('follows a face through a camera swing when told how far the picture moved', () => {
		const linker = new TrackletLinker()
		const [first] = linker.step([face(100, 100)])
		const [swung] = linker.step([face(300, 100)], { dx: 200, dy: 0 })
		expect(swung).toBe(first)
	})

	it('does not take a much larger face for the same one', () => {
		const linker = new TrackletLinker()
		const [small] = linker.step([face(100, 100, 40)])
		const [large] = linker.step([face(102, 100, 120)])
		expect(large).not.toBe(small)
	})

	it('survives two missed frames, not three', () => {
		const held = new TrackletLinker()
		const [a] = held.step([face(100, 100)])
		held.step([]); held.step([])
		expect(held.step([face(104, 100)])[0]).toBe(a)

		const dropped = new TrackletLinker()
		const [b] = dropped.step([face(100, 100)])
		dropped.step([]); dropped.step([]); dropped.step([])
		expect(dropped.step([face(104, 100)])[0]).not.toBe(b)
	})

	it('gives one face to one run when two runs want it', () => {
		const linker = new TrackletLinker()
		const [a, b] = linker.step([face(100, 100), face(130, 100)])
		const next = linker.step([face(112, 100)])
		expect([a, b]).toContain(next[0])
		expect(linker.step([face(113, 100), face(131, 100)]).sort()).toEqual([a, b].sort())
	})
})

describe('merging runs into people', () => {
	it('joins runs that look alike and keeps the others apart', () => {
		const people = groupPeople([
			{ id: 0, frames: [0, 1, 2, 3], embeddings: [look(0)] },
			{ id: 1, frames: [10, 11], embeddings: [look(0, 0.2)] },
			{ id: 2, frames: [20, 21, 22], embeddings: [look(2)] }
		])
		expect(people).toEqual([[0, 1], [2]])
	})

	it('never joins two runs that were on screen together, however alike', () => {
		const people = groupPeople([
			{ id: 0, frames: [0, 1, 2], embeddings: [look(0)] },
			{ id: 1, frames: [2, 3], embeddings: [look(0)] }
		])
		expect(people).toHaveLength(2)
	})

	it('does not let a third run bridge two people who were on screen together', () => {
		const people = groupPeople([
			{ id: 0, frames: [0, 1, 2, 3, 4], embeddings: [look(0)] },
			{ id: 1, frames: [0, 1, 2], embeddings: [look(0, 0.5)] },
			{ id: 2, frames: [10, 11], embeddings: [look(0, 0.1)] }
		])
		expect(people).toEqual([[0, 2], [1]])
	})

	it('leaves a run with no usable look on its own', () => {
		const people = groupPeople([
			{ id: 0, frames: [0, 1, 2], embeddings: [look(0)] },
			{ id: 1, frames: [5, 6], embeddings: [] }
		])
		expect(people).toEqual([[0], [1]])
	})

	it('lists the person seen longest first', () => {
		const people = groupPeople([
			{ id: 0, frames: [0], embeddings: [look(0)] },
			{ id: 1, frames: [1, 2, 3], embeddings: [look(2)] }
		])
		expect(people[0]).toEqual([1])
	})
})

describe('when the follower has lost the object', () => {
	it('does not believe an answer the follower itself barely believes', () => {
		expect(objectLost({ w: 0.1, h: 0.1, score: 0.05 }, { w: 0.1, h: 0.1 })).toBe(true)
	})

	it('believes a confident answer the same size as before', () => {
		expect(objectLost({ w: 0.1, h: 0.1, score: 0.9 }, { w: 0.1, h: 0.1 })).toBe(false)
	})

	it('doubts a box that suddenly became several times larger, however sure the follower is', () => {
		expect(objectLost({ w: 0.3, h: 0.4, score: 0.9 }, { w: 0.1, h: 0.1 })).toBe(true)
	})

	it('doubts a box that collapsed to a fraction of its size', () => {
		expect(objectLost({ w: 0.04, h: 0.04, score: 0.9 }, { w: 0.1, h: 0.1 })).toBe(true)
	})

	it('still follows an object that shrinks steadily as the camera pulls back', () => {
		let believed = { w: 0.2, h: 0.2 }
		for (let frame = 0; frame < 40; frame++) {
			const next = { w: believed.w * 0.97, h: believed.h * 0.97, score: 0.6 }
			expect(objectLost(next, believed)).toBe(false)
			believed = next
		}
		expect(believed.w).toBeLessThan(0.07)
	})

	it('doubts a box of no size', () => {
		expect(objectLost({ w: 0, h: 0.1, score: 0.9 }, { w: 0.1, h: 0.1 })).toBe(true)
	})
})

describe('across a gap the detector could not see', () => {
	// Seen at 1.00 on the left and again at 1.20 on the right; four frames in between at 25 fps.
	const before = sample(1, 0.2), after = sample(1.2, 0.4)
	const guess = (t: number, cx: number, score = 0.8) => ({ t, cx, cy: 0.5, score })
	const times = [1.04, 1.08, 1.12, 1.16]

	it('blends two followers that agree, leaning to the one that started nearer', () => {
		const forward = times.map((t) => guess(t, 0.2 + (t - 1)))
		const backward = times.map((t) => guess(t, 0.22 + (t - 1)))
		const out = bridgeGap(before, after, forward, backward, 25)
		expect(out.map((s) => +s.t.toFixed(2))).toEqual(times)
		expect(out.every((s) => s.bridged)).toBe(true)
		expect(out[0].cx).toBeCloseTo(0.24 + 0.02 * 0.2, 3)
		expect(out[3].cx).toBeCloseTo(0.36 + 0.02 * 0.8, 3)
	})

	it('leaves a frame open when the two followers are on different things', () => {
		const forward = times.map((t) => guess(t, 0.2))
		const backward = times.map((t) => guess(t, 0.7))
		expect(bridgeGap(before, after, forward, backward, 25)).toEqual([])
	})

	it('takes the one that is clearly sure when they disagree', () => {
		const out = bridgeGap(before, after, [guess(1.08, 0.2, 0.9)], [guess(1.08, 0.7, 0.45)], 25)
		expect(out).toHaveLength(1)
		expect(out[0].cx).toBe(0.2)
	})

	it('believes a lone follower only when it is sure', () => {
		expect(bridgeGap(before, after, [guess(1.04, 0.22, 0.7)], [], 25)).toHaveLength(1)
		expect(bridgeGap(before, after, [guess(1.04, 0.22, 0.4)], [], 25)).toEqual([])
	})

	it('never writes over the frames on either side of the gap', () => {
		const out = bridgeGap(before, after, [guess(1, 0.9), guess(1.2, 0.9)], [], 25)
		expect(out).toEqual([])
	})
})

describe('reading a track', () => {
	it('measures the frame rate from the samples, ignoring gaps', () => {
		expect(measuredFps([sample(0), sample(0.04), sample(0.08), sample(2), sample(2.04)])).toBe(25)
	})

	it('fills a short gap on a straight line and marks what it filled', () => {
		const filled = fillGaps([sample(0, 0.2), sample(0.16, 0.6)], 25)
		expect(filled.map((s) => +s.t.toFixed(2))).toEqual([0, 0.04, 0.08, 0.12, 0.16])
		expect(filled[2].cx).toBeCloseTo(0.4)
		expect(filled.map((s) => !!s.filled)).toEqual([false, true, true, true, false])
		expect(filled[1].score).toBe(0)
	})

	it('leaves a long gap open', () => {
		expect(fillGaps([sample(0), sample(1)], 25)).toHaveLength(2)
	})

	it('reports the unbroken stretches', () => {
		expect(trackSpans([sample(0), sample(0.04), sample(0.08), sample(1), sample(1.04)], 25)).toEqual([{ from: 0, to: 0.08 }, { from: 1, to: 1.04 }])
	})

	it('answers between two frames, and not inside a gap', () => {
		const track = { fps: 25, samples: [sample(0, 0.2), sample(0.04, 0.4), sample(1, 0.8)] }
		expect(trackAt(track, 0.02)!.cx).toBeCloseTo(0.3)
		expect(trackAt(track, 0.5)).toBeNull()
		expect(trackAt(track, 5)).toBeNull()
		expect(trackAt(track, 1)!.cx).toBe(0.8)
	})

	it('thins rows but keeps both ends of every stretch', () => {
		const samples = Array.from({ length: 26 }, (_, k) => sample(k / 25)).concat([sample(3), sample(3.04)])
		const thin = thinSamples(samples, 25, 0.5)
		expect(thin.map((s) => +s.t.toFixed(2))).toEqual([0, 0.52, 1, 3, 3.04])
	})
})

describe('a clip\'s time and the footage\'s time', () => {
	const clip = { timelineStart: 100, in: 10, out: 20, speed: 2, duration: 5 }

	it('maps both ways through the clip\'s start and speed', () => {
		expect(clipSourceTime(clip, 102)).toBe(14)
		expect(clipTimelineTime(clip, 14)).toBe(102)
		expect(clipTimelineTime(clip, 25)).toBeNull()
	})

	it('gives the part of a track a clip shows, on the timeline clock', () => {
		const on = trackOnClip([sample(9), sample(12), sample(18), sample(21)], clip)
		expect(on.map((s) => s.t)).toEqual([101, 104])
	})
})
