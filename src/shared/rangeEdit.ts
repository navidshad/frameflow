import type { TimelineItem } from './types'
import { itemEnd } from './timeline'

/**
 * Removing an arbitrary span of the timeline, rather than whole clips.
 *
 * This is what "cut the bit where he says that" needs. The granularity comes
 * from wherever the span does — a caption cue, a search hit, a model naming a
 * time — so the same function serves word-level editing, a transcript search
 * and an AI op without any of them knowing about the others.
 *
 * Pure, and expressed as an item list in and an item list out rather than a
 * diff, so the renderer can commit it as a history step and `opsToDiff` can
 * turn it into one.
 */

export interface TimeRange {
	start: number
	end: number
}

/** Anything shorter than this is not a cut, it is a rounding error. */
export const MIN_RANGE_SEC = 0.05

const TIME_EPS = 1e-6

/** Sorted, merged, and stripped of anything too short to mean something. */
export function tidyRanges(ranges: TimeRange[]): TimeRange[] {
	const sorted = ranges
		.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
		.map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.max(r.start, r.end) }))
		.filter((r) => r.end - r.start >= MIN_RANGE_SEC)
		.sort((a, b) => a.start - b.start)
	const out: TimeRange[] = []
	for (const range of sorted) {
		const last = out[out.length - 1]
		if (last && range.start <= last.end + TIME_EPS) last.end = Math.max(last.end, range.end)
		else out.push({ ...range })
	}
	return out
}

/** Source seconds for a timeline instant inside `item`. */
const sourceAt = (item: TimelineItem, t: number) =>
	item.in + (t - item.timelineStart) * (item.speed || 1)

export interface RangeRemoval {
	/** Items to delete outright. */
	removeIds: string[]
	/** Items whose in/out changed — the halves that survive a partial overlap. */
	updated: TimelineItem[]
	/** Items created where a range fell in the MIDDLE of a clip, splitting it. */
	added: TimelineItem[]
	/** Total timeline seconds the removal takes out. */
	removedSec: number
}

/**
 * Work out what removing `ranges` does to `items`.
 *
 * Three cases per clip, and the third is the one that needs a new item:
 *
 *   covered entirely  → remove
 *   overlapped at one end → trim that end
 *   overlapped in the middle → keep both sides, so the clip becomes two
 *
 * Timeline positions are NOT closed up here. The caller ripples afterwards
 * with the code that already exists for a normal delete, so a range removal
 * behaves exactly like removing a clip does — which is the entire reason this
 * returns items rather than doing the edit.
 */
export function planRangeRemoval(
	items: readonly TimelineItem[],
	ranges: TimeRange[],
	makeId: () => string
): RangeRemoval {
	const spans = tidyRanges(ranges)
	const result: RangeRemoval = { removeIds: [], updated: [], added: [], removedSec: 0 }
	if (!spans.length) return result

	for (const item of items) {
		const start = item.timelineStart
		const end = itemEnd(item)
		const hits = spans.filter((r) => r.start < end - TIME_EPS && r.end > start + TIME_EPS)
		if (!hits.length) continue

		// What survives, in timeline seconds, as the complement of the spans.
		const keep: TimeRange[] = []
		let cursor = start
		for (const hit of hits) {
			const from = Math.max(hit.start, start)
			const to = Math.min(hit.end, end)
			result.removedSec += Math.max(0, to - from)
			if (from - cursor >= MIN_RANGE_SEC) keep.push({ start: cursor, end: from })
			cursor = Math.max(cursor, to)
		}
		if (end - cursor >= MIN_RANGE_SEC) keep.push({ start: cursor, end })

		if (!keep.length) {
			result.removeIds.push(item.id)
			continue
		}

		const speed = item.speed || 1
		const shape = (target: TimelineItem, span: TimeRange) => {
			target.timelineStart = span.start
			target.in = sourceAt(item, span.start)
			target.out = sourceAt(item, span.end)
			target.duration = (target.out - target.in) / speed
			// A sub-range is no longer one master scene, the same reason a split
			// clears it.
			target.masterSegmentIndex = undefined
		}

		// The first surviving span keeps the original id, so a selection and any
		// reference to it survives the edit.
		const first = { ...item }
		shape(first, keep[0])
		// `transition.out` belongs to the cut at the ORIGINAL end, which only the
		// LAST surviving piece still has — the same trap splitting fell into.
		if (keep.length > 1 && first.transition?.out) {
			const rest = { ...first.transition }
			delete rest.out
			first.transition = Object.keys(rest).length ? rest : undefined
		}
		result.updated.push(first)

		for (let i = 1; i < keep.length; i++) {
			const piece: TimelineItem = { ...JSON.parse(JSON.stringify(item)), id: makeId() }
			shape(piece, keep[i])
			if (i < keep.length - 1 && piece.transition?.out) {
				const rest = { ...piece.transition }
				delete rest.out
				piece.transition = Object.keys(rest).length ? rest : undefined
			}
			result.added.push(piece)
		}
	}

	return result
}
