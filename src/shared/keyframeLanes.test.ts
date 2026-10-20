import { describe, expect, it } from 'vitest'
import type { TimelineItem } from './types'
import { normalise, valueAt, heldValueAt, type Keyframe, type KeyframeTracks } from './keyframes'
import { motionFrameState, type MotionSpec } from './motion'
import {
	addKey, adjacentKeyTime, applyEaseToLane, chooseSnap, deleteKeys, easeInto, emptyLaneText,
	formatKeyTime, heldSegments, itemLanes, keyIndex, keySnapCandidates, keyTimes, keyToPx,
	laneLayout, lanePath, laneRange, laneValueAt, mirrorEntranceOntoExit, motionPath, moveKeys,
	parseLaneValue, pruneSelection, pxToKey, sampleLane, selectKey, setEaseInto, setKeyValue,
	snapLabelAt, valueToY, wordsFromCues, CURVE_BOTTOM_PX, CURVE_TOP_PX, LANE_ROW_PX, type KeyRef
} from './keyframeLanes'

const motionItem = (spec: MotionSpec, duration = 4, extra: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'm1', trackId: 'tM', sourceAssetId: '',
	timelineStart: 3, in: 0, out: duration, speed: 1, preservePitch: true, duration,
	label: 'Lower third', motion: spec, ...extra
})

const clip = (extra: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'v1', trackId: 'tV', sourceAssetId: 'a1',
	timelineStart: 0, in: 0, out: 10, speed: 1, preservePitch: true, duration: 10,
	label: 'greeting_sara.mp4', ...extra
})

/** Board 2's opacity lane: in over 0.4s, hold, out over the last 0.4s. */
const fade: Keyframe[] = [
	{ t: 0, value: 0, ease: 'ease' },
	{ t: 0.4, value: 1, ease: 'linear' },
	{ t: 3.6, value: 1, ease: 'ease' },
	{ t: 4, value: 0 }
]

describe('itemLanes', () => {
	it('gives a motion layer board 2’s rows: Across, Down, Rotation, Opacity, then its own settings', () => {
		const lanes = itemLanes(motionItem({ template: 'lower-third' }))
		expect(lanes.map((l) => l.label)).toEqual(['Across', 'Down', 'Rotation', 'Opacity', 'Accent', 'Slide'])
		expect(lanes.filter((l) => l.own).map((l) => l.path)).toEqual(['motion.accent', 'motion.slide'])
		expect(lanes.find((l) => l.path === 'motion.accent')!.kind).toBe('color')
	})

	it('gives footage the transform and its gain, and audio only its gain — not motion-only', () => {
		expect(itemLanes(clip(), 'video').map((l) => l.path))
			.toEqual(['transform.x', 'transform.y', 'transform.rotation', 'gain'])
		expect(itemLanes(clip(), 'audio').map((l) => l.path)).toEqual(['gain'])
	})

	it('gives a title or a generated layer nothing to key', () => {
		expect(itemLanes(clip({ text: { content: 'Hi' } as TimelineItem['text'] }))).toEqual([])
		expect(itemLanes(clip({ generator: { kind: 'solid' } as TimelineItem['generator'] }))).toEqual([])
	})

	it('reads Across as each inspector does: a motion layer’s centre, a clip’s offset', () => {
		const onMotion = itemLanes(motionItem({ template: 'lower-third' }, 4, { transform: { x: 0, y: 0.28, scale: 1, rotation: 0 } }))
		expect(emptyLaneText(onMotion[1])).toBe('no keys · 78%')
		expect(emptyLaneText(onMotion[2])).toBe('no keys · 0°')
		const onClip = itemLanes(clip({ transform: { x: 0.25, y: 0, scale: 1, rotation: 0 } }), 'video')
		expect(emptyLaneText(onClip[0])).toBe('no keys · 25%')
	})
})

describe('lane geometry', () => {
	it('lays rows 26px apart', () => {
		const lanes = itemLanes(motionItem({ template: 'lower-third' }))
		const layout = laneLayout(lanes)
		expect(LANE_ROW_PX).toBe(26)
		expect(layout.height).toBe(6 * 26)
		expect(layout.rows[3]).toEqual({ path: 'opacity', top: 78 })
	})

	it('maps clip time to px and back through the clip’s start', () => {
		expect(keyToPx(3, 0.4, 140)).toBeCloseTo(476)
		expect(pxToKey(3, keyToPx(3, 0.4, 140), 140)).toBeCloseTo(0.4)
	})

	it('draws the top of the range at 5px and the bottom at 21px', () => {
		const opacity = itemLanes(motionItem({ template: 'lower-third' }))[3]
		const range = laneRange(opacity, fade)
		expect(valueToY(opacity, range, 1)).toBe(CURVE_TOP_PX)
		expect(valueToY(opacity, range, 0)).toBe(CURVE_BOTTOM_PX)
	})

	it('draws an unbounded number across its own keys, so a counter is not a flat line', () => {
		const value = itemLanes(motionItem({ template: 'stat-counter' })).find((l) => l.path === 'motion.value')!
		expect(laneRange(value, [{ t: 0, value: 0 }, { t: 1, value: 50 }])).toEqual({ min: 0, max: 50 })
	})
})

describe('sampleLane — the curve is the evaluator’s, not a lookalike', () => {
	const opacity = itemLanes(motionItem({ template: 'lower-third' }))[3]

	it('puts every sample exactly on valueAt', () => {
		for (const p of sampleLane(opacity, fade, 140)) {
			expect(p.value).toBe(valueAt(fade, p.t, 1))
		}
	})

	it('samples an eased run densely and a linear run only at its ends', () => {
		const points = sampleLane(opacity, fade, 140)
		const inEase = points.filter((p) => p.t >= 0 && p.t < 0.4)
		const inHold = points.filter((p) => p.t > 0.4 && p.t < 3.6)
		expect(inEase.length).toBeGreaterThanOrEqual(8)
		expect(inHold.length).toBe(1) // the run's far end, read just before the key
	})

	it('shows a hold as a step at the next key', () => {
		const held: Keyframe[] = [{ t: 0, value: 0, ease: 'hold' }, { t: 1, value: 1 }]
		const points = sampleLane(opacity, held, 100)
		expect(points.at(-2)!.value).toBe(0)
		expect(points.at(-1)).toEqual({ t: 1, value: 1 })
	})

	it('draws a held colour lane through heldValueAt, whatever ease a key carries', () => {
		const accent = itemLanes(motionItem({ template: 'lower-third' })).find((l) => l.path === 'motion.accent')!
		const keys: Keyframe[] = [{ t: 0, value: 0xec4899, ease: 'ease' }, { t: 2.6, value: 0x8b5cf6 }]
		for (const p of sampleLane(accent, keys, 140)) expect(p.value).toBe(heldValueAt(keys, p.t))
		expect(heldSegments(accent, keys, 4)).toEqual([
			{ start: 0, end: 2.6, value: 0xec4899, label: '#EC4899' },
			{ start: 2.6, end: 4, value: 0x8b5cf6, label: '#8B5CF6' }
		])
	})

	it('agrees with what the motion page is handed', () => {
		const item = motionItem({ template: 'lower-third' }, 4, { keyframes: { opacity: fade } })
		for (const u of [0, 0.1, 0.25, 0.4, 2, 3.7, 3.95]) {
			expect(laneValueAt(opacity, fade, u)).toBeCloseTo(motionFrameState(item, u).opacity, 6)
		}
	})

	it('emits an SVG path that starts on the first key', () => {
		const d = lanePath(opacity, fade, { clipStart: 3, pxPerSecond: 140, originPx: 280 })
		expect(d.startsWith('M140.00 21.00')).toBe(true)
		// …and ends on the last, at 3 + 4 = 7s → 980 − 280 = 700px.
		expect(d.endsWith('L700.00 21.00')).toBe(true)
	})
})

describe('selection', () => {
	const a: KeyRef = { path: 'opacity', t: 0.4 }
	const b: KeyRef = { path: 'opacity', t: 3.6 }

	it('click selects one; shift-click adds, and takes back out', () => {
		expect(selectKey([a], b, false)).toEqual([b])
		expect(selectKey([a], b, true)).toEqual([a, b])
		expect(selectKey([a, b], a, true)).toEqual([b])
	})

	it('knows which key of how many — “key 2 of 4”', () => {
		const found = keyIndex({ opacity: fade }, a)!
		expect(found.index + 1).toBe(2)
		expect(found.count).toBe(4)
	})

	it('drops refs to keys that are gone', () => {
		expect(pruneSelection([a, { path: 'opacity', t: 9 }], { opacity: fade })).toEqual([a])
	})
})

describe('edits replace, never mutate', () => {
	const tracks: KeyframeTracks = { opacity: fade }

	it('adds a key, keeping the curve’s ease, and leaves the input alone', () => {
		const frozen = JSON.stringify(tracks)
		const next = addKey(tracks, 'opacity', 2.001, 0.5)
		expect(next.opacity.map((k) => k.t)).toEqual([0, 0.4, 2, 3.6, 4])
		expect(next.opacity[2].ease).toBe('linear')
		expect(JSON.stringify(tracks)).toBe(frozen)
	})

	it('deletes the selected keys and drops an emptied lane', () => {
		expect(deleteKeys({ gain: [{ t: 1, value: 1 }] }, [{ path: 'gain', t: 1 }])).toBeUndefined()
		expect(deleteKeys(tracks, [{ path: 'opacity', t: 0 }])!.opacity).toHaveLength(3)
	})

	it('moves keys together and keeps the selection pointing at them', () => {
		const moved = moveKeys(tracks, [{ path: 'opacity', t: 0.4 }], 0.25, 4)
		expect(moved.tracks!.opacity.map((k) => k.t)).toEqual([0, 0.65, 3.6, 4])
		expect(moved.selection).toEqual([{ path: 'opacity', t: 0.65 }])
		expect(fade[1].t).toBe(0.4)
	})

	it('clamps a group move at the clip’s edges without squashing it', () => {
		const moved = moveKeys(tracks, [{ path: 'opacity', t: 0 }, { path: 'opacity', t: 0.4 }], -3, 4)
		expect(moved.delta).toBe(0)
		const late = moveKeys(tracks, [{ path: 'opacity', t: 3.6 }, { path: 'opacity', t: 4 }], 5, 4)
		expect(late.delta).toBe(0)
	})

	it('lets a moved key replace the one it lands on', () => {
		const moved = moveKeys(tracks, [{ path: 'opacity', t: 0.4 }], 3.2, 4)
		expect(moved.tracks!.opacity.map((k) => k.t)).toEqual([0, 3.6, 4])
		expect(moved.tracks!.opacity[1].value).toBe(1)
	})

	it('sets a value', () => {
		expect(setKeyValue(tracks, { path: 'opacity', t: 0.4 }, 0.5)!.opacity[1].value).toBe(0.5)
	})
})

describe('ease into a key', () => {
	const tracks: KeyframeTracks = { opacity: fade }

	it('reads the ease off the key before — the model stores it on the segment’s start', () => {
		expect(easeInto(tracks, { path: 'opacity', t: 0.4 })).toBe('ease')
		expect(easeInto(tracks, { path: 'opacity', t: 3.6 })).toBe('linear')
		expect(easeInto(tracks, { path: 'opacity', t: 0 })).toBeNull()
	})

	it('writes the ease onto the key before, so the curve arriving at this key changes', () => {
		const next = setEaseInto(tracks, { path: 'opacity', t: 0.4 }, 'hold')!
		expect(next.opacity[0].ease).toBe('hold')
		expect(valueAt(next.opacity, 0.39)).toBe(0)
		expect(setEaseInto(tracks, { path: 'opacity', t: 0 }, 'hold')).toBe(tracks)
	})

	it('applies one ease to the whole lane', () => {
		const next = applyEaseToLane(tracks, 'opacity', 'linear')!
		expect(next.opacity.every((k) => k.ease === 'linear')).toBe(true)
	})
})

describe('mirrorEntranceOntoExit', () => {
	it('reflects a fade-in onto the exit, exactly — board 2’s opacity lane', () => {
		const entrance: Keyframe[] = [{ t: 0, value: 0, ease: 'ease' }, { t: 0.4, value: 1, ease: 'linear' }]
		const mirrored = mirrorEntranceOntoExit(entrance, 4)
		expect(mirrored).toEqual(normalise(fade))
		for (const u of [0.05, 0.1, 0.2, 0.33]) {
			expect(valueAt(mirrored, 4 - u)).toBeCloseTo(valueAt(mirrored, u), 9)
		}
	})

	it('replaces whatever the exit had', () => {
		const keys: Keyframe[] = [{ t: 0, value: 0 }, { t: 0.5, value: 1 }, { t: 3.9, value: 0.2 }]
		expect(mirrorEntranceOntoExit(keys, 4).map((k) => [k.t, k.value]))
			.toEqual([[0, 0], [0.5, 1], [3.5, 1], [4, 0]])
	})

	it('does not double a key that sits on the middle', () => {
		const keys: Keyframe[] = [{ t: 0, value: 0 }, { t: 2, value: 1 }]
		expect(mirrorEntranceOntoExit(keys, 4).map((k) => k.t)).toEqual([0, 2, 4])
	})
})

describe('navigation', () => {
	it('steps to the previous and next key across the lanes', () => {
		const times = keyTimes({ opacity: fade, 'transform.x': [{ t: 1, value: 0 }] })
		expect(times).toEqual([0, 0.4, 1, 3.6, 4])
		expect(adjacentKeyTime(times, 0.4, 1)).toBe(1)
		expect(adjacentKeyTime(times, 0.4, -1)).toBe(0)
		expect(adjacentKeyTime(times, 4, 1)).toBeNull()
	})
})

describe('snapping', () => {
	const item = motionItem({ template: 'lower-third' }, 4)
	const candidates = keySnapCandidates({
		item,
		playhead: 10,
		others: [item, { id: 'v1', timelineStart: 0, duration: 40 }],
		markers: [{ time: 5 }],
		otherKeys: [0, 4],
		words: wordsFromCues([{ start: 3.62, text: 'Sara,' }, { start: 4.1, text: 'founder' }])
	})

	it('offers the moments, named after the window that owns them', () => {
		const moments = candidates.filter((c) => c.kind === 'moment')
		expect(moments.map((c) => [c.t, c.label])).toEqual([
			[3.4, 'moment “in” end'],
			[6.6, 'moment “out” start']
		])
	})

	it('offers cuts, markers, keys and words, but never the dragged clip’s own copy', () => {
		expect(candidates.filter((c) => c.kind === 'cut').map((c) => c.t)).toEqual([3, 7, 0, 40])
		expect(candidates.find((c) => c.kind === 'word')!.label).toBe('word “Sara”')
		expect(candidates.filter((c) => c.kind === 'key').map((c) => c.t)).toEqual([3, 7])
	})

	it('takes the nearest within the threshold, and nothing outside it', () => {
		expect(chooseSnap(3.43, candidates, 0.05)!.label).toBe('moment “in” end')
		expect(chooseSnap(3.64, candidates, 0.05)!.label).toBe('word “Sara”')
		expect(chooseSnap(3.5, candidates, 0.05)).toBeNull()
	})

	it('breaks a tie towards the playhead, then moments, keys, words', () => {
		const tie = [
			{ t: 1, kind: 'word' as const, label: 'word' },
			{ t: 1, kind: 'moment' as const, label: 'moment' }
		]
		expect(chooseSnap(1, tie, 0.1)!.kind).toBe('moment')
	})

	it('names what a resting key sits on — the inspector’s “Snapped to”', () => {
		expect(snapLabelAt(3.4, candidates)!.label).toBe('moment “in” end')
		expect(snapLabelAt(3.45, candidates)).toBeNull()
	})
})

describe('motionPath', () => {
	it('draws one point per position key, and each place once', () => {
		const x: Keyframe[] = [
			{ t: 0, value: -0.1 }, { t: 0.4, value: 0 }, { t: 3.6, value: 0 }, { t: 4, value: -0.1 }
		]
		const path = motionPath({ 'transform.x': x }, { x: 0, y: 0 }, { x: 0.15, y: 0.85 })
		expect(path.points).toHaveLength(4)
		expect(path.stops.map((s) => s.t)).toEqual([0, 0.4])
		expect(path.stops[0].x).toBeCloseTo(0.05)
		expect(path.stops[1].y).toBeCloseTo(0.85)
	})
})

describe('formatting and parsing', () => {
	it('formats timecodes as the board does', () => {
		expect(formatKeyTime(3.4)).toBe('0:03.4')
		expect(formatKeyTime(3.4, 2)).toBe('0:03.40')
		expect(formatKeyTime(64.25, 2)).toBe('1:04.25')
	})

	it('parses what a person types into the popover', () => {
		const lanes = itemLanes(motionItem({ template: 'lower-third' }))
		const byPath = (p: string) => lanes.find((l) => l.path === p)!
		expect(parseLaneValue(byPath('opacity'), '100%')).toBe(1)
		expect(parseLaneValue(byPath('transform.x'), '60%')).toBeCloseTo(0.1)
		expect(parseLaneValue(byPath('transform.rotation'), '−12°')).toBe(-12)
		expect(parseLaneValue(byPath('motion.slide'), '24px')).toBe(24)
		expect(parseLaneValue(byPath('motion.slide'), '999')).toBe(60)
		expect(parseLaneValue(byPath('motion.accent'), '#8b5cf6')).toBe(0x8b5cf6)
		expect(parseLaneValue(byPath('opacity'), 'lots')).toBeNull()
	})
})
