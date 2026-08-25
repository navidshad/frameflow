import type {
	Clip, EnrichedTimelineSegment, MediaAsset, TimelineDiff, TimelineItem, Track
} from './types'

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

// ===== Boundary: SRT strings <-> seconds =====
//
// The chat/graph flow speaks SRT timestamps (EnrichedTimelineSegment.start/end);
// the editor speaks seconds. These three functions are the only crossing, and
// they are what "Open in Editor" uses to seed a project from an AI cut.

/** The sentinel enrichment.ts writes when no scene description covers a segment. */
const NO_VISUAL = 'No visual description available.'

/** Clips whose endpoints agree within this are considered the same range. */
const RANGE_EPSILON = 0.05

/**
 * `HH:MM:SS,mmm` | `MM:SS.mmm` | `12.500` | `7` → seconds.
 * The one parser — main-process copies were folded into this.
 */
export function srtToSeconds(t: string): number {
	const clean = t.trim().replace(',', '.')
	const [timePart, milliPart = '0'] = clean.split('.')
	const parts = timePart.split(':').map(Number)
	let seconds = 0
	if (parts.length === 3) seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
	else if (parts.length === 2) seconds = parts[0] * 60 + parts[1]
	else seconds = parts[0] || 0
	return seconds + parseFloat(`0.${milliPart}`)
}

/**
 * The chat flow's enriched master timeline → the editor's clip tray.
 *
 * `makeId` is injected so this module keeps its no-dependency rule (main passes
 * uuidv4). `masterSegmentIndex` is deliberately left undefined: runRetranscribe
 * uses `every(c => c.masterSegmentIndex === undefined && c.text !== undefined)`
 * as its "these pieces are mine to rebuild" marker, and setting it here would
 * silently downgrade Re-transcribe to a text-only refresh.
 */
export function clipsFromSegments(
	segments: readonly EnrichedTimelineSegment[],
	assetId: string,
	makeId: () => string,
	opts?: { durationLimit?: number }
): Clip[] {
	const limit = opts?.durationLimit && opts.durationLimit > 0
		? opts.durationLimit
		: Number.POSITIVE_INFINITY

	const clips: Clip[] = []
	for (const seg of segments) {
		const start = Math.max(0, srtToSeconds(seg.start))
		const end = Math.min(srtToSeconds(seg.end), limit)
		if (!(end > start)) continue // zero-length or past the end of the source

		clips.push({
			id: makeId(),
			sourceAssetId: assetId,
			index: clips.length + 1,
			in: start,
			out: end,
			duration: end - start,
			text: seg.text,
			visual: seg.visual && seg.visual !== NO_VISUAL ? seg.visual : undefined,
			selected: false
		})
	}
	return clips
}

/**
 * An AI cut → back-to-back TimelineItems on one track.
 *
 * Segments are matched to existing clips by TIME, never by `seg.index` — the
 * generation phase falls back through several transcript files, so the index
 * basis isn't guaranteed, whereas time always is. A match donates its clip id
 * (so the tray highlights in step with the timeline); a miss still produces a
 * valid item straight from the segment's own range.
 */
export function segmentsToItems(
	segments: readonly EnrichedTimelineSegment[],
	trackId: string,
	opts?: { clips?: readonly Clip[]; assetId?: string; startAt?: number; epsilon?: number }
): TimelineItem[] {
	const clips = opts?.clips ?? []
	const epsilon = opts?.epsilon ?? RANGE_EPSILON
	let cursor = opts?.startAt ?? 0

	const items: TimelineItem[] = []
	for (const seg of segments) {
		const start = Math.max(0, srtToSeconds(seg.start))
		const end = srtToSeconds(seg.end)
		if (!(end > start)) continue

		const match = clips.find(
			(c) => Math.abs(c.in - start) <= epsilon && Math.abs(c.out - end) <= epsilon
		)

		if (match) {
			items.push(clipToItem(match, trackId, cursor))
			cursor += match.duration
			continue
		}

		const assetId = opts?.assetId ?? clips[0]?.sourceAssetId
		if (!assetId) continue // nothing to point the item at

		items.push({
			id: uid(),
			trackId,
			sourceAssetId: assetId,
			timelineStart: cursor,
			in: start,
			out: end,
			speed: 1.0,
			preservePitch: true,
			duration: end - start,
			label: (seg.visual && seg.visual !== NO_VISUAL ? seg.visual : seg.text)?.slice(0, 40)
		})
		cursor += end - start
	}
	return items
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

export interface TrimOptions {
	/** Alt-drag: downstream items absorb the length change (magnetic). */
	ripple?: boolean
	/** Source asset duration — the out-point can never run past it. */
	sourceDuration?: number
	minDuration?: number
}

export interface TrimSolution {
	/** New absolute geometry for the trimmed item. */
	item: { id: string; timelineStart: number; in: number; out: number; duration: number }
	/**
	 * New absolute start for every same-track item after it. Present even when
	 * NOT rippling (unchanged values) so a caller that drops out of ripple mode
	 * mid-gesture puts the followers back where they were.
	 */
	shifts: { id: string; timelineStart: number }[]
	/** Seconds the trim added (+) or freed (-). */
	delta: number
}

/**
 * Solves one trim against the timeline as it was when the gesture STARTED.
 *
 * Pure and absolute: the answer depends only on (snapshot, edge, pointer), so
 * every tick of a drag recomputes the whole layout instead of stacking another
 * increment onto the last tick's result. That is what makes a drag idempotent —
 * drag out and back and you land on exactly the values you started with.
 *
 * Ripple mode PINS the item's start and lets its LENGTH change: trimming the
 * head keeps the clip butted where it was and pulls its tail — and every clip
 * after it — up. That is what deleteItems, setItemSpeed and the AI diff path
 * (editor/ops.ts) already do. A head trim that moved the start instead would
 * shift the followers by time freed at an edge that never moved, overlapping
 * the next clip by exactly the amount trimmed.
 *
 * Returns null when the clamps leave no legal position.
 */
export function solveTrim(
	before: TimelineState,
	itemId: string,
	edge: 'left' | 'right',
	pointerSec: number,
	opts: TrimOptions = {}
): TrimSolution | null {
	const item = before.timeline.find((i) => i.id === itemId)
	if (!item) return null

	const min = opts.minDuration ?? MIN_ITEM_DURATION
	const speed = item.speed || 1
	const start0 = item.timelineStart
	const end0 = start0 + itemDuration(item)
	const others = before.timeline.filter((o) => o.id !== itemId && o.trackId === item.trackId)

	let start = start0
	let inPoint = item.in
	let outPoint = item.out

	if (edge === 'left') {
		// Floor: t=0, the previous clip's tail, and the head of the source.
		// Ceiling: leave at least `min` on the timeline. A ripple shifts what
		// comes AFTER, so the predecessor clamp applies in both modes.
		const prevEnd = others
			.filter((o) => itemEnd(o) <= start0 + 1e-6)
			.reduce((max, o) => Math.max(max, itemEnd(o)), 0)
		const floor = Math.max(0, prevEnd, start0 - item.in / speed)
		const ceiling = end0 - min
		if (floor > ceiling) return null
		start = Math.min(Math.max(pointerSec, floor), ceiling)
		inPoint = item.in + (start - start0) * speed
	} else {
		// Ceiling: the source tail, plus the next clip's head unless we ripple
		// (a ripple pushes it instead). Math.max(sourceEnd, item.out) so a clip
		// whose out already exceeds the probed duration is never shrunk by it.
		const sourceEnd = opts.sourceDuration ?? Number.POSITIVE_INFINITY
		const nextStart = opts.ripple
			? Number.POSITIVE_INFINITY
			: others
				.filter((o) => o.timelineStart >= end0 - 1e-6)
				.reduce((m, o) => Math.min(m, o.timelineStart), Number.POSITIVE_INFINITY)
		const floor = start0 + min
		const ceiling = Math.min(nextStart, start0 + (Math.max(sourceEnd, item.out) - item.in) / speed)
		if (floor > ceiling) return null
		outPoint = item.in + (Math.min(Math.max(pointerSec, floor), ceiling) - start0) * speed
	}

	const duration = (outPoint - inPoint) / speed
	const delta = duration - itemDuration(item)
	const shift = opts.ripple ? delta : 0

	return {
		item: {
			id: itemId,
			// Rippling pins the head: the LENGTH change is what moves.
			// `start === start0` on the right branch, so this is right for both.
			timelineStart: opts.ripple ? start0 : start,
			in: inPoint,
			out: outPoint,
			duration
		},
		shifts: others
			.filter((o) => o.timelineStart > start0)
			.map((o) => ({ id: o.id, timelineStart: Math.max(0, o.timelineStart + shift) })),
		delta
	}
}

/** Same-track item pairs that overlap. Diagnostic only — nothing is mutated. */
export function findOverlaps(state: TimelineState, eps = 1e-6): [string, string][] {
	const pairs: [string, string][] = []
	const byTrack = new Map<string, TimelineItem[]>()
	for (const item of state.timeline) {
		const list = byTrack.get(item.trackId) || []
		list.push(item)
		byTrack.set(item.trackId, list)
	}
	for (const items of byTrack.values()) {
		const sorted = [...items].sort((a, b) => a.timelineStart - b.timelineStart)
		for (let i = 1; i < sorted.length; i++) {
			if (sorted[i].timelineStart < itemEnd(sorted[i - 1]) - eps) {
				pairs.push([sorted[i - 1].id, sorted[i].id])
			}
		}
	}
	return pairs
}

/**
 * Timeline items whose source asset is gone (removed media). Orphans draw as
 * empty clips, play nothing, and make the export engine throw, so every path
 * that could introduce one sweeps first.
 *
 * `sourceAssetId` is the ONLY link checked. sourceClipId legitimately dangles —
 * a scene re-detect rebuilds every Clip id, and merged range items clear it on
 * purpose — while the item is still perfectly renderable from its own in/out.
 */
export function findOrphanItems(
	items: readonly TimelineItem[],
	assetIds: ReadonlySet<string>
): TimelineItem[] {
	return items.filter((item) => !assetIds.has(item.sourceAssetId))
}

/**
 * Drops orphan items from a state IN PLACE; returns what was removed.
 *
 * Positions are deliberately NOT rippled: main purges the same way when the
 * asset is removed (editor/assets.ts), and a purge that moved survivors would
 * make the two sides disagree — and would invalidate the absolute
 * timelineStart values already recorded in the undo ring.
 *
 * NOTE this REASSIGNS state.timeline (like applyTimelineDiff, unlike
 * repairOverlaps): callers holding their own array must write it back.
 */
export function pruneOrphanItems(
	state: TimelineState,
	assetIds: ReadonlySet<string>
): TimelineItem[] {
	const orphans = findOrphanItems(state.timeline, assetIds)
	if (orphans.length) {
		const dead = new Set(orphans.map((i) => i.id))
		state.timeline = state.timeline.filter((i) => !dead.has(i.id))
	}
	return orphans
}

/**
 * One edit that changed how much time a track occupies at a point: a removal
 * (negative delta) or a retime/trim that made a clip shorter or longer.
 */
export interface RippleChange {
	trackId: string
	/** Where on the timeline the change happened. */
	at: number
	/** Seconds gained (+) or freed (-) at that point. */
	delta: number
}

/**
 * Shift items by the time that edits before them freed or consumed — the
 * magnetic behaviour manual editing already has (deleteItems ripples on
 * delete, setItemSpeed ripples on retime). Without it, shortening or removing
 * anything leaves a hole in the timeline.
 *
 * Conservative on purpose: only the time an edit actually changed moves, so a
 * gap nobody touched survives. Use closeTimelineGaps for a full reflow.
 * Returns true if anything moved.
 */
export function rippleTimeline(
	items: TimelineItem[],
	changes: RippleChange[],
	pinnedIds?: ReadonlySet<string>
): boolean {
	if (!changes.length) return false
	let moved = false
	for (const item of items) {
		if (pinnedIds?.has(item.id)) continue
		const shift = changes
			.filter((c) => c.trackId === item.trackId && c.at < item.timelineStart)
			.reduce((sum, c) => sum + c.delta, 0)
		if (Math.abs(shift) > 1e-9) {
			item.timelineStart = Math.max(0, item.timelineStart + shift)
			moved = true
		}
	}
	return moved
}

/** rippleTimeline for the common case: items were deleted. */
export function rippleAfterRemoval(items: TimelineItem[], removed: TimelineItem[]): boolean {
	return rippleTimeline(items, removed.map((r) => ({
		trackId: r.trackId,
		at: r.timelineStart,
		delta: -itemDuration(r)
	})))
}

/**
 * Make each track's items run back to back from the start, closing every gap
 * (and any overlap) in one pass. Unlike repairOverlaps, this pulls items LEFT.
 * Returns true if anything moved.
 */
export function closeTimelineGaps(
	state: TimelineState,
	opts: { trackIds?: string[]; eps?: number } = {}
): boolean {
	const eps = opts.eps ?? MIN_ITEM_DURATION
	const only = opts.trackIds?.length ? new Set(opts.trackIds) : null
	// A locked track is the user saying "do not move this" — reflowing a locked
	// music bed to t=0 would knock it out of sync with picture. Hidden tracks
	// are skipped too: never silently rearrange what cannot be seen.
	const protectedTracks = new Set(
		state.tracks.filter((t) => t.locked || t.hidden).map((t) => t.id)
	)
	let changed = false

	const byTrack = new Map<string, TimelineItem[]>()
	for (const item of state.timeline) {
		if (only && !only.has(item.trackId)) continue
		if (protectedTracks.has(item.trackId)) continue
		const list = byTrack.get(item.trackId) || []
		list.push(item)
		byTrack.set(item.trackId, list)
	}

	for (const items of byTrack.values()) {
		items.sort((a, b) => a.timelineStart - b.timelineStart)
		let cursor = 0
		for (const item of items) {
			if (Math.abs(item.timelineStart - cursor) > eps) {
				item.timelineStart = cursor
				changed = true
			}
			cursor = itemEnd(item)
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

	// null when no assets were supplied, so "not supplied" and "supplied but
	// empty" stay distinguishable — the add check below is opt-in.
	const assetById = assets ? new Map(assets.map((a) => [a.id, a])) : null

	const validateRange = (item: Pick<TimelineItem, 'sourceAssetId' | 'in' | 'out'>): string | null => {
		if (item.in < 0 || item.out <= item.in) {
			return `invalid range in=${item.in} out=${item.out}`
		}
		const asset = assetById?.get(item.sourceAssetId)
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
			// An add for media that is no longer in the project is stale by
			// definition. The undo ring stores full item clones in its inverse,
			// so undoing an edit made BEFORE a media removal would otherwise put
			// orphans straight back. Adds only — updates on an existing orphan
			// still apply, so a pre-fix doc stays editable.
			if (assetById && !assetById.has(item.sourceAssetId)) {
				errors.push(`addItems ${item.id}: media asset ${item.sourceAssetId} is not in the project`)
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
