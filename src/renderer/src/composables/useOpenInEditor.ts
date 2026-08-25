import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useVideoStore } from '../stores/videoStore'

/**
 * "Open in Editor" — fork a graph node into a timeline project and go there.
 *
 * Lives here rather than in the nodes so MediaNode/VideoNode stay presentational.
 * No manual graph refresh is needed: the main process broadcasts thread-updated
 * after writing the manual-edit node, videoStore merges it, and useGraphLayout's
 * deep watch re-syncs the canvas.
 */
export function useOpenInEditor() {
	const router = useRouter()
	const videoStore = useVideoStore()

	const busy = ref(false)
	const error = ref<string | null>(null)

	/** @param nodeId 'root-media' for the whole source, or a result Message.id. */
	const openInEditor = async (nodeId: string) => {
		if (busy.value) return
		const threadId = videoStore.currentThreadId
		if (!threadId) return

		busy.value = true
		error.value = null
		try {
			const result = await (window as any).api.promoteToEditor({ threadId, nodeId })
			if (result?.warnings?.length) {
				console.warn('[open-in-editor] partial artifact reuse:', result.warnings)
			}
			router.push(`/editor/${result.editorThreadId}`)
		} catch (e: any) {
			error.value = e?.message?.replace(/^Error invoking remote method '.*?':\s*/, '')
				|| 'Could not open the editor.'
			await (window as any).api.showConfirmation({
				title: 'Could not open the editor',
				message: error.value,
				type: 'warning',
				buttons: ['OK'],
				defaultId: 0,
				cancelId: 0
			})
		} finally {
			busy.value = false
		}
	}

	return { openInEditor, busy, error }
}
