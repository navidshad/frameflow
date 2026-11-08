<template>
	<AppDialog :model-value="modelValue" title="Thumbnail prompt" size="lg" :closable="!busy"
		@update:model-value="(v: boolean) => !busy && emit('update:modelValue', v)">
		<p class="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
			This is the message the new thumbnail project starts with. It is made from your video's title and what is said in the cut.
			Rewrite any of it: what you leave here is what is sent.
		</p>

		<label for="thumbnail-prompt" class="sr-only">Thumbnail prompt</label>
		<textarea id="thumbnail-prompt" ref="field" v-model="text" rows="13" spellcheck="false" :disabled="busy"
			class="mt-3 w-full px-2.5 py-2 rounded-md text-xs leading-relaxed bg-zinc-100 dark:bg-zinc-800
			       border border-zinc-200 dark:border-zinc-700 focus:border-primary outline-none resize-y"
			@keydown.meta.enter.prevent="submit" @keydown.ctrl.enter.prevent="submit"></textarea>

		<p class="mt-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
			The frames are chosen from your video and added to the project for you. The image model gets this message together with those
			frames; it is first turned into a detailed brief that refers to people by description, not by name.
		</p>

		<template #footer-start>
			<button class="btn-text" :disabled="busy || !changed" @click="text = suggested">Use the suggested prompt</button>
		</template>
		<template #footer>
			<button class="btn-text" :disabled="busy" @click="emit('update:modelValue', false)">Cancel</button>
			<button class="btn-fill" :disabled="busy || !text.trim()" @click="submit">
				{{ busy ? 'Making the project…' : 'Generate thumbnail' }}
			</button>
		</template>
	</AppDialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import AppDialog from '../../components/AppDialog.vue'

/**
 * The prompt a thumbnail starts from, in the person's hands before anything is
 * made. Generating costs real API calls, so the dialog is the last stop: the
 * suggested prompt is already written, and the person keeps it, edits a line,
 * or writes their own.
 */
const props = defineProps<{ modelValue: boolean; suggested: string; busy: boolean }>()
const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void
	(e: 'generate', prompt: string): void
}>()

const text = ref(props.suggested)
const field = ref<HTMLTextAreaElement | null>(null)
const changed = computed(() => text.value.trim() !== props.suggested.trim())

// Each time it opens it starts from the suggestion: nothing typed last time is carried over.
watch(() => props.modelValue, (open) => {
	if (!open) return
	text.value = props.suggested
	void nextTick(() => field.value?.focus())
})

const submit = () => {
	if (props.busy || !text.value.trim()) return
	emit('generate', text.value)
}
</script>
