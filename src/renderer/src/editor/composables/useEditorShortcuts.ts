import { onMounted, onUnmounted, ref } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import { matchShortcut } from '../shortcuts'

/**
 * The editor's keyboard, driven by the table in `../shortcuts.ts`.
 *
 * That table is also what the help overlay reads, so a shortcut cannot exist
 * without being documented and the documentation cannot drift from what fires.
 * This file only says what each one DOES.
 *
 * Nothing fires while the user is typing — that guard is the first line.
 */
export function useEditorShortcuts(options: {
	zoomBy?: (factor: number) => void
	onHelp?: () => void
	onFullscreen?: () => void
} = {}) {
	const store = useEditorStore()

	const frameStep = () => 1 / (store.doc?.timelineMeta.fps || 30)

	// ---------- Shuttle ----------

	/**
	 * J/K/L, adapted honestly to this playback engine.
	 *
	 * `useEdlPlayback` derives the playhead from the video element's own
	 * `currentTime` and has a scarred history around that handoff, so a global
	 * playback RATE would have to thread through it. Instead: the FIRST press of
	 * L is ordinary playback, with sound, at 1×. Further presses — and every
	 * press of J — walk the playhead on a rAF of their own, which is scrubbing,
	 * and scrubbing is what fast shuttle looks like in every editor anyway.
	 */
	const shuttleRate = ref(0)
	let shuttleRaf: number | null = null
	let shuttleLast = 0

	const stopShuttle = () => {
		if (shuttleRaf !== null) cancelAnimationFrame(shuttleRaf)
		shuttleRaf = null
		shuttleRate.value = 0
	}

	const shuttleTick = (now: number) => {
		shuttleRaf = requestAnimationFrame(shuttleTick)
		const dt = (now - shuttleLast) / 1000
		shuttleLast = now
		if (!shuttleRate.value) return
		const next = store.playheadSec + dt * shuttleRate.value
		if (next <= 0 || next >= store.contentEnd) {
			store.seekTo(Math.max(0, Math.min(store.contentEnd, next)))
			stopShuttle()
			return
		}
		store.seekTo(next)
	}

	const shuttle = (direction: 1 | -1) => {
		// Playing forward at 1× and pressing L again means "faster", so the
		// engine hands over to the scrub loop at 2×.
		const current = shuttleRate.value || (store.isPlaying ? 1 : 0)
		const sameWay = current !== 0 && Math.sign(current) === direction
		const speed = sameWay ? Math.min(Math.abs(current) * 2, 8) : 1

		if (direction === 1 && speed === 1) {
			stopShuttle()
			store.isPlaying = true
			return
		}
		store.isPlaying = false
		shuttleRate.value = speed * direction
		if (shuttleRaf === null) {
			shuttleLast = performance.now()
			shuttleRaf = requestAnimationFrame(shuttleTick)
		}
	}

	// ---------- Actions ----------

	const run = (id: string, event: KeyboardEvent): boolean => {
		const direction = event.key === 'ArrowRight' ? 1 : -1
		switch (id) {
			case 'play':
				stopShuttle()
				store.isPlaying = !store.isPlaying
				return true
			case 'shuttle-forward': shuttle(1); return true
			case 'shuttle-back': shuttle(-1); return true
			case 'shuttle-stop':
				stopShuttle()
				store.isPlaying = false
				return true

			case 'step':
				store.seekTo(store.playheadSec + direction * frameStep())
				return true
			case 'step-second':
				store.seekTo(store.playheadSec + direction)
				return true
			case 'go-start': store.seekTo(0); return true
			case 'go-end': store.seekTo(store.contentEnd); return true

			case 'split': store.splitAtPlayhead(); return true
			case 'trim-start': return store.trimToPlayhead('left') > 0
			case 'trim-end': return store.trimToPlayhead('right') > 0
			case 'delete':
			case 'delete-gap':
				if (!store.selectedItemIds.length) return false
				store.deleteItems(store.selectedItemIds, { ripple: id === 'delete' })
				return true
			case 'duplicate': return store.duplicateItems().length > 0
			case 'copy': return store.copyItems() > 0
			case 'paste': return store.pasteItems().length > 0
			case 'nudge':
				if (!store.selectedItemIds.length) return false
				store.nudgeItems(store.selectedItemIds, direction * frameStep())
				return true
			case 'marker': store.addMarker(store.playheadSec); return true
			case 'undo': store.undo(); return true
			case 'redo': store.redo(); return true

			case 'select-all': store.selectAllItems(); return true
			case 'deselect': store.clearItemSelection(); return true

			case 'zoom-in': options.zoomBy?.(1.25); return true
			case 'zoom-out': options.zoomBy?.(0.8); return true
			case 'snapping': store.snapEnabled = !store.snapEnabled; return true
			case 'fullscreen': options.onFullscreen?.(); return true
			case 'help': options.onHelp?.(); return true
		}
		return false
	}

	const onKeyDown = (event: KeyboardEvent) => {
		// `instanceof` first: an event dispatched at `window` has `window` as its
		// target, which has no `closest`, and calling it there threw and took the
		// WHOLE keyboard down with it.
		const target = event.target
		if (target instanceof HTMLElement &&
			target.closest('input, textarea, select, [contenteditable="true"]')) return
		if (!store.doc) return

		const shortcut = matchShortcut(event)
		if (!shortcut) return
		// `preventDefault` only once the action actually did something, so an
		// unhandled Delete with nothing selected still behaves like a Delete.
		if (run(shortcut.id, event)) event.preventDefault()
	}

	onMounted(() => window.addEventListener('keydown', onKeyDown))
	onUnmounted(() => {
		window.removeEventListener('keydown', onKeyDown)
		stopShuttle()
	})

	return { shuttleRate }
}
