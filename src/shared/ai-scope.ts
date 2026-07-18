import type { EditorMarker, TimelineItem } from './types'
import { itemEnd } from './timeline'

/**
 * AI context scoping for the editor prompt (PRD §5.7 context windowing).
 * Pure — no Node/Electron imports. Used by BOTH the renderer (live scope chip
 * in the prompt bar) and main (buildPromptContext), so the label the user sees
 * always matches what the model receives.
 */

export const SCOPE_ENGAGE_DURATION_SEC = 2400 // ~40 min: past this, chapter windowing engages
export const SCOPE_ENGAGE_ITEM_COUNT = 400
export const SELECTION_NEIGHBORHOOD = 2       // items each side, per track
export const CHAPTER_FALLBACK_SPAN_SEC = 300  // ±5 min around playhead when no markers
export const MAX_WINDOW_ITEMS = 150           // hard cap; nearest-playhead kept

export type AiScopeKind = 'selection' | 'chapter' | 'full'

export interface AiScope {
	kind: AiScopeKind
	label: string
	itemIds: string[]           // in-scope item ids, timelineStart order
	assetIds: string[]          // assets referenced by in-scope items (or all when timeline empty)
}

export interface ScopeInput {
	timeline: TimelineItem[]
	markers: EditorMarker[]
	selectedItemIds: string[]
	playheadSec: number
	mediaIds: string[]
	widen?: 'chapter' | 'full'
}

const byStart = (a: TimelineItem, b: TimelineItem) => a.timelineStart - b.timelineStart

const assetsOf = (items: TimelineItem[], fallback: string[]): string[] => {
	const ids = [...new Set(items.map((i) => i.sourceAssetId))]
	return ids.length ? ids : fallback
}

export function computeScope(input: ScopeInput): AiScope {
	const { timeline, markers, selectedItemIds, playheadSec, mediaIds, widen } = input
	const sorted = [...timeline].sort(byStart)
	const totalDuration = sorted.reduce((end, i) => Math.max(end, itemEnd(i)), 0)

	// Empty timeline: full scope, all assets available (build-from-scratch)
	if (sorted.length === 0) {
		return { kind: 'full', label: 'Whole timeline · empty', itemIds: [], assetIds: mediaIds }
	}

	// 1. Explicit widen to full
	if (widen === 'full') {
		return fullScope(sorted, mediaIds)
	}

	// 2. Selection scope (+neighborhood per track)
	if (selectedItemIds.length > 0 && widen !== 'chapter') {
		const selected = sorted.filter((i) => selectedItemIds.includes(i.id))
		if (selected.length > 0) {
			const inScope = new Set<string>(selected.map((i) => i.id))
			const byTrack = new Map<string, TimelineItem[]>()
			for (const item of sorted) {
				const list = byTrack.get(item.trackId) || []
				list.push(item)
				byTrack.set(item.trackId, list)
			}
			for (const item of selected) {
				const lane = byTrack.get(item.trackId) || []
				const idx = lane.findIndex((i) => i.id === item.id)
				for (let d = 1; d <= SELECTION_NEIGHBORHOOD; d++) {
					if (lane[idx - d]) inScope.add(lane[idx - d].id)
					if (lane[idx + d]) inScope.add(lane[idx + d].id)
				}
			}
			const items = sorted.filter((i) => inScope.has(i.id))
			return {
				kind: 'selection',
				label: `Selection · ${selected.length} item${selected.length === 1 ? '' : 's'}`,
				itemIds: items.map((i) => i.id),
				assetIds: assetsOf(items, mediaIds)
			}
		}
	}

	// 3. Chapter window for long projects (or explicit widen: 'chapter')
	const isLong = totalDuration > SCOPE_ENGAGE_DURATION_SEC || sorted.length > SCOPE_ENGAGE_ITEM_COUNT
	if (isLong || widen === 'chapter') {
		const sortedMarkers = [...markers].sort((a, b) => a.time - b.time)
		let t0 = 0
		let t1 = totalDuration
		let chapterLabel = ''
		if (sortedMarkers.length > 0) {
			const prev = [...sortedMarkers].reverse().find((m) => m.time <= playheadSec)
			const next = sortedMarkers.find((m) => m.time > playheadSec)
			t0 = prev?.time ?? 0
			t1 = next?.time ?? totalDuration
			const chapterIndex = prev ? sortedMarkers.indexOf(prev) + 1 : 0
			chapterLabel = prev?.label ? `Chapter ${chapterIndex} “${prev.label}”` : `Chapter ${chapterIndex + (prev ? 0 : 1)}`
		} else {
			t0 = Math.max(0, playheadSec - CHAPTER_FALLBACK_SPAN_SEC)
			t1 = Math.min(totalDuration, playheadSec + CHAPTER_FALLBACK_SPAN_SEC)
			chapterLabel = 'Around playhead'
		}

		let items = sorted.filter((i) => itemEnd(i) >= t0 && i.timelineStart <= t1)
		if (items.length > MAX_WINDOW_ITEMS) {
			items = [...items]
				.sort((a, b) => Math.abs(a.timelineStart - playheadSec) - Math.abs(b.timelineStart - playheadSec))
				.slice(0, MAX_WINDOW_ITEMS)
				.sort(byStart)
		}
		return {
			kind: 'chapter',
			label: `${chapterLabel} · ${items.length} items`,
			itemIds: items.map((i) => i.id),
			assetIds: assetsOf(items, mediaIds)
		}
	}

	// 4. Full timeline
	return fullScope(sorted, mediaIds)
}

function fullScope(sorted: TimelineItem[], mediaIds: string[]): AiScope {
	return {
		kind: 'full',
		label: `Whole timeline · ${sorted.length} item${sorted.length === 1 ? '' : 's'}`,
		itemIds: sorted.map((i) => i.id),
		assetIds: assetsOf(sorted, mediaIds)
	}
}
