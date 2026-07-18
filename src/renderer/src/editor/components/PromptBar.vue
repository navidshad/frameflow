<template>
	<div class="shrink-0">
		<!-- Inline error -->
		<div v-if="store.promptError"
			class="mb-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-between gap-2 animate-fade-in-up">
			<p class="text-[11px] font-medium text-red-500 leading-snug">{{ store.promptError }}</p>
			<button v-if="lastPrompt"
				class="px-2 py-1 rounded-lg bg-red-500/10 text-red-500 text-[10px] font-bold uppercase tracking-widest hover:bg-red-500/20 transition shrink-0"
				@click="retry">
				Retry
			</button>
		</div>

		<div
			class="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-950/20 backdrop-blur-xl shadow-lg px-3 py-2.5 flex items-end gap-2 input-focus-ring">
			<!-- Persona picker chip -->
			<PersonaPicker class="mb-0.5" />

			<!-- Input -->
			<textarea ref="inputRef" v-model="text" rows="1"
				class="flex-1 bg-transparent resize-none outline-none text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 max-h-24 custom-scrollbar py-1.5"
				:placeholder="placeholder" :disabled="inputDisabled"
				@input="autoGrow" @keydown.enter.exact.prevent="submit"></textarea>

			<!-- Scope chip -->
			<div class="relative mb-0.5" ref="scopeRef">
				<button v-if="store.scopePreview"
					class="shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:border-secondary/40 transition"
					:title="'What the AI can see — click to change'"
					@click="scopeMenuOpen = !scopeMenuOpen">
					<span class="iconify tabler--focus-2 w-3 h-3 text-secondary"></span>
					<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-500 max-w-[140px] truncate">
						{{ store.scopePreview.label }}
					</span>
				</button>
				<div v-if="scopeMenuOpen"
					class="absolute bottom-full right-0 mb-2 w-48 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl shadow-premium z-50 py-1 animate-fade-in-up">
					<button v-for="option in scopeOptions" :key="option.value"
						class="w-full px-3 py-1.5 flex items-center justify-between text-left hover:bg-primary/5 transition"
						@click="setScope(option.value)">
						<span class="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">{{ option.label }}</span>
						<span v-if="store.scopeWiden === option.value" class="iconify tabler--check w-3 h-3 text-primary"></span>
					</button>
				</div>
			</div>

			<!-- Send / Stop -->
			<button
				class="shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition active:scale-95 mb-0.5"
				:class="store.promptRunning
					? 'bg-red-500 text-white shadow-md shadow-red-500/20 hover:bg-red-600'
					: canSend
						? 'bg-primary text-white shadow-md shadow-primary/20 hover:bg-primary-dark'
						: 'bg-zinc-200 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed'"
				:title="store.promptRunning ? 'Stop' : 'Send (Enter)'"
				@click="store.promptRunning ? store.abortPrompt() : submit()">
				<span v-if="store.promptRunning" class="iconify tabler--player-stop-filled w-3 h-3"></span>
				<span v-else class="iconify tabler--send w-3.5 h-3.5"></span>
			</button>
		</div>

		<!-- Running status -->
		<div v-if="store.promptRunning" class="mt-1.5 flex items-center gap-2 px-2">
			<div class="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin"></div>
			<span class="text-[10px] font-medium text-zinc-500">
				{{ store.activePersona?.name || 'AI' }} is working on your edit…
			</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import PersonaPicker from './PersonaPicker.vue'

const store = useEditorStore()

const text = ref('')
const lastPrompt = ref('')
const scopeMenuOpen = ref(false)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const scopeRef = ref<HTMLElement | null>(null)

const inputDisabled = computed(() => store.promptRunning)

const placeholder = computed(() => {
	if (store.isEmpty) return 'Import media first, then ask your editor persona for a cut'
	return `Ask ${store.activePersona?.name || 'your editor'} to build or refine the cut…`
})

const canSend = computed(() => text.value.trim().length > 0 && !inputDisabled.value)

const scopeOptions = computed(() => [
	{
		value: 'auto' as const,
		label: store.selectedItemIds.length ? `Auto (selection · ${store.selectedItemIds.length})` : 'Auto'
	},
	{ value: 'chapter' as const, label: 'Current chapter' },
	{ value: 'full' as const, label: 'Whole timeline' }
])

const setScope = (value: 'auto' | 'chapter' | 'full') => {
	store.scopeWiden = value
	scopeMenuOpen.value = false
}

const autoGrow = () => {
	const el = inputRef.value
	if (!el) return
	el.style.height = 'auto'
	el.style.height = `${Math.min(el.scrollHeight, 96)}px`
}

const submit = () => {
	if (!canSend.value) return
	lastPrompt.value = text.value.trim()
	store.runPrompt(lastPrompt.value)
	text.value = ''
	autoGrow()
}

const retry = () => {
	if (lastPrompt.value) store.runPrompt(lastPrompt.value)
}

const onDocClick = (e: MouseEvent) => {
	if (scopeMenuOpen.value && scopeRef.value && !scopeRef.value.contains(e.target as Node)) {
		scopeMenuOpen.value = false
	}
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>
