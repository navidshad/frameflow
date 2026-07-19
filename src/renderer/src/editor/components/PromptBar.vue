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

		<!-- Flat input zone: the panel's border-t is the only frame. -->
		<div>
			<textarea ref="inputRef" v-model="text" rows="1"
				class="w-full bg-transparent resize-none outline-none text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 max-h-24 custom-scrollbar py-1"
				:placeholder="placeholder" :disabled="inputDisabled"
				@input="autoGrow" @keydown.enter.exact.prevent="submit"></textarea>

			<!-- Meta row: quiet text controls left, send right -->
			<div class="flex items-center gap-1 mt-0.5">
				<PersonaPicker />

				<span class="text-zinc-300 dark:text-zinc-700 text-[9px]">·</span>

				<!-- Scope: text-level control — owns the flexible space so it
				     truncates with clearance before the send button -->
				<div class="relative flex-1 min-w-0" ref="scopeRef">
					<button v-if="store.scopePreview"
						class="max-w-full flex items-center gap-1 px-1 py-0.5 rounded-md text-zinc-500 hover:text-secondary transition min-w-0"
						:title="'What the AI can see — click to change'"
						@click="scopeMenuOpen = !scopeMenuOpen">
						<span class="iconify tabler--focus-2 w-2.5 h-2.5 text-secondary/70 shrink-0"></span>
						<span class="text-[9px] font-bold uppercase tracking-widest truncate">
							{{ store.scopePreview.label }}
						</span>
					</button>
					<div v-if="scopeMenuOpen"
						class="absolute bottom-full left-0 mb-2 w-48 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl shadow-premium z-50 py-1 animate-fade-in-up">
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
					class="ml-2 shrink-0 w-6 h-6 rounded-full flex items-center justify-center transition active:scale-95"
					:class="store.promptRunning
						? 'bg-red-500 text-white hover:bg-red-600'
						: canSend
							? 'bg-primary text-white hover:bg-primary-dark'
							: 'text-zinc-300 dark:text-zinc-600 cursor-not-allowed'"
					:title="store.promptRunning ? 'Stop' : 'Send (Enter)'"
					@click="store.promptRunning ? store.abortPrompt() : submit()">
					<span v-if="store.promptRunning" class="iconify tabler--player-stop-filled w-2.5 h-2.5"></span>
					<span v-else class="iconify tabler--send w-3 h-3"></span>
				</button>
			</div>
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
