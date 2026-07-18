<template>
	<div class="relative" ref="rootRef">
		<button
			class="w-7 h-7 flex items-center justify-center rounded-lg transition active:scale-95"
			:class="store.revisionDirty || store.revisions.length === 0
				? 'text-secondary hover:bg-secondary/10'
				: 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'"
			title="Save the current timeline as a revision"
			@click="open = !open">
			<span class="iconify tabler--bookmark-plus w-4 h-4"></span>
		</button>

		<!-- Inline popover -->
		<div v-if="open"
			class="absolute top-full right-0 mt-2 w-56 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl shadow-premium z-50 p-3 animate-fade-in-up">
			<template v-if="cleanNotice">
				<p class="text-[11px] text-zinc-500 leading-snug">
					No changes since <span class="font-mono font-bold text-primary">V{{ store.currentRevision?.seq }}</span>.
				</p>
			</template>
			<template v-else>
				<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1.5">
					Save revision
				</label>
				<input ref="inputRef" v-model="label" type="text" placeholder="Label (optional)"
					class="w-full px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-xs text-zinc-800 dark:text-zinc-200 input-focus-ring mb-2"
					@keyup.enter="save" />
				<button
					class="w-full px-3 py-1.5 rounded-lg bg-secondary text-white text-xs font-bold shadow-md shadow-secondary/20 hover:opacity-90 transition active:scale-95"
					@click="save">
					Save
				</button>
			</template>
		</div>
	</div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useEditorStore } from '../../stores/editorStore'

const store = useEditorStore()

const open = ref(false)
const label = ref('')
const cleanNotice = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)

watch(open, async (isOpen) => {
	if (isOpen) {
		cleanNotice.value = store.revisions.length > 0 && !store.revisionDirty
		label.value = ''
		await nextTick()
		inputRef.value?.focus()
	}
})

const save = async () => {
	const result = await store.saveCheckpoint(label.value)
	if (result === 'clean') {
		cleanNotice.value = true
	} else {
		open.value = false
	}
}

const onDocClick = (e: MouseEvent) => {
	if (open.value && rootRef.value && !rootRef.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>
