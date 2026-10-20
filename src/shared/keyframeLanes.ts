/**
 * Keyframe lanes: everything the lane editor decides, with the components left
 * to draw it.
 *
 * The lanes are the manual surface for `shared/keyframes.ts` (board 2): one row
 * per property a selected clip can animate, its keys as diamonds and its value
 * drawn as a curve. Nothing here is a second model. Curves are sampled from
 * `valueAt` / `heldValueAt`, the same evaluators the monitor and the export
 * read, so what a lane draws is what renders.
 *
 * Every edit returns NEW key objects and new arrays. The undo diff compares
 * keyframes by value, and a mutated key would alias the snapshot it is
 * compared against.
 */
import type { MediaKind, TimelineItem } from './types'
import {
	heldValueAt, normalise, valueAt,
	type Ease, type Keyframe, type KeyframeTracks
} from './keyframes'
import {
	isKeyableSetting, keyedSettingValue, motionSettingPath, resolveDefinition,
	resolveMoments, sanitiseSetting, settingKeyValue, settingValues, OPACITY_PATH,
	type MotionSettingDef
} from './motion'
import { OFFSET_RANGE, TRANSFORM_DEFAULTS } from './transform'

// ===== Lanes =====

export type LaneKind = 'number' | 'color' | 'enum'

export interface LaneDef {
	/** The keyframe path: `transform.x`, `opacity`, `motion.slide`, `gain`. */
	path: string
	label: string
	/** A motion page's own setting — drawn pink, where every other lane is blue. */
	own: boolean
	kind: LaneKind
	/** The value with no keys, in stored units. */
	still: number
	/**
	 * The range the lane is drawn across, in DISPLAY units. `bounded` lanes
	 * always use it; an unbounded one (a counter's value) is drawn across its
	 * keys' own extent instead, or every curve would be a flat line.
	 */
	min: number
	max: number
	bounded: boolean
	/** Stored → what a person reads and drags: the motion layer's Across is 50% at rest. */
	toDisplay: (stored: number) => number
	fromDisplay: (display: number) => number
	format: (stored: number) => string
	/** Enum lanes only: the options, by index. */
	options?: { value: string; label: string }[]
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const pct = (v: number) => `${Math.round(v * 100)}%`
const identity = (v: number) => v

const numberPlaces = (step: number | undefined) =>
	step !== undefined && step < 1 ? Math.min(2, String(step).split('.')[1]?.length ?? 0) : 0

/** The settings a motion lane is built from: format and parse in its own units. */
function settingLane(s: MotionSettingDef, still: number): LaneDef {
	const path = motionSettingPath(s.key)
	if (s.type === 'color') {
		return {
			path, label: s.label, own: true, kind: 'color', still,
			min: 0, max: 0xffffff, bounded: true, toDisplay: identity, fromDisplay: identity,
			format: (v) => String(keyedSettingValue(s, v))
		}
	}
	if (s.type === 'enum') {
		const options = s.options ?? []
		return {
			path, label: s.label, own: true, kind: 'enum', still, options,
			min: 0, max: Math.max(1, options.length - 1), bounded: true, toDisplay: identity, fromDisplay: identity,
			format: (v) => options[clamp(Math.round(v), 0, options.length - 1)]?.label ?? '—'
		}
	}
	const min = Number.isFinite(s.min) ? s.min! : 0
	const max = Number.isFinite(s.max) ? s.max! : 1
	return {
		path, label: s.label, own: true, kind: 'number', still,
		min, max, bounded: max - min <= 1000,
		toDisplay: identity,
		fromDisplay: (v) => Number(sanitiseSetting(s, s.step ? Math.round(v / s.step) * s.step : v)),
		format: (v) => s.unit === '%' ? pct(v) : `${v.toFixed(numberPlaces(s.step))}${s.unit ?? ''}`
	}
}

/**
 * The lanes a clip gets, in board 2's order: Across, Down, Rotation, Opacity,
 * then a motion page's own keyable settings. Footage gets the transform and
 * its gain; an audio clip only its gain. Titles and generated backgrounds key
 * nothing in this build, so they get none — and the toggle says so.
 *
 * Across and Down mean the same position everywhere, but read differently: a
 * motion layer's inspector shows the layer's centre on the frame (50% = at
 * rest), a clip's shows its offset (0% = at rest). Each lane reads as its own
 * inspector does, so the two never disagree on screen.
 */
export function itemLanes(
	item: Pick<TimelineItem, 'motion' | 'text' | 'generator' | 'transform' | 'gain'>,
	mediaKind?: MediaKind
): LaneDef[] {
	if (item.text || item.generator) return []
	const transform = { ...TRANSFORM_DEFAULTS, ...item.transform }
	const motion = !!item.motion

	const position = (key: 'x' | 'y', label: string): LaneDef => motion
		? {
			path: `transform.${key}`, label, own: false, kind: 'number', still: transform[key],
			min: 0, max: 1, bounded: true,
			toDisplay: (v) => 0.5 + v,
			// Rounded, so a typed 40% is stored as −0.1, not −0.09999999999999998.
			fromDisplay: (d) => clamp(Math.round((d - 0.5) * 10000) / 10000, OFFSET_RANGE.min, OFFSET_RANGE.max),
			format: (v) => pct(0.5 + v)
		}
		: {
			path: `transform.${key}`, label, own: false, kind: 'number', still: transform[key],
			min: -1, max: 1, bounded: true,
			toDisplay: identity,
			fromDisplay: (d) => clamp(Math.round(d * 10000) / 10000, OFFSET_RANGE.min, OFFSET_RANGE.max),
			format: pct
		}
	const rotation: LaneDef = {
		// Drawn across its own keys: a 12° turn on a ±180° scale is a flat line.
		path: 'transform.rotation', label: 'Rotation', own: false, kind: 'number', still: transform.rotation,
		min: -180, max: 180, bounded: false, toDisplay: identity,
		fromDisplay: (d) => clamp(Math.round(d), -180, 180),
		format: (v) => `${Math.round(v)}°`
	}
	const gain: LaneDef = {
		path: 'gain', label: 'Gain', own: false, kind: 'number', still: item.gain ?? 1,
		min: 0, max: 2, bounded: true, toDisplay: identity,
		fromDisplay: (d) => clamp(Math.round(d * 100) / 100, 0, 2),
		format: (v) => `${v.toFixed(2)}×`
	}

	if (motion) {
		const def = resolveDefinition(item.motion)
		const values = settingValues(item.motion, def)
		const lanes: LaneDef[] = [
			position('x', 'Across'),
			position('y', 'Down'),
			rotation,
			{
				path: OPACITY_PATH, label: 'Opacity', own: false, kind: 'number', still: 1,
				min: 0, max: 1, bounded: true, toDisplay: identity,
				fromDisplay: (d) => clamp(Math.round(d * 10000) / 10000, 0, 1), format: pct
			}
		]
		for (const s of def.settings) {
			if (isKeyableSetting(s)) lanes.push(settingLane(s, settingKeyValue(s, values[s.key])))
		}
		return lanes
	}
	if (mediaKind === 'audio') return [gain]
	return [position('x', 'Across'), position('y', 'Down'), rotation, gain]
}

/** Whether a lane's keys hold rather than travel — its curve is a run of bars. */
export const isHeldLane = (lane: Pick<LaneDef, 'kind'>): boolean => lane.kind !== 'number'

/** The lane's value at clip time `u`, through the evaluator the export uses. */
export function laneValueAt(lane: LaneDef, keys: Keyframe[] | undefined, u: number): number {
	return isHeldLane(lane) ? heldValueAt(keys, u, lane.still) : valueAt(keys, u, lane.still)
}

/** "no keys · 78%" — what an empty lane says. */
export const emptyLaneText = (lane: LaneDef): string => `no keys · ${lane.format(lane.still)}`

// ===== Geometry =====

/** One lane row, as drawn on board 2. */
export const LANE_ROW_PX = 26
/** The curve's band inside a row: the highest value at 5px, the lowest at 21px. */
export const CURVE_TOP_PX = 5
export const CURVE_BOTTOM_PX = 21

/** Where the lanes block sits, and each row in it. */
export function laneLayout(lanes: readonly LaneDef[]): { height: number; rows: { path: string; top: number }[] } {
	return {
		height: lanes.length * LANE_ROW_PX,
		rows: lanes.map((l, i) => ({ path: l.path, top: i * LANE_ROW_PX }))
	}
}

/** Clip-local seconds → px from the timeline's origin. */
export const keyToPx = (clipStart: number, t: number, pxPerSecond: number): number =>
	(clipStart + t) * pxPerSecond

/** Px from the timeline's origin → clip-local seconds. */
export const pxToKey = (clipStart: number, px: number, pxPerSecond: number): number =>
	px / Math.max(1e-9, pxPerSecond) - clipStart

/** The display range a lane is drawn across, given its keys. */
export function laneRange(lane: LaneDef, keys: Keyframe[] | undefined): { min: number; max: number } {
	if (lane.bounded) return { min: lane.min, max: lane.max }
	const values = normalise(keys).map((k) => lane.toDisplay(k.value))
	if (!values.length) return { min: lane.min, max: lane.max }
	const lo = Math.min(...values)
	const hi = Math.max(...values)
	// A flat run still needs a band to sit in: centre it.
	if (hi - lo < 1e-9) return { min: lo - 1, max: hi + 1 }
	return { min: lo, max: hi }
}

/** A stored value → y inside its row. */
export function valueToY(lane: LaneDef, range: { min: number; max: number }, stored: number): number {
	const span = range.max - range.min
	const u = span > 1e-12 ? clamp((lane.toDisplay(stored) - range.min) / span, 0, 1) : 0.5
	return CURVE_BOTTOM_PX - u * (CURVE_BOTTOM_PX - CURVE_TOP_PX)
}

/**
 * The value curve between the first and last key, as clip-time/value points.
 *
 * Each segment is sampled through the lane's own evaluator — never a bezier
 * that merely looks like it. A linear run needs only its ends; an eased one a
 * point every couple of pixels; a hold its two ends and the jump at the next
 * key, which `valueAt` gives by being read a hair before that key.
 */
export function sampleLane(
	lane: LaneDef,
	keys: Keyframe[] | undefined,
	pxPerSecond: number
): { t: number; value: number }[] {
	const list = normalise(keys)
	if (list.length < 2) return list.map((k) => ({ t: k.t, value: k.value }))
	const at = (t: number) => laneValueAt(lane, list, t)
	const EPS = 1e-6
	const points: { t: number; value: number }[] = []
	for (let i = 0; i < list.length - 1; i++) {
		const a = list[i]
		const b = list[i + 1]
		const span = b.t - a.t
		const ease: Ease = isHeldLane(lane) ? 'hold' : (a.ease ?? 'linear')
		const steps = ease === 'ease' ? clamp(Math.ceil((span * pxPerSecond) / 2), 8, 200) : 1
		for (let s = 0; s < steps; s++) {
			const t = a.t + (span * s) / steps
			points.push({ t, value: at(t) })
		}
		// The end of the segment, read just before b so a hold shows its step.
		if (span > EPS) points.push({ t: b.t - EPS, value: at(b.t - EPS) })
	}
	const last = list[list.length - 1]
	points.push({ t: last.t, value: at(last.t) })
	return points
}

/** An SVG path through `sampleLane`'s points, in a lane row's coordinates. */
export function lanePath(
	lane: LaneDef,
	keys: Keyframe[] | undefined,
	options: { clipStart: number; pxPerSecond: number; originPx?: number }
): string {
	const range = laneRange(lane, keys)
	const origin = options.originPx ?? 0
	const points = sampleLane(lane, keys, options.pxPerSecond)
	return points.map((p, i) => {
		const x = keyToPx(options.clipStart, p.t, options.pxPerSecond) - origin
		const y = valueToY(lane, range, p.value)
		return `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`
	}).join(' ')
}

/**
 * A held lane as bars: each key's value from that key to the next, the last
 * running to the clip's end. A colour lane fills each bar with its colour.
 */
export function heldSegments(
	lane: LaneDef,
	keys: Keyframe[] | undefined,
	clipDuration: number
): { start: number; end: number; value: number; label: string }[] {
	const list = normalise(keys)
	return list.map((k, i) => {
		const end = i < list.length - 1 ? list[i + 1].t : Math.max(k.t, clipDuration)
		// Read through the evaluator at the bar's start, not off the key, so a
		// bar can never show a value the export would not.
		const value = laneValueAt(lane, list, k.t)
		return { start: k.t, end, value, label: lane.format(value) }
	}).filter((s) => s.end - s.start > 1e-9 || list.length === 1)
}

// ===== Selection =====

/** A key is named by its lane and time: keys are replaced on every edit, so an object identity would not survive one. */
export interface KeyRef {
	path: string
	t: number
}

const TIME_TOL = 0.0005

export const sameKey = (a: KeyRef, b: KeyRef): boolean =>
	a.path === b.path && Math.abs(a.t - b.t) < TIME_TOL

export const isSelected = (selection: readonly KeyRef[], ref: KeyRef): boolean =>
	selection.some((s) => sameKey(s, ref))

/**
 * Click selects one key; shift-click adds it, or takes it back out. The key
 * clicked last goes to the END, which makes it the primary one — the key the
 * popover and the inspector describe.
 */
export function selectKey(selection: readonly KeyRef[], ref: KeyRef, additive: boolean): KeyRef[] {
	if (!additive) return [{ ...ref }]
	if (isSelected(selection, ref)) return selection.filter((s) => !sameKey(s, ref))
	return [...selection, { ...ref }]
}

/** The selection with anything no longer on the item dropped — after undo, a delete, another clip. */
export function pruneSelection(selection: readonly KeyRef[], tracks: KeyframeTracks | undefined): KeyRef[] {
	return selection.filter((s) => normalise(tracks?.[s.path]).some((k) => Math.abs(k.t - s.t) < TIME_TOL))
}

/** Where a key sits in its lane: index and count, for "key 2 of 4". */
export function keyIndex(tracks: KeyframeTracks | undefined, ref: KeyRef): { index: number; count: number; key: Keyframe } | null {
	const list = normalise(tracks?.[ref.path])
	const index = list.findIndex((k) => Math.abs(k.t - ref.t) < TIME_TOL)
	return index < 0 ? null : { index, count: list.length, key: list[index] }
}

// ===== Edits =====

/** Key times are kept to a tenth of a millisecond: exact enough for a word, round enough to compare. */
const roundT = (t: number) => Math.round(t * 10000) / 10000

const copyTracks = (tracks: KeyframeTracks | undefined): KeyframeTracks =>
	Object.fromEntries(Object.entries(tracks ?? {}).map(([p, list]) => [p, list.map((k) => ({ ...k }))]))

/** Tracks with empty lanes removed — `undefined` when nothing is left, as the store stores it. */
export function tidyTracks(tracks: KeyframeTracks): KeyframeTracks | undefined {
	const out: KeyframeTracks = {}
	for (const [path, list] of Object.entries(tracks)) {
		if (list.length) out[path] = list
	}
	return Object.keys(out).length ? out : undefined
}

/** Add a key at `t`, or replace the one already there. Lands on a hundredth, as the inspector's ◆ does. */
export function addKey(tracks: KeyframeTracks | undefined, path: string, t: number, value: number): KeyframeTracks {
	const at = Math.max(0, Math.round(t * 100) / 100)
	const next = copyTracks(tracks)
	const list = normalise(next[path]).filter((k) => Math.abs(k.t - at) > 0.005)
	// A key added between two others travels the way the curve already did.
	const before = [...list].reverse().find((k) => k.t < at)
	next[path] = [...list, { t: at, value, ease: before?.ease ?? 'linear' }].sort((a, b) => a.t - b.t)
	return next
}

/** Every selected key removed. */
export function deleteKeys(tracks: KeyframeTracks | undefined, selection: readonly KeyRef[]): KeyframeTracks | undefined {
	const next = copyTracks(tracks)
	for (const path of Object.keys(next)) {
		next[path] = normalise(next[path]).filter((k) => !isSelected(selection, { path, t: k.t }))
	}
	return tidyTracks(next)
}

/**
 * Move the selected keys by `delta` seconds, together.
 *
 * The delta is clamped as a GROUP so the keys keep their spacing at the clip's
 * edges instead of piling up on 0. A moved key that lands on an unselected one
 * replaces it — two keys at one instant would be a jump nobody asked for.
 */
export function moveKeys(
	tracks: KeyframeTracks | undefined,
	selection: readonly KeyRef[],
	delta: number,
	clipDuration: number
): { tracks: KeyframeTracks | undefined; selection: KeyRef[]; delta: number } {
	const chosen = selection.filter((s) => normalise(tracks?.[s.path]).some((k) => Math.abs(k.t - s.t) < TIME_TOL))
	if (!chosen.length) return { tracks, selection: [...selection], delta: 0 }
	const lo = Math.min(...chosen.map((s) => s.t))
	const hi = Math.max(...chosen.map((s) => s.t))
	// `|| 0` folds a −0 into 0: a move that cannot move is no move.
	const d = clamp(delta, -lo, Math.max(-lo, clipDuration - hi)) || 0

	const next = copyTracks(tracks)
	const moved: KeyRef[] = []
	for (const path of Object.keys(next)) {
		const list = normalise(next[path])
		const going = list.filter((k) => isSelected(chosen, { path, t: k.t })).map((k) => ({ ...k, t: roundT(k.t + d) }))
		if (!going.length) continue
		const staying = list.filter((k) => !isSelected(chosen, { path, t: k.t }) &&
			!going.some((g) => Math.abs(g.t - k.t) < 0.005))
		next[path] = [...staying, ...going].sort((a, b) => a.t - b.t)
		moved.push(...going.map((k) => ({ path, t: k.t })))
	}
	// Keep the selection's order — the last one is still the primary key.
	const order = chosen.map((s) => moved.find((m) => m.path === s.path && Math.abs(m.t - roundT(s.t + d)) < TIME_TOL))
		.filter((m): m is KeyRef => !!m)
	return { tracks: tidyTracks(next), selection: order, delta: d }
}

/**
 * −1 / +1 frame: the grabbed (primary) key lands on the NEXT frame of the
 * sequence's own grid, and the rest of the selection moves with it. Stepping
 * by 1/fps and rounding each time would drift (0.4 + 3 × 1/30 → 0.4999); the
 * grid never does.
 */
export function nudgeKeys(
	tracks: KeyframeTracks | undefined,
	selection: readonly KeyRef[],
	frames: number,
	options: { fps: number; clipStart: number; clipDuration: number }
): { tracks: KeyframeTracks | undefined; selection: KeyRef[]; delta: number } {
	const primary = selection.at(-1)
	if (!primary || !options.fps) return { tracks, selection: [...selection], delta: 0 }
	const abs = options.clipStart + primary.t
	const frame = Math.round(abs * options.fps)
	// Off the grid already? The first step only lands on it. Keys keep times to
	// 0.1ms, so "on the grid" allows that much — far less than any frame.
	const onGrid = Math.abs(frame / options.fps - abs) < 5e-4
	const target = (onGrid ? frame + frames : frames > 0 ? Math.ceil(abs * options.fps) : Math.floor(abs * options.fps)) / options.fps
	return moveKeys(tracks, selection, target - abs, options.clipDuration)
}

/** One key's value replaced. */
export function setKeyValue(tracks: KeyframeTracks | undefined, ref: KeyRef, value: number): KeyframeTracks | undefined {
	const next = copyTracks(tracks)
	next[ref.path] = normalise(next[ref.path]).map((k) => Math.abs(k.t - ref.t) < TIME_TOL ? { ...k, value } : k)
	return tidyTracks(next)
}

/**
 * The ease INTO a key — the curve that arrives at it, which is what board 2's
 * "Ease into this key" names. The model stores ease on the key a segment
 * LEAVES (`Keyframe.ease`: "from THIS keyframe to the next"), so the ease into
 * key i lives on key i − 1. The first key has nothing arriving: `null`.
 */
export function easeInto(tracks: KeyframeTracks | undefined, ref: KeyRef): Ease | null {
	const list = normalise(tracks?.[ref.path])
	const i = list.findIndex((k) => Math.abs(k.t - ref.t) < TIME_TOL)
	return i > 0 ? (list[i - 1].ease ?? 'linear') : null
}

/** Set the ease into a key (on the key before it). The first key has none to set: unchanged. */
export function setEaseInto(tracks: KeyframeTracks | undefined, ref: KeyRef, ease: Ease): KeyframeTracks | undefined {
	const list = normalise(tracks?.[ref.path])
	const i = list.findIndex((k) => Math.abs(k.t - ref.t) < TIME_TOL)
	if (i <= 0) return tracks
	const next = copyTracks(tracks)
	next[ref.path] = list.map((k, j) => (j === i - 1 ? { ...k, ease } : { ...k }))
	return next
}

/** "Apply this ease to the whole lane": every segment on `path` travels the same way. */
export function applyEaseToLane(tracks: KeyframeTracks | undefined, path: string, ease: Ease): KeyframeTracks | undefined {
	const next = copyTracks(tracks)
	if (!next[path]) return tracks
	next[path] = normalise(next[path]).map((k) => ({ ...k, ease }))
	return next
}

/**
 * "Mirror entrance onto exit": the keys in the clip's first half, reflected
 * about its middle onto the second half, replacing whatever was there.
 *
 * A key at t lands at D − t with the same value, so a fade-in from 0 to 1 over
 * the first 0.4s becomes a fade-out from 1 to 0 over the last 0.4s. Easing is
 * carried with its SEGMENT: the segment a→b becomes the reflected b'→a', which
 * starts at b', so b' takes a's ease. Linear and ease are symmetric, so the
 * exit is an exact mirror; a hold cannot be — it still jumps at the far end.
 */
export function mirrorEntranceOntoExit(keys: Keyframe[] | undefined, clipDuration: number): Keyframe[] {
	const list = normalise(keys)
	const mid = clipDuration / 2
	const entrance = list.filter((k) => k.t <= mid + 1e-9)
	if (!entrance.length) return list.map((k) => ({ ...k }))
	const reflected: Keyframe[] = []
	for (let j = entrance.length - 1; j >= 0; j--) {
		const source = entrance[j]
		const t = roundT(clipDuration - source.t)
		// A key exactly on the middle is its own mirror.
		if (t <= mid + 1e-9 && entrance.some((e) => Math.abs(e.t - t) < 0.005)) continue
		reflected.push({ t, value: source.value, ease: j > 0 ? (entrance[j - 1].ease ?? 'linear') : 'linear' })
	}
	return [...entrance.map((k) => ({ ...k })), ...reflected].sort((a, b) => a.t - b.t)
}

// ===== Navigation =====

/** Every key time on these lanes, clip-local, sorted, each once. */
export function keyTimes(tracks: KeyframeTracks | undefined, paths?: readonly string[]): number[] {
	const times: number[] = []
	for (const [path, list] of Object.entries(tracks ?? {})) {
		if (paths && !paths.includes(path)) continue
		for (const k of normalise(list)) {
			if (!times.some((t) => Math.abs(t - k.t) < TIME_TOL)) times.push(k.t)
		}
	}
	return times.sort((a, b) => a - b)
}

/** The previous or next key time from `u`, for the toolbar's ‹ ›. Null at the ends. */
export function adjacentKeyTime(times: readonly number[], u: number, direction: 1 | -1): number | null {
	const EPS = 1e-3
	if (direction > 0) return times.find((t) => t > u + EPS) ?? null
	return [...times].reverse().find((t) => t < u - EPS) ?? null
}

// ===== Snapping =====

export type SnapKind = 'playhead' | 'moment' | 'key' | 'word' | 'cut' | 'marker'

export interface SnapCandidate {
	/** Timeline seconds. */
	t: number
	kind: SnapKind
	/** What the inspector says it snapped to: `moment “in” end`, `word “Sara”`. */
	label: string
}

/** On a tie, the thing the person is most likely aiming at wins. */
const SNAP_PRIORITY: Record<SnapKind, number> = { playhead: 0, moment: 1, key: 2, word: 3, cut: 4, marker: 5 }

/**
 * Every place a dragged key may snap to, in timeline seconds: the playhead,
 * cuts (every clip's edges, this one's too), markers, the motion layer's own
 * moments, the item's other keys, and each spoken word.
 */
export function keySnapCandidates(input: {
	item: Pick<TimelineItem, 'id' | 'timelineStart' | 'duration' | 'motion'>
	playhead: number
	/** Every clip's edges — the cuts. */
	others: readonly Pick<TimelineItem, 'id' | 'timelineStart' | 'duration'>[]
	markers?: readonly { time: number; label?: string }[]
	/** The item's keys that are NOT being dragged, clip-local. */
	otherKeys?: readonly number[]
	/** One entry per spoken word, timeline seconds. */
	words?: readonly { start: number; text: string }[]
}): SnapCandidate[] {
	const { item } = input
	const start = item.timelineStart
	const out: SnapCandidate[] = [{ t: input.playhead, kind: 'playhead', label: 'playhead' }]

	if (item.motion) {
		const moments = resolveMoments(item.motion, item.duration)
		for (let i = 0; i < moments.length - 1; i++) {
			const left = moments[i]
			const right = moments[i + 1]
			// A boundary is named after the window that owns it: the fixed one,
			// since the hold only takes up what the others leave.
			const label = !left.flex
				? `moment “${left.name}” end`
				: `moment “${right.name}” start`
			out.push({ t: start + left.start + left.duration, kind: 'moment', label })
		}
	}

	out.push({ t: start, kind: 'cut', label: 'clip start' }, { t: start + item.duration, kind: 'cut', label: 'clip end' })
	for (const other of input.others) {
		if (other.id === item.id) continue
		out.push(
			{ t: other.timelineStart, kind: 'cut', label: 'cut' },
			{ t: other.timelineStart + other.duration, kind: 'cut', label: 'cut' }
		)
	}
	for (const m of input.markers ?? []) out.push({ t: m.time, kind: 'marker', label: m.label ? `marker “${m.label}”` : 'marker' })
	for (const t of input.otherKeys ?? []) out.push({ t: start + t, kind: 'key', label: 'key' })
	for (const w of input.words ?? []) out.push({ t: w.start, kind: 'word', label: `word “${w.text.replace(/[^\p{L}\p{N}'’-]/gu, '')}”` })
	return out
}

/** The nearest candidate within `threshold` seconds of `t`, or null. */
export function chooseSnap(t: number, candidates: readonly SnapCandidate[], threshold: number): SnapCandidate | null {
	let best: SnapCandidate | null = null
	let bestDist = Infinity
	for (const c of candidates) {
		const dist = Math.abs(c.t - t)
		if (dist > threshold) continue
		if (dist < bestDist - 1e-9 || (Math.abs(dist - bestDist) <= 1e-9 && best && SNAP_PRIORITY[c.kind] < SNAP_PRIORITY[best.kind])) {
			best = c
			bestDist = dist
		}
	}
	return best
}

/** What a key at `t` sits exactly on, if anything — the inspector's "Snapped to". */
export function snapLabelAt(t: number, candidates: readonly SnapCandidate[]): SnapCandidate | null {
	return chooseSnap(t, candidates.filter((c) => c.kind !== 'playhead'), 0.001)
}

/**
 * Words with their own start times, for snapping. Transcripts are timed per
 * phrase; captions already spread a phrase's words across it in proportion to
 * their length, and the same estimate places them here (`captionsFromTimeline`
 * with one word per cue) — so a key snaps where the caption shows the word.
 */
export function wordsFromCues(cues: readonly { start: number; text: string }[]): { start: number; text: string }[] {
	return cues.filter((c) => c.text.trim()).map((c) => ({ start: c.start, text: c.text.trim() }))
}

// ===== Motion path =====

export interface MotionPathPoint {
	/** Clip seconds of the first key at this spot. */
	t: number
	/** Fractions of the frame. */
	x: number
	y: number
}

/**
 * Where an anchor on the layer travels: one point per position key, through
 * `valueAt` on `transform.x` / `transform.y`. Board 2 draws it on the monitor
 * while a position key is selected.
 *
 * `points` keeps every key in time order for the dashed line; `stops` keeps
 * each distinct place once (the first time it is reached), so an exit that
 * retraces an entrance does not print its timecodes on top of each other.
 */
export function motionPath(
	tracks: KeyframeTracks | undefined,
	still: { x: number; y: number },
	anchor: { x: number; y: number }
): { points: MotionPathPoint[]; stops: MotionPathPoint[] } {
	const times = keyTimes(tracks, ['transform.x', 'transform.y'])
	const points = times.map((t) => ({
		t,
		x: anchor.x + valueAt(tracks?.['transform.x'], t, still.x),
		y: anchor.y + valueAt(tracks?.['transform.y'], t, still.y)
	}))
	const stops: MotionPathPoint[] = []
	for (const p of points) {
		if (!stops.some((s) => Math.abs(s.x - p.x) < 1e-4 && Math.abs(s.y - p.y) < 1e-4)) stops.push(p)
	}
	return { points, stops }
}

/** `0:03.4` — the monitor's and the lanes' timecode. */
export function formatKeyTime(seconds: number, places = 1): string {
	const s = Math.max(0, seconds)
	const m = Math.floor(s / 60)
	const rest = (s - m * 60).toFixed(places)
	return `${m}:${rest.padStart(places ? 3 + places : 2, '0')}`
}

/** A value typed into the popover ("100%", "24px", "−12°", "#8B5CF6") → stored, or null. */
export function parseLaneValue(lane: LaneDef, text: string): number | null {
	const raw = text.trim().replace(/−/g, '-')
	if (lane.kind === 'color') {
		return /^#?[0-9a-f]{6}$/i.test(raw) ? parseInt(raw.replace('#', ''), 16) : null
	}
	if (lane.kind === 'enum') {
		const i = lane.options?.findIndex((o) => o.label.toLowerCase() === raw.toLowerCase() || o.value === raw) ?? -1
		return i >= 0 ? i : null
	}
	const n = parseFloat(raw)
	if (!Number.isFinite(n)) return null
	// A lane written in percent reads "100%" and "100" alike as a whole.
	const percent = lane.format(lane.still).endsWith('%')
	return lane.fromDisplay(percent ? n / 100 : n)
}
