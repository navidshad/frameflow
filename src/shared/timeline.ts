import type { Clip, MediaAsset, TimelineDiff, TimelineItem, Track } from './types'

/**
 * Pure timeline helpers shared by renderer (manual editing, undo/redo) and
 * main (M3 AI-diff validation). No Electron / Node imports allowed here.
 * Canonical time unit: seconds.
 */

export const TIMELINE_DIFF_SCHEMA_VERSION = 1

export const MIN_ITEM_DURATION = 0.05
export const MIN_SPEED = 0.25
export const MAX_SPEED = 4

export interface TimelineState {
	tracks: Track[]
	timeline: TimelineItem[]
}

export const clampSpeed = (speed: number): number =>
	Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))

/** On-timeline duration of an item: (out - in) / speed. */
export const itemDuration = (item: Pick<TimelineItem, 'in' | 'out' | 'speed'>): number =>
	(item.out - item.in) / (item.speed || 1)

export const itemEnd = (item: TimelineItem): number =>
	item.timelineStart + itemDuration(item)

export const computeContentEnd = (items: TimelineItem[]): number =>
	items.reduce((end, item) => Math.max(end, itemEnd(item)), 0)

let uidCounter = 0
const uid = (): string =>
	`ti-${Date.now().toString(36)}-${(uidCounter++).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

/** Place a WHOLE asset on a track as one full-span item (drag the file in). */
export function itemFromAsset(
	asset: { id: string; name: string; metadata?: { duration?: number } },
	trackId: string,
	timelineStart: number,
	durationOverride?: number
): TimelineItem {
	const duration = durationOverride ?? asset.metadata?.duration ?? 0
	return {
		id: uid(),
		trackId,
		sourceAssetId: asset.id,
		timelineStart,
		in: 0,
		out: duration,
		speed: 1.0,
		preservePitch: true,
		duration,
		label: asset.name
	}
}

/** Place a detected Clip (scene piece) on a track (PRD §6). */
export function clipToItem(clip: Clip, trackId: string, timelineStart: number): TimelineItem {
	return {
		id: uid(),
		trackId,
		sourceAssetId: clip.sourceAssetId,
		sourceClipId: clip.id,
		masterSegmentIndex: clip.masterSegmentIndex,
		timelineStart,
		in: clip.in,
		out: clip.out,
		speed: 1.0,
		preservePitch: true,
		duration: clip.duration,
		label: clip.visual?.slice(0, 40) || `Piece #${clip.index}`
	}
}

// Fields compared per-entity when diffing (id is the key, not a field).
const ITEM_FIELDS: (keyof TimelineItem)[] = [
	'trackId', 'sourceAssetId', 'sourceClipId', 'masterSegmentIndex',
	'timelineStart', 'in', 'out', 'speed', 'preservePitch', 'duration',
	'label', 'gain', 'muted', 'fadeInSec', 'fadeOutSec'
]
const TRACK_FIELDS: (keyof Track)[] = ['kind', 'name', 'order', 'muted', 'locked', 'hidden', 'height', 'gain']

function changedFields<T extends { id: string }>(before: T, after: T, fields: (keyof T)[]): Partial<T> | null {
	let changed: Partial<T> | null = null
	for (const field of fields) {
		if (before[field] !== after[field]) {
			if (!changed) changed = {}
			changed[field] = after[field]
		}
	}
	return changed
}

function pickFields<T extends { id: string }>(source: T, keys: (keyof T)[]): Partial<T> {
	const out: Partial<T> = {}
	for (const key of keys) out[key] = source[key]
	return out
}

/**
 * Snapshot-based diff: compares whole timeline states by entity id and
 * produces a forward diff (before -> after) plus its exact inverse.
 * Returns null when nothing changed.
 */
export function diffTimelines(
	before: TimelineState,
	after: TimelineState
): { forward: TimelineDiff; inverse: TimelineDiff } | null {
	const forward: TimelineDiff = { schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION }
	const inverse: TimelineDiff = { schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION }
	let dirty = false

	// --- Items ---
	const beforeItems = new Map(before.timeline.map((i) => [i.id, i]))
	const afterItems = new Map(after.timeline.map((i) => [i.id, i]))

	for (const [id, afterItem] of afterItems) {
		const beforeItem = beforeItems.get(id)
		if (!beforeItem) {
			;(forward.addItems ||= []).push({ ...afterItem })
			;(inverse.removeItemIds ||= []).push(id)
			dirty = true
		} else {
			const fwd = changedFields(beforeItem, afterItem, ITEM_FIELDS)
			if (fwd) {
				const keys = Object.keys(fwd) as (keyof TimelineItem)[]
				;(forward.updateItems ||= []).push({ id, ...fwd })
				;(inverse.updateItems ||= []).push({ id, ...pickFields(beforeItem, keys) })
				dirty = true
			}
		}
	}
	for (const [id, beforeItem] of beforeItems) {
		if (!afterItems.has(id)) {
			;(forward.removeItemIds ||= []).push(id)
			;(inverse.addItems ||= []).push({ ...beforeItem })
			dirty = true
		}
	}

	// --- Tracks ---
	const beforeTracks = new Map(before.tracks.map((t) => [t.id, t]))
	const afterTracks = new Map(after.tracks.map((t) => [t.id, t]))

	for (const [id, afterTrack] of afterTracks) {
		const beforeTrack = beforeTracks.get(id)
		if (!beforeTrack) {
			;(forward.addTracks ||= []).push({ ...afterTrack })
			;(inverse.removeTrackIds ||= []).push(id)
			dirty = true
		} else {
			const fwd = changedFields(beforeTrack, afterTrack, TRACK_FIELDS)
			if (fwd) {
				// Track updates ride through add/remove pairs is wrong — TimelineDiff
				// has no updateTracks op, so encode as remove+add of the SAME id.
				// Order matters on apply: removals run before adds.
				;(forward.removeTrackIds ||= []).push(id)
				;(forward.addTracks ||= []).push({ ...afterTrack })
				;(inverse.removeTrackIds ||= []).push(id)
				;(inverse.addTracks ||= []).push({ ...beforeTrack })
				dirty = true
			}
		}
	}
	for (const [id, beforeTrack] of beforeTracks) {
		if (!afterTracks.has(id)) {
			;(forward.removeTrackIds ||= []).push(id)
			;(inverse.addTracks ||= []).push({ ...beforeTrack })
			dirty = true
		}
	}

	return dirty ? { forward, inverse } : null
}

export interface ApplyResult {
	ok: boolean
	errors: string[]
}

/**
 * Repairs same-track overlaps by pushing later items right until sequential
 * (magnetic, content-preserving). Returns true when anything moved.
 * Needed because AI-diff placements aren't gesture-clamped like manual moves.
 */
export function repairOverlaps(state: TimelineState, eps = MIN_ITEM_DURATION): boolean {
	let changed = false
	const byTrack = new Map<string, TimelineItem[]>()
	for (const item of state.timeline) {
		const list = byTrack.get(item.trackId) || []
		list.push(item)
		byTrack.set(item.trackId, list)
	}
	for (const items of byTrack.values()) {
		items.sort((a, b) => a.timelineStart - b.timelineStart)
		let cursor = 0
		for (const item of items) {
			if (item.timelineStart < cursor - eps) {
				item.timelineStart = cursor
				changed = true
			}
			cursor = Math.max(cursor, itemEnd(item))
		}
	}
	return changed
}

/**
 * Applies a TimelineDiff to a state IN PLACE, with validation (PRD §5.7):
 * unknown schemaVersion rejected wholesale; unknown ids skipped (reported);
 * `0 <= in < out <= asset.duration` when assets provided; speed clamped;
 * `duration` recomputed as (out - in) / speed — never taken from the diff.
 */
export function applyTimelineDiff(
	state: TimelineState,
	diff: TimelineDiff,
	assets?: MediaAsset[]
): ApplyResult {
	const errors: string[] = []

	if (diff.schemaVersion !== TIMELINE_DIFF_SCHEMA_VERSION) {
		return { ok: false, errors: [`Unknown TimelineDiff schemaVersion ${diff.schemaVersion}`] }
	}

	const assetById = new Map((assets || []).map((a) => [a.id, a]))

	const validateRange = (item: Pick<TimelineItem, 'sourceAssetId' | 'in' | 'out'>): string | null => {
		if (item.in < 0 || item.out <= item.in) {
			return `invalid range in=${item.in} out=${item.out}`
		}
		const asset = assetById.get(item.sourceAssetId)
		if (asset?.metadata?.duration && item.out > asset.metadata.duration + 0.01) {
			return `out=${item.out} exceeds asset duration ${asset.metadata.duration}`
		}
		return null
	}

	const normalize = (item: TimelineItem): TimelineItem => {
		const speed = clampSpeed(item.speed || 1)
		const duration = (item.out - item.in) / speed
		const clampFade = (v: number | undefined) =>
			typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, duration) : undefined
		const gain = typeof item.gain === 'number' && Number.isFinite(item.gain)
			? Math.max(0, Math.min(2, item.gain))
			: undefined
		return {
			...item, speed, duration, gain,
			fadeInSec: clampFade(item.fadeInSec),
			fadeOutSec: clampFade(item.fadeOutSec)
		}
	}

	// Removals before additions (track-update encoding relies on this order).
	if (diff.removeTrackIds?.length) {
		const ids = new Set(diff.removeTrackIds)
		state.tracks = state.tracks.filter((t) => !ids.has(t.id))
	}
	if (diff.addTracks?.length) {
		for (const track of diff.addTracks) {
			if (state.tracks.some((t) => t.id === track.id)) {
				errors.push(`addTracks: duplicate id ${track.id}`)
				continue
			}
			state.tracks.push({ ...track })
		}
		state.tracks.sort((a, b) => a.order - b.order)
	}

	if (diff.removeItemIds?.length) {
		const ids = new Set(diff.removeItemIds)
		const known = state.timeline.filter((i) => ids.has(i.id)).length
		if (known !== ids.size) errors.push(`removeItemIds: ${ids.size - known} unknown id(s) skipped`)
		state.timeline = state.timeline.filter((i) => !ids.has(i.id))
	}

	if (diff.addItems?.length) {
		for (const item of diff.addItems) {
			if (state.timeline.some((i) => i.id === item.id)) {
				errors.push(`addItems: duplicate id ${item.id} skipped`)
				continue
			}
			const rangeError = validateRange(item)
			if (rangeError) {
				errors.push(`addItems ${item.id}: ${rangeError}`)
				continue
			}
			if (!state.tracks.some((t) => t.id === item.trackId)) {
				errors.push(`addItems ${item.id}: unknown track ${item.trackId}`)
				continue
			}
			state.timeline.push(normalize({ ...item }))
		}
	}

	if (diff.updateItems?.length) {
		for (const update of diff.updateItems) {
			const index = state.timeline.findIndex((i) => i.id === update.id)
			if (index === -1) {
				errors.push(`updateItems: unknown id ${update.id} skipped`)
				continue
			}
			const merged = { ...state.timeline[index], ...update }
			const rangeError = validateRange(merged)
			if (rangeError) {
				errors.push(`updateItems ${update.id}: ${rangeError}`)
				continue
			}
			state.timeline[index] = normalize(merged)
		}
	}

	return { ok: errors.length === 0, errors }
}
