import { ref } from 'vue'

/**
 * Files and folders dragged in from the OS, anywhere on the editor.
 *
 * Only a drag that carries `Files` is ours: the editor's own drags (clips,
 * effects, transitions) carry their own types and pass through untouched. The
 * handlers sit on the page root and listen in the bubble phase, so a lane that
 * refused the drag (dropEffect 'none') is overruled by the time it gets here.
 *
 * A folder arrives as a File whose path is the folder; `webUtils.getPathForFile`
 * (via `api.pathForFile`) gives it, and main walks it.
 */
export function useFileDrop(onPaths: (paths: string[]) => void, enabled: () => boolean = () => true) {
	const api = (window as any).api
	const over = ref(false)

	const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')

	const onDragEnter = (e: DragEvent) => {
		if (!carriesFiles(e) || !enabled()) return
		e.preventDefault()
		over.value = true
	}

	const onDragOver = (e: DragEvent) => {
		if (!carriesFiles(e) || !enabled()) return
		e.preventDefault()
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
		over.value = true
	}

	// dragleave also fires moving onto a child; only a true exit from the page ends the hover.
	const onDragLeave = (e: DragEvent) => {
		if (!over.value) return
		if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) over.value = false
	}

	const onDrop = (e: DragEvent) => {
		if (!carriesFiles(e)) return
		e.preventDefault()
		over.value = false
		if (!enabled()) return
		const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => api.pathForFile(f) as string).filter(Boolean)
		if (paths.length) onPaths(paths)
	}

	// Bound with `v-on="handlers"`: the keys are event names.
	return { over, handlers: { dragenter: onDragEnter, dragover: onDragOver, dragleave: onDragLeave, drop: onDrop } }
}
