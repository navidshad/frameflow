import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { Ease, KeyframeTracks } from '@shared/keyframes'
import { normalise } from '@shared/keyframes'
import {
	addKey, adjacentKeyTime, applyEaseToLane, chooseSnap, deleteKeys, itemLanes, keySnapCandidates,
	keyTimes, laneValueAt, mirrorEntranceOntoExit, moveKeys, nudgeKeys, pruneSelection, selectKey, setEaseInto,
	parseLaneValue, setKeyValue, snapLabelAt, sameKey, wordsFromCues,
	type KeyRef, type LaneDef, type SnapCandidate
} from '@shared/keyframeLanes'
import { useEditorStore } from './editorStore'

/**
 * The keyframe lanes' UI state: whether they are open, which keys are
 * selected, and every edit the lanes, the popover, the toolbar and the
 * inspector's Keyframe panel make.
 *
 * The decisions live in shared/keyframeLanes.ts. This store only wires them to
 * the editor store, and every edit goes through its gesture path — snapshot,
 * replace the keyframes, commitStep — so each one is a single undo step.
 */
export const useKeyframeLanesStore = defineStore('keyframeLanes', () => {
	const editor = useEditorStore()

	/** The toolbar's Keyframes toggle. */
	const open = ref(false)
	/** Selected keys; the LAST is the primary one the popover and inspector describe. */
	const selection = ref<KeyRef[]>([])
	/** Set while keys are being dragged, so the popover steps aside. */
	const dragging = ref(false)
	/** Timeline seconds of the snap the drag is sitting on, for the guide line. */
	const snapGuide = ref<number | null>(null)

	/** The one selected clip, when exactly one is. */
	const item = computed(() => {
		if (editor.selectedItemIds.length !== 1) return null
		return editor.doc?.timeline.find((i) => i.id === editor.selectedItemIds[0]) ?? null
	})

	const lanes = computed<LaneDef[]>(() => {
		const it = item.value
		if (!it) return []
		const kind = editor.doc?.media.find((a) => a.id === it.sourceAssetId)?.kind
		return itemLanes(it, kind)
	})

	const tracks = computed<KeyframeTracks | undefined>(() => item.value?.keyframes)

	/** Lanes are drawn: the toggle is on, and the selected clip has something to key. */
	const expanded = computed(() => open.value && !!item.value && lanes.value.length > 0)

	/** Whether the selected clip has any key on its lanes — lights the toggle while it is off (board 1). */
	const itemHasKeys = computed(() =>
		lanes.value.some((l) => normalise(tracks.value?.[l.path]).length > 0)
	)

	const primary = computed<KeyRef | null>(() => selection.value.at(-1) ?? null)
	const primaryLane = computed(() => lanes.value.find((l) => l.path === primary.value?.path) ?? null)

	// A different clip, or keys that undo took away, must not stay selected.
	watch(() => item.value?.id, () => { selection.value = [] })
	watch(tracks, (t) => {
		const kept = pruneSelection(selection.value, t)
		if (kept.length !== selection.value.length) selection.value = kept
	})

	const keysOn = (path: string) => normalise(tracks.value?.[path])

	/** Where the playhead sits inside the clip, clamped to it. */
	const clipTime = computed(() => {
		const it = item.value
		if (!it) return 0
		return Math.max(0, Math.min(it.duration, editor.playheadSec - it.timelineStart))
	})

	const fps = computed(() => editor.doc?.timelineMeta.fps || 30)

	// ===== Writes =====

	/** One edit, one undo step. `undefined` tracks clears the item's keyframes. */
	const commit = (next: KeyframeTracks | undefined, label: string) => {
		const it = item.value
		if (!it) return
		editor.beginItemGesture()
		editor.updateItemGesture(it.id, { keyframes: next })
		editor.endItemGesture(label)
	}

	const toggle = () => { open.value = !open.value }

	const select = (ref: KeyRef, additive = false) => {
		selection.value = selectKey(selection.value, ref, additive)
	}

	const clearSelection = () => { selection.value = [] }

	/**
	 * A key at the playhead on `path` — or on the lane of the selected key, which
	 * is what the toolbar's ◆ means. Its value is what the lane reads there now,
	 * so adding a key never moves anything.
	 */
	const addAtPlayhead = (path?: string) => {
		const lanePath = path ?? primary.value?.path
		const lane = lanes.value.find((l) => l.path === lanePath)
		if (!lane || !item.value) return
		const u = clipTime.value
		const value = laneValueAt(lane, keysOn(lane.path), u)
		const next = addKey(tracks.value, lane.path, u, value)
		commit(next, 'Add keyframe')
		const added = normalise(next[lane.path]).find((k) => Math.abs(k.t - Math.round(u * 100) / 100) < 0.0005)
		if (added) selection.value = [{ path: lane.path, t: added.t }]
	}

	const deleteSelected = () => {
		if (!selection.value.length) return false
		commit(deleteKeys(tracks.value, selection.value), selection.value.length > 1 ? 'Delete keyframes' : 'Delete keyframe')
		selection.value = []
		return true
	}

	/** −1 / +1 frame, at the sequence's own rate. */
	const nudge = (frames: number) => {
		const it = item.value
		if (!it || !selection.value.length) return
		const moved = nudgeKeys(tracks.value, selection.value, frames, {
			fps: fps.value, clipStart: it.timelineStart, clipDuration: it.duration
		})
		if (!moved.delta) return
		commit(moved.tracks, 'Move keyframe')
		selection.value = moved.selection
	}

	const setValue = (ref: KeyRef, value: number, label = 'Set keyframe') => {
		if (!Number.isFinite(value)) return
		commit(setKeyValue(tracks.value, ref, value), label)
	}

	/** Mid-drag value (the inspector's slider): painted, committed by `endValueGesture`. */
	const paintValue = (ref: KeyRef, value: number) => {
		const it = item.value
		if (!it || !Number.isFinite(value)) return
		editor.beginItemGesture()
		editor.updateItemGesture(it.id, { keyframes: setKeyValue(tracks.value, ref, value) })
	}
	const endValueGesture = () => editor.endItemGesture('Set keyframe')

	const setEase = (ref: KeyRef, ease: Ease) => commit(setEaseInto(tracks.value, ref, ease), 'Keyframe ease')

	const easeWholeLane = (path: string, ease: Ease) => commit(applyEaseToLane(tracks.value, path, ease), 'Lane ease')

	const mirror = (path: string) => {
		const it = item.value
		if (!it) return
		const next = { ...tracks.value, [path]: mirrorEntranceOntoExit(tracks.value?.[path], it.duration) }
		commit(next, 'Mirror entrance onto exit')
		selection.value = pruneSelection(selection.value, next)
	}

	/** The toolbar's ‹ and ›: the playhead to the previous or next key on any lane. */
	const step = (direction: 1 | -1) => {
		const it = item.value
		if (!it) return
		const times = keyTimes(tracks.value, lanes.value.map((l) => l.path))
		const t = adjacentKeyTime(times, editor.playheadSec - it.timelineStart, direction)
		if (t === null) return
		editor.seekTo(it.timelineStart + t)
		// Stay on the lane being worked on: its key at that instant becomes the selection.
		const path = primary.value?.path
		if (path && keysOn(path).some((k) => Math.abs(k.t - t) < 0.0005)) selection.value = [{ path, t }]
	}

	const canStep = (direction: 1 | -1) => {
		const it = item.value
		if (!it) return false
		const times = keyTimes(tracks.value, lanes.value.map((l) => l.path))
		return adjacentKeyTime(times, editor.playheadSec - it.timelineStart, direction) !== null
	}

	// ===== Snapping =====

	/** Every snap point for keys of the selected clip, except the keys in `exclude`. */
	const snapCandidates = (exclude: readonly KeyRef[] = []): SnapCandidate[] => {
		const it = item.value
		if (!it || !editor.doc) return []
		const otherKeys: number[] = []
		for (const lane of lanes.value) {
			for (const k of keysOn(lane.path)) {
				if (!exclude.some((e) => sameKey(e, { path: lane.path, t: k.t }))) otherKeys.push(k.t)
			}
		}
		return keySnapCandidates({
			item: it,
			playhead: editor.playheadSec,
			others: editor.doc.timeline,
			markers: editor.markers,
			otherKeys,
			words: wordsFromCues(editor.transcriptWords)
		})
	}

	/** What a resting key sits exactly on — the inspector's "Snapped to". */
	const snappedTo = (ref: KeyRef): SnapCandidate | null => {
		const it = item.value
		if (!it) return null
		return snapLabelAt(it.timelineStart + ref.t, snapCandidates([ref]))
	}

	// ===== Dragging keys =====

	const SNAP_PX = 8
	const DRAG_START_PX = 3

	/**
	 * Drag the selected keys in time. The grabbed key snaps — to the playhead,
	 * cuts, moments, other keys and words — and the rest of the selection moves
	 * by the same amount. The whole drag is one undo step; Escape puts it back.
	 */
	const beginDrag = (ref: KeyRef, event: PointerEvent) => {
		const it = item.value
		if (!it) return
		const additive = event.shiftKey || event.metaKey || event.ctrlKey
		if (additive || !selection.value.some((s) => sameKey(s, ref))) select(ref, additive)
		// Shift-click that took a key OUT of the selection has nothing to drag.
		if (!selection.value.some((s) => sameKey(s, ref))) return
		// The grabbed key leads: put it last so it stays the primary one.
		selection.value = [...selection.value.filter((s) => !sameKey(s, ref)), { ...ref }]

		const original = tracks.value ? JSON.parse(JSON.stringify(tracks.value)) as KeyframeTracks : undefined
		const chosen = [...selection.value]
		const candidates = snapCandidates(chosen)
		const startX = event.clientX
		let started = false

		const move = (e: PointerEvent) => {
			const dx = e.clientX - startX
			if (!started && Math.abs(dx) < DRAG_START_PX) return
			if (!started) {
				started = true
				dragging.value = true
				editor.beginItemGesture()
			}
			const pps = editor.pxPerSecond
			let target = it.timelineStart + ref.t + dx / pps
			snapGuide.value = null
			if (editor.snapEnabled) {
				const snap = chooseSnap(target, candidates, SNAP_PX / pps)
				if (snap) {
					target = snap.t
					snapGuide.value = snap.t
				}
			}
			const moved = moveKeys(original, chosen, target - it.timelineStart - ref.t, it.duration)
			editor.updateItemGesture(it.id, { keyframes: moved.tracks })
			selection.value = moved.selection
		}
		const finish = (cancel: boolean) => {
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', up)
			window.removeEventListener('keydown', key, true)
			snapGuide.value = null
			if (!started) return
			if (cancel) {
				editor.updateItemGesture(it.id, { keyframes: original })
				selection.value = chosen
			}
			editor.endItemGesture(chosen.length > 1 ? 'Move keyframes' : 'Move keyframe')
			dragging.value = false
		}
		const up = () => finish(false)
		const key = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return
			e.stopPropagation()
			finish(true)
		}
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)
		window.addEventListener('keydown', key, true)
	}

	/** What a person typed for a key's value, in the lane's own units. */
	const parseValue = (lane: LaneDef, text: string) => parseLaneValue(lane, text)

	// ===== Ask AI =====

	/** The editor prompt, scoped to this clip and these keys. */
	const ask = (request: string) => {
		const it = item.value
		const lane = primaryLane.value
		if (!it || !lane || editor.promptRunning) return
		const keys = keysOn(lane.path).map((k) => `${k.t.toFixed(2)}s=${lane.format(k.value)}`).join(', ')
		const layer = it.label || 'clip'
		void editor.runPrompt(
			`About the ${lane.label} keyframes (path ${lane.path}) of "${layer}" (item ${it.id}; keys at ${keys || 'none'}): ${request}`
		)
	}

	return {
		open, selection, dragging, snapGuide,
		item, lanes, tracks, expanded, itemHasKeys, primary, primaryLane, clipTime, fps,
		keysOn, toggle, select, clearSelection, addAtPlayhead, deleteSelected, nudge,
		setValue, paintValue, endValueGesture, setEase, easeWholeLane, mirror, step, canStep,
		snapCandidates, snappedTo, beginDrag, parseValue, ask
	}
})
