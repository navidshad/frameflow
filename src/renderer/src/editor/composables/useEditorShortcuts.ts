import { onMounted, onUnmounted } from 'vue'
import { useEditorStore } from '../../stores/editorStore'

/**
 * Global keyboard shortcuts for the editor page (PRD §5.11).
 * Never fires while the user is typing in an input/textarea/select/
 * contenteditable — that guard is the first line.
 *
 * Space        play/pause          M              add marker at playhead
 * ← / →        frame-step playhead S or Cmd/Ctrl+B split at playhead
 * Shift+←/→    nudge selection 1f  Delete/Backsp  ripple-delete selection
 * Alt+Shift+←/→ nudge 1s           Shift+Delete   delete leaving gap
 * Home / End   sequence start/end  Cmd/Ctrl+Z     undo
 * + / -        zoom                Cmd/Ctrl+Shift+Z redo
 * Esc          clear selection
 */
export function useEditorShortcuts(zoomBy?: (factor: number) => void) {
	const store = useEditorStore()

	const frameStep = () => 1 / (store.doc?.timelineMeta.fps || 30)

	const onKeyDown = (e: KeyboardEvent) => {
		const target = e.target as HTMLElement | null
		if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
		if (!store.doc) return

		const meta = e.metaKey || e.ctrlKey

		// Undo / redo
		if (meta && e.key.toLowerCase() === 'z') {
			e.preventDefault()
			if (e.shiftKey) store.redo()
			else store.undo()
			return
		}

		// Split
		if ((meta && e.key.toLowerCase() === 'b') || (!meta && (e.key === 's' || e.key === 'S'))) {
			e.preventDefault()
			store.splitAtPlayhead()
			return
		}

		switch (e.key) {
			case ' ':
				e.preventDefault()
				store.isPlaying = !store.isPlaying
				return
			case 'ArrowLeft':
			case 'ArrowRight': {
				e.preventDefault()
				const direction = e.key === 'ArrowRight' ? 1 : -1
				if (e.shiftKey && store.selectedItemIds.length) {
					store.nudgeItems(store.selectedItemIds, direction * (e.altKey ? 1 : frameStep()))
				} else {
					store.seekTo(store.playheadSec + direction * (e.altKey ? 1 : frameStep()))
				}
				return
			}
			case 'Home':
				e.preventDefault()
				store.seekTo(0)
				return
			case 'End':
				e.preventDefault()
				store.seekTo(store.contentEnd)
				return
			case 'Delete':
			case 'Backspace':
				if (store.selectedItemIds.length) {
					e.preventDefault()
					store.deleteItems(store.selectedItemIds, { ripple: !e.shiftKey && !e.altKey })
				}
				return
			case 'm':
			case 'M':
				e.preventDefault()
				store.addMarker(store.playheadSec)
				return
			case '+':
			case '=':
				e.preventDefault()
				zoomBy?.(1.25)
				return
			case '-':
			case '_':
				e.preventDefault()
				zoomBy?.(0.8)
				return
			case 'Escape':
				store.clearItemSelection()
				return
		}
	}

	onMounted(() => window.addEventListener('keydown', onKeyDown))
	onUnmounted(() => window.removeEventListener('keydown', onKeyDown))
}
