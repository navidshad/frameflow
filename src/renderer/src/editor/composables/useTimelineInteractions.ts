import { ref } from 'vue'
import type { TimelineItem } from '@shared/types'
import type { TimelineState } from '@shared/timeline'
import { itemEnd, itemDuration, solveTrim } from '@shared/timeline'
import { useEditorStore } from '../../stores/editorStore'
import { canHostItem, itemFamily, nextTrackName, nextTrackOrder, type TrackFamily } from '@shared/tracks'
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

	/**
	 * The lane under the pointer mid-drag, and whether it will take this item.
	 *
	 * A refusal used to be invisible — the item simply stopped following the
	 * pointer — which is indistinguishable from the feature being broken. The
	 * lane reads this to say yes or no, and `reason` is the wording it shows.
	 */
	const dropTarget = ref<{ trackId: string; ok: boolean; reason?: string } | null>(null)

	/**
	 * Set while the pointer is dragging past the end of the stack, where letting
	 * go makes a new lane. Reaching for the toolbar mid-drag is not something a
	 * hand does; carrying the clip to where the track should be is.
	 */
	const newTrackZone = ref<{ family: TrackFamily; edge: 'above' | 'below' } | null>(null)

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
		// Snap to the layout as it was at pointerdown. During a ripple the
		// downstream edges move WITH the drag, so snapping to a live edge makes
		// the gesture chase itself. Safe for moves too: the only item that
		// differs from the snapshot mid-move is the one already excluded.
		for (const other of gestureBefore?.timeline ?? doc().timeline) {
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
		startAutoScroll()
	}

	const detach = () => {
		window.removeEventListener('pointermove', onPointerMove)
		window.removeEventListener('pointerup', onPointerUp)
		window.removeEventListener('keydown', onKeyDown)
		stopAutoScroll()
		lastPointer = null
		snapGuideSec.value = null
		dropTarget.value = null
		newTrackZone.value = null
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

	/**
	 * Where each lane sits, in the SCROLL CONTAINER'S OWN coordinates.
	 *
	 * Deliberately not viewport pixels: those were captured once at pointerdown
	 * and every one of them is wrong the moment the lanes scroll — which is
	 * exactly what a drag that auto-scrolls does, and what adding a track
	 * mid-gesture does too. `offsetTop` is measured against the same content box
	 * that `scrollTop` moves through, so the two compose and the rects stay true.
	 */
	const captureLaneRects = () => {
		const el = viewport.scrollEl.value
		if (!el) return
		laneRects = Array.from(el.querySelectorAll<HTMLElement>('[data-track-id]')).map((lane) => ({
			trackId: lane.dataset.trackId!,
			top: lane.offsetTop,
			bottom: lane.offsetTop + lane.offsetHeight
		}))
	}

	/** A pointer's viewport Y as a position inside the scrolled lane content. */
	const contentY = (clientY: number): number => {
		const el = viewport.scrollEl.value
		if (!el) return clientY
		return clientY - el.getBoundingClientRect().top + el.scrollTop
	}

	const trackAtY = (clientY: number): string | null => {
		const y = contentY(clientY)
		const hit = laneRects.find((l) => y >= l.top && y <= l.bottom)
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

		// Past the end of the stack: the drop will make a lane rather than find
		// one. Video grows upward (the front of the picture), audio downward,
		// which is the direction each family already stacks.
		const family = itemFamily(target, doc().media)
		const y = contentY(e.clientY)
		const first = laneRects[0]
		const last = laneRects[laneRects.length - 1]
		if (family === 'video' && first && y < first.top) {
			newTrackZone.value = { family, edge: 'above' }
			dropTarget.value = null
			target.timelineStart = start
			return
		}
		if (family === 'audio' && last && y > last.bottom) {
			newTrackZone.value = { family, edge: 'below' }
			dropTarget.value = null
			target.timelineStart = start
			return
		}
		newTrackZone.value = null

		// Cross-track: the pointer picks the lane, and the lane's family decides
		// whether it can have it. Anything you can SEE goes on any video lane,
		// anything you can HEAR on any audio one — one rule, in shared/tracks.ts.
		const laneId = trackAtY(e.clientY)
		const lane = laneId ? doc().tracks.find((t) => t.id === laneId) : undefined
		let trackId = target.trackId
		if (lane && lane.id !== target.trackId) {
			const verdict = canHostItem(lane, target, doc().media)
			dropTarget.value = { trackId: lane.id, ...verdict }
			// A refused lane does not freeze the drag: the item keeps sliding along
			// the track it came from, so the gesture stays useful while the pointer
			// crosses somewhere it cannot land.
			if (verdict.ok) trackId = lane.id
		} else {
			dropTarget.value = lane ? { trackId: lane.id, ok: true } : null
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
					// No gap on this lane big enough. Say so instead of just going
					// still, which reads as the drag having died.
					dropTarget.value = { trackId, ok: false, reason: 'No room on this track.' }
					return
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
		if (!target || !gestureBefore) return
		// Alt is read LIVE: hold or release Option mid-drag and the next move
		// re-solves from the snapshot, so the ripple turns on and off cleanly.
		// (Only safe because solveTrim always returns follower positions — with
		// the delta applied or not — so turning it off puts them back.)
		trimRipple = e.altKey

		const asset = doc().media.find((a) => a.id === target.sourceAssetId)
		const t = applySnap(pointerToTime(e), target.id)
		// A rippling head trim pins the head, so nothing lands on the snapped
		// time — don't draw a guide at a place the user cannot hit.
		if (trimRipple && trimEdge === 'left') snapGuideSec.value = null

		// A motion layer has no source to run out of: its clip IS its length,
		// always from in = 0. Give the solver headroom on the left so the head
		// can be dragged earlier too, then put the clip back on its own clock.
		const MOTION_ROOM = 3600
		const snapshot = target.motion
			? {
				...gestureBefore,
				timeline: gestureBefore.timeline.map((i) =>
					i.id === target.id ? { ...i, in: i.in + MOTION_ROOM, out: i.out + MOTION_ROOM } : i)
			}
			: gestureBefore
		const solved = solveTrim(snapshot, target.id, trimEdge, t, {
			ripple: trimRipple,
			sourceDuration: target.motion ? undefined : asset?.metadata?.duration
		})
		if (!solved) return

		target.timelineStart = solved.item.timelineStart
		target.in = target.motion ? 0 : solved.item.in
		target.out = target.motion ? solved.item.duration : solved.item.out
		target.duration = solved.item.duration

		const byId = new Map(doc().timeline.map((i) => [i.id, i]))
		for (const shift of solved.shifts) {
			const other = byId.get(shift.id)
			if (other) other.timelineStart = shift.timelineStart
		}
	}

	// ---------- scrub ----------
	const beginScrub = (e: PointerEvent) => {
		mode.value = 'scrubbing'
		;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
		store.seekTo(Math.max(0, pointerToTime(e)))
		attach()
	}

	// ---------- edge auto-scroll ----------

	/**
	 * Drag toward an edge and the lanes come to you.
	 *
	 * Two things make this less trivial than it sounds. A pointer held still at
	 * the edge fires NO further move events, so each frame has to re-run the
	 * gesture with the last one we saw — hence `lastPointer`. And the ruler is
	 * sticky over the top of the scroller, so a top zone measured from the
	 * container's own edge would trigger while the pointer is on the ruler,
	 * where the user is scrubbing, not dragging.
	 */
	const EDGE_PX = 28
	const RULER_PX = 24
	const MAX_SCROLL_PER_FRAME = 14

	let lastPointer: PointerEvent | null = null
	let scrollRaf: number | null = null

	const stopAutoScroll = () => {
		if (scrollRaf !== null) cancelAnimationFrame(scrollRaf)
		scrollRaf = null
	}

	/** How fast to scroll on one axis, from how far into the edge zone we are. */
	const edgeSpeed = (position: number, min: number, max: number): number => {
		if (position < min + EDGE_PX) return -((min + EDGE_PX - position) / EDGE_PX) * MAX_SCROLL_PER_FRAME
		if (position > max - EDGE_PX) return ((position - (max - EDGE_PX)) / EDGE_PX) * MAX_SCROLL_PER_FRAME
		return 0
	}

	const autoScrollTick = () => {
		scrollRaf = requestAnimationFrame(autoScrollTick)
		const el = viewport.scrollEl.value
		const e = lastPointer
		if (!el || !e || mode.value === 'idle') return

		const rect = el.getBoundingClientRect()
		const dx = edgeSpeed(e.clientX, rect.left, rect.right)
		// The lane area starts below the sticky ruler.
		const dy = edgeSpeed(e.clientY, rect.top + RULER_PX, rect.bottom)
		if (!dx && !dy) return

		const before = { left: el.scrollLeft, top: el.scrollTop }
		if (dx) el.scrollLeft += dx
		if (dy) el.scrollTop += dy
		if (el.scrollLeft === before.left && el.scrollTop === before.top) return

		// The lanes moved under a pointer that did not, so the gesture has to be
		// re-evaluated at the same screen position over new content.
		viewport.onScroll()
		onPointerMove(e)
	}

	const startAutoScroll = () => {
		if (scrollRaf === null) scrollRaf = requestAnimationFrame(autoScrollTick)
	}

	// ---------- global handlers ----------
	const onPointerMove = (e: PointerEvent) => {
		lastPointer = e
		switch (mode.value) {
			case 'movingItem': moveTick(e); break
			case 'trimmingEdge': trimTick(e); break
			case 'scrubbing': store.seekTo(Math.max(0, pointerToTime(e))); break
		}
	}

	/**
	 * Make the lane the drop asked for. Pushed straight into the document rather
	 * than through the store's own action so it lands INSIDE this gesture: the
	 * snapshot taken at pointerdown covers tracks as well as items, so the track
	 * and the move commit as one history step and Escape rolls back both.
	 */
	const materialiseTrack = (family: TrackFamily): string | null => {
		const d = store.doc
		if (!d) return null
		const id = crypto.randomUUID ? crypto.randomUUID() : `tr-${Date.now()}`
		d.tracks.push({
			id,
			kind: family,
			name: nextTrackName(d.tracks, family),
			order: nextTrackOrder(d.tracks, family),
			muted: false, locked: false, hidden: false, height: 64
		})
		return id
	}

	const onPointerUp = () => {
		if (mode.value === 'movingItem' && newTrackZone.value) {
			const target = item()
			const trackId = materialiseTrack(newTrackZone.value.family)
			if (target && trackId) target.trackId = trackId
		}
		if (mode.value === 'movingItem' || mode.value === 'trimmingEdge') {
			if (gestureBefore) {
				// A sound that follows a moment, dragged somewhere by hand, is placed
				// on purpose: it stops following rather than snapping back on commit.
				const dragged = item()
				const was = dragged && gestureBefore.timeline.find((i) => i.id === dragged.id)
				if (dragged?.bind && was && Math.abs(was.timelineStart - dragged.timelineStart) > 1e-6) {
					store.releaseSoundBinding(dragged.id)
				}
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
		dropTarget,
		newTrackZone,
		beginMove,
		beginTrim,
		beginScrub,
		cancelGesture
	}
}

export type TimelineInteractions = ReturnType<typeof useTimelineInteractions>
