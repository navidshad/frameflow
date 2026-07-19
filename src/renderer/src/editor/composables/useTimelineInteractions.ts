import { ref } from 'vue'
import type { TimelineItem } from '@shared/types'
import type { TimelineState } from '@shared/timeline'
import { itemEnd, itemDuration, MIN_ITEM_DURATION } from '@shared/timeline'
import { useEditorStore } from '../../stores/editorStore'
import type { TimelineViewport } from './useTimelineViewport'

type GestureMode = 'idle' | 'movingItem' | 'trimmingEdge' | 'scrubbing'

/**
 * Pointer-Events state machine for all timeline gestures (PRD §5.6):
 * move (with snapping + cross-track), trim (edge drag, Alt = ripple-trim),
 * and ruler/playhead scrubbing. Mutates the reactive doc live during the
 * gesture; commits exactly ONE history step on pointerup by diffing against
 * the snapshot taken at pointerdown. Escape restores the snapshot.
 */
export function useTimelineInteractions(viewport: TimelineViewport) {
	const store = useEditorStore()

	const mode = ref<GestureMode>('idle')
	const snapGuideSec = ref<number | null>(null)
	const activeItemId = ref<string | null>(null)

	const SNAP_THRESHOLD_PX = 8

	let gestureBefore: TimelineState | null = null
	let grabOffsetSec = 0            // pointer offset inside the item on move-start
	let trimEdge: 'left' | 'right' = 'left'
	let trimRipple = false
	let laneRects: Array<{ trackId: string; top: number; bottom: number }> = []

	const doc = () => store.doc!

	const item = (): TimelineItem | undefined =>
		doc().timeline.find((i) => i.id === activeItemId.value)

	// ---------- snapping ----------
	const snapCandidates = (ignoreId?: string): number[] => {
		const times: number[] = [0, store.playheadSec]
		for (const m of store.markers) times.push(m.time)
		for (const other of doc().timeline) {
			if (other.id === ignoreId) continue
			times.push(other.timelineStart, itemEnd(other))
		}
		return times
	}

	const applySnap = (t: number, ignoreId?: string): number => {
		snapGuideSec.value = null
		if (!store.snapEnabled) return t
		const threshold = viewport.pxToSec(SNAP_THRESHOLD_PX)
		let best: number | null = null
		let bestDist = threshold
		for (const candidate of snapCandidates(ignoreId)) {
			const dist = Math.abs(candidate - t)
			if (dist <= bestDist) {
				best = candidate
				bestDist = dist
			}
		}
		if (best !== null) snapGuideSec.value = best
		return best ?? t
	}

	// ---------- shared gesture plumbing ----------
	const attach = () => {
		window.addEventListener('pointermove', onPointerMove)
		window.addEventListener('pointerup', onPointerUp)
		window.addEventListener('keydown', onKeyDown)
	}

	const detach = () => {
		window.removeEventListener('pointermove', onPointerMove)
		window.removeEventListener('pointerup', onPointerUp)
		window.removeEventListener('keydown', onKeyDown)
		snapGuideSec.value = null
	}

	const cancelGesture = () => {
		if (gestureBefore && store.doc) {
			store.doc.tracks = gestureBefore.tracks
			store.doc.timeline = gestureBefore.timeline
		}
		gestureBefore = null
		activeItemId.value = null
		mode.value = 'idle'
		detach()
	}

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === 'Escape' && mode.value !== 'idle') {
			e.stopPropagation()
			cancelGesture()
		}
	}

	const pointerToTime = (e: PointerEvent): number => {
		const el = viewport.scrollEl.value
		if (!el) return 0
		const rect = el.getBoundingClientRect()
		return viewport.pxToSec(el.scrollLeft + (e.clientX - rect.left))
	}

	const captureLaneRects = () => {
		const el = viewport.scrollEl.value
		if (!el) return
		laneRects = Array.from(el.querySelectorAll<HTMLElement>('[data-track-id]')).map((lane) => {
			const rect = lane.getBoundingClientRect()
			return { trackId: lane.dataset.trackId!, top: rect.top, bottom: rect.bottom }
		})
	}

	const trackAtY = (clientY: number): string | null => {
		const hit = laneRects.find((l) => clientY >= l.top && clientY <= l.bottom)
		return hit?.trackId || null
	}

	// ---------- move ----------
	const beginMove = (itemId: string, e: PointerEvent) => {
		const target = doc().timeline.find((i) => i.id === itemId)
		const track = doc().tracks.find((t) => t.id === target?.trackId)
		if (!target || !track || track.locked) return
		mode.value = 'movingItem'
		activeItemId.value = itemId
		gestureBefore = JSON.parse(JSON.stringify({ tracks: doc().tracks, timeline: doc().timeline }))
		grabOffsetSec = pointerToTime(e) - target.timelineStart
		captureLaneRects()
		;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
		attach()
	}

	const overlaps = (target: TimelineItem, trackId: string, start: number): boolean => {
		const end = start + itemDuration(target)
		return doc().timeline.some(
			(other) => other.id !== target.id && other.trackId === trackId &&
				start < itemEnd(other) && end > other.timelineStart
		)
	}

	const moveTick = (e: PointerEvent) => {
		const target = item()
		if (!target) return
		let start = applySnap(Math.max(0, pointerToTime(e) - grabOffsetSec), target.id)

		// Cross-track: pointer Y picks the lane; validate kind + locked/hidden
		const candidateTrackId = trackAtY(e.clientY)
		let trackId = target.trackId
		if (candidateTrackId && candidateTrackId !== target.trackId) {
			const candidateTrack = doc().tracks.find((t) => t.id === candidateTrackId)
			const sourceKind = doc().media.find((a) => a.id === target.sourceAssetId)?.kind || 'video'
			const currentKind = doc().tracks.find((t) => t.id === target.trackId)?.kind
			if (candidateTrack && !candidateTrack.locked && !candidateTrack.hidden &&
				candidateTrack.kind === currentKind && (candidateTrack.kind === 'video' || candidateTrack.kind === sourceKind)) {
				trackId = candidateTrackId
			}
		}

		// Overlap forbidden: clamp against the nearer neighbor on the target track
		if (overlaps(target, trackId, start)) {
			const dur = itemDuration(target)
			const neighbors = doc().timeline
				.filter((o) => o.id !== target.id && o.trackId === trackId)
				.sort((a, b) => a.timelineStart - b.timelineStart)
			// Find the gap the pointer is in and clamp into it if it fits
			let placed = false
			let prevEnd = 0
			for (const n of neighbors) {
				if (start + dur <= n.timelineStart && start >= prevEnd) { placed = true; break }
				if (start < n.timelineStart) {
					// try clamping into [prevEnd, n.start]
					if (n.timelineStart - prevEnd >= dur) {
						start = Math.min(Math.max(start, prevEnd), n.timelineStart - dur)
						placed = true
					}
					break
				}
				prevEnd = itemEnd(n)
			}
			if (!placed) {
				if (!overlaps(target, trackId, Math.max(start, prevEnd))) {
					start = Math.max(start, prevEnd)
				} else {
					return // no room — leave item where it was this tick
				}
			}
		}

		target.trackId = trackId
		target.timelineStart = start
	}

	// ---------- trim ----------
	const beginTrim = (itemId: string, edge: 'left' | 'right', e: PointerEvent) => {
		const target = doc().timeline.find((i) => i.id === itemId)
		const track = doc().tracks.find((t) => t.id === target?.trackId)
		if (!target || !track || track.locked) return
		mode.value = 'trimmingEdge'
		activeItemId.value = itemId
		trimEdge = edge
		trimRipple = e.altKey
		gestureBefore = JSON.parse(JSON.stringify({ tracks: doc().tracks, timeline: doc().timeline }))
		captureLaneRects()
		;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
		attach()
	}

	const trimTick = (e: PointerEvent) => {
		const target = item()
		if (!target) return
		const asset = doc().media.find((a) => a.id === target.sourceAssetId)
		const sourceDuration = asset?.metadata?.duration ?? Number.POSITIVE_INFINITY
		const speed = target.speed || 1
		const t = applySnap(pointerToTime(e), target.id)
		const before = gestureBefore!.timeline.find((i) => i.id === target.id)!
		const oldDuration = itemDuration(target)

		if (trimEdge === 'left') {
			// Moving the left edge changes timelineStart AND in together
			const maxStart = target.timelineStart + itemDuration(target) - MIN_ITEM_DURATION
			let newStart = Math.min(Math.max(0, t), maxStart)
			// Clamp against the left neighbor ALWAYS (ripple shifts downstream
			// items, but the item's own start must never overlap its predecessor)
			const leftNeighborEnd = doc().timeline
				.filter((o) => o.id !== target.id && o.trackId === target.trackId && itemEnd(o) <= before.timelineStart + 1e-6)
				.reduce((max, o) => Math.max(max, itemEnd(o)), 0)
			newStart = Math.max(newStart, leftNeighborEnd)
			const newIn = target.in + (newStart - target.timelineStart) * speed
			if (newIn < 0) return
			target.in = newIn
			target.timelineStart = newStart
			target.duration = (target.out - target.in) / speed
		} else {
			// Moving the right edge changes out
			const minEnd = target.timelineStart + MIN_ITEM_DURATION
			let newEnd = Math.max(t, minEnd)
			if (!trimRipple) {
				const rightNeighborStart = doc().timeline
					.filter((o) => o.id !== target.id && o.trackId === target.trackId && o.timelineStart >= itemEnd(before) - 1e-6)
					.reduce((min, o) => Math.min(min, o.timelineStart), Number.POSITIVE_INFINITY)
				newEnd = Math.min(newEnd, rightNeighborStart)
			}
			const newOut = target.in + (newEnd - target.timelineStart) * speed
			if (newOut > sourceDuration + 0.01) return
			target.out = newOut
			target.duration = (target.out - target.in) / speed
		}

		// Ripple-trim: shift downstream items by the duration delta
		if (trimRipple) {
			const delta = itemDuration(target) - oldDuration
			if (Math.abs(delta) > 1e-9) {
				for (const other of doc().timeline) {
					if (other.id !== target.id && other.trackId === target.trackId &&
						other.timelineStart > before.timelineStart) {
						other.timelineStart = Math.max(0, other.timelineStart + delta)
					}
				}
			}
		}
	}

	// ---------- scrub ----------
	const beginScrub = (e: PointerEvent) => {
		mode.value = 'scrubbing'
		;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
		store.seekTo(Math.max(0, pointerToTime(e)))
		attach()
	}

	// ---------- global handlers ----------
	const onPointerMove = (e: PointerEvent) => {
		switch (mode.value) {
			case 'movingItem': moveTick(e); break
			case 'trimmingEdge': trimTick(e); break
			case 'scrubbing': store.seekTo(Math.max(0, pointerToTime(e))); break
		}
	}

	const onPointerUp = () => {
		if (mode.value === 'movingItem' || mode.value === 'trimmingEdge') {
			if (gestureBefore) {
				const label = mode.value === 'movingItem' ? 'Move' : (trimRipple ? 'Ripple trim' : 'Trim')
				store.commitStep({ before: gestureBefore, label })
			}
		}
		gestureBefore = null
		activeItemId.value = null
		mode.value = 'idle'
		detach()
	}

	return {
		mode,
		snapGuideSec,
		activeItemId,
		beginMove,
		beginTrim,
		beginScrub,
		cancelGesture
	}
}

export type TimelineInteractions = ReturnType<typeof useTimelineInteractions>
