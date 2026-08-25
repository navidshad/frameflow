import { computed, type Ref } from 'vue'
import type { EditorRevision } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'
import { originMeta, relativeTime, revisionThumbs } from '../utils/revisionThumbs'

/**
 * Everything a revision card needs, list or graph.
 *
 * Both renderers derived this state independently and drifted: the graph never
 * honoured `promptRunning`, never showed the unsaved-changes marker, and had no
 * origin tooltip. One source keeps them in step.
 */
export function useRevisionCard(revision: Ref<EditorRevision>, opts?: { thumbCount?: number }) {
	const store = useEditorStore()
	const thumbCount = opts?.thumbCount ?? 1

	const isCurrent = computed(() => store.doc?.currentRevisionId === revision.value.id)

	/** Unsaved edits sit on top of THIS revision — the amber asterisk. */
	const isDirtyHere = computed(() => isCurrent.value && store.revisionDirty)

	/** Switching mid-turn is refused by the store; the UI must say so too. */
	const disabled = computed(() => store.promptRunning)

	/** The root anchors every parent chain and can never be removed. */
	const canDelete = computed(() => revision.value.parentId !== null)

	const thumbs = computed(() => revisionThumbs(revision.value, store.doc, thumbCount))
	const time = computed(() => relativeTime(revision.value.createdAt))
	const itemCount = computed(() => revision.value.snapshot.timeline.length)

	const origin = computed(() => originMeta(revision.value.origin))
	const personaIcon = computed(
		() => store.personas.find((p) => p.id === revision.value.personaId)?.icon || '✨'
	)

	const title = computed(() => {
		if (disabled.value) return 'Wait for the AI edit to finish'
		return isCurrent.value ? 'Current revision' : 'Switch to this revision'
	})

	const switchTo = () => {
		if (disabled.value || isCurrent.value) return
		store.switchRevision(revision.value.id)
	}

	const remove = () => {
		if (!canDelete.value) return
		store.deleteRevisionSubtree(revision.value.id)
	}

	return {
		isCurrent, isDirtyHere, disabled, canDelete,
		thumbs, time, itemCount, origin, personaIcon, title,
		switchTo, remove
	}
}
