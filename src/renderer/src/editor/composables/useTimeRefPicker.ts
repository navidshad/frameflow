import { computed, nextTick, ref, watch, type Ref, type WritableComputedRef } from 'vue'
import { atQuery, timeRefOptions, timeRefToken, type TimeRefOption } from '@shared/promptRefs'
import { useEditorStore } from '../../stores/editorStore'
import { useEngineStore } from '../../stores/engineStore'

/**
 * The @ picker behind a composer field: it opens while the caret sits in an
 * `@…`, lists what that could mean (the frame, the playhead, the selected
 * clip's ends, the markers, a typed time), and replaces the `@…` with the
 * chosen reference. Shared by the chat's prompt bar and the folded strip, which
 * share one draft.
 */
export function useTimeRefPicker(text: WritableComputedRef<string>, el: Ref<HTMLTextAreaElement | HTMLInputElement | null>) {
	const store = useEditorStore()
	const engine = useEngineStore()

	const caret = ref(0)
	/** Escape closes the picker for this `@` only; typing a new one opens it again. */
	const dismissedAt = ref<number | null>(null)
	const active = ref(0)

	const query = computed(() => atQuery(text.value, caret.value))
	const canCapture = computed(() => !!store.doc?.timeline.length && engine.current.images)
	const options = computed<TimeRefOption[]>(() => {
		if (!query.value || !store.doc) return []
		return timeRefOptions(query.value.query, {
			timeline: store.doc.timeline,
			tracks: store.doc.tracks,
			media: store.doc.media,
			markers: store.markers,
			playheadSec: store.playheadSec,
			selected: store.selectedItems,
			canCapture: canCapture.value
		})
	})
	const open = computed(() => !!query.value && dismissedAt.value !== query.value.start && options.value.length > 0)
	watch(() => query.value?.query, () => { active.value = 0 })

	/** Read the caret after every keystroke and click: the picker follows it. */
	const sync = () => {
		const node = el.value
		caret.value = node?.selectionStart ?? text.value.length
		if (dismissedAt.value !== null && query.value?.start !== dismissedAt.value) dismissedAt.value = null
	}

	const pick = (row: TimeRefOption) => {
		const q = query.value
		if (!q) return
		const before = text.value.slice(0, q.start)
		const after = text.value.slice(caret.value)
		// A frame is an attachment, not words: the `@…` that asked for it goes.
		const insert = row.frame ? '' : `${timeRefToken(row.sec)}${after.startsWith(' ') ? '' : ' '}`
		text.value = before + insert + after
		const at = before.length + insert.length
		caret.value = at
		if (row.frame) void store.captureFrameForPrompt()
		nextTick(() => {
			const node = el.value
			if (!node) return
			node.focus()
			node.setSelectionRange(at, at)
		})
	}

	/** True when the key was the picker's (the field must not also act on it). */
	const onKeydown = (e: KeyboardEvent): boolean => {
		if (!open.value) return false
		const count = options.value.length
		switch (e.key) {
			case 'ArrowDown': active.value = (active.value + 1) % count; break
			case 'ArrowUp': active.value = (active.value - 1 + count) % count; break
			case 'Enter':
			case 'Tab': pick(options.value[active.value]); break
			case 'Escape': dismissedAt.value = query.value!.start; break
			default: return false
		}
		e.preventDefault()
		e.stopPropagation()
		return true
	}

	return { open, options, active, pick, onKeydown, sync }
}
