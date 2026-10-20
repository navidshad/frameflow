<template>
	<div class="relative shrink-0" ref="rootRef">
		<!-- Board 1: the violet chip before the persona -->
		<button
			class="flex items-center gap-1.5 px-1 py-0.5 rounded-md text-violet-500 dark:text-violet-400 hover:text-violet-300 transition"
			:title="`AI engine: ${engine.current.label} — click to switch`"
			:disabled="editor.promptRunning"
			@click="toggle">
			<span class="w-1.5 h-1.5 rounded-full bg-secondary-light shrink-0"></span>
			<span class="text-[11px] font-semibold max-w-[110px] truncate">{{ chipLabel }}</span>
			<span class="iconify tabler--chevron-up w-2.5 h-2.5 opacity-50 transition-transform" :class="{ 'rotate-180': open }"></span>
		</button>

		<div v-if="open"
			class="absolute bottom-full left-0 mb-2 w-64 pop z-50 py-2 origin-bottom animate-menu">
			<div class="px-3 pt-1 pb-1">
				<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400">AI engine</span>
			</div>
			<button v-for="id in engine.available" :key="id"
				class="w-full px-3 py-2 flex items-start gap-2.5 hover:bg-violet-500/5 transition text-left disabled:opacity-50"
				:disabled="!runnable(id)"
				@click="pick(id)">
				<span class="iconify w-3.5 h-3.5 mt-0.5 shrink-0"
					:class="id === 'gemini-api' ? 'tabler--key text-amber-400' : 'tabler--terminal text-violet-400'"></span>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-1.5">
						<span class="text-xs font-bold text-zinc-800 dark:text-zinc-200 truncate">{{ ENGINES[id].label }}</span>
						<span v-if="id === engine.settings.engine" class="iconify tabler--check w-3 h-3 text-violet-400 shrink-0"></span>
					</div>
					<p class="text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug truncate">{{ subline(id) }}</p>
				</div>
			</button>
			<div class="border-t border-zinc-200 dark:border-zinc-800 mt-1 pt-1 px-2">
				<button
					class="w-full px-2 py-2 rounded-xl flex items-center gap-2 text-xs font-bold text-zinc-500 hover:text-violet-400 hover:bg-violet-500/10 transition"
					@click="openSettings">
					<span class="iconify tabler--settings w-3.5 h-3.5"></span>
					Engine settings
				</button>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ENGINES, engineRunnable, STATUS_LABEL, type EngineId } from '@shared/engines'
import { useEngineStore } from '../../stores/engineStore'
import { useEditorStore } from '../../stores/editorStore'

const engine = useEngineStore()
const editor = useEditorStore()
const router = useRouter()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)

const chipLabel = computed(() => engine.current.label)

const runnable = (id: EngineId) => engineRunnable(engine.detectionFor(id))

const subline = (id: EngineId) => {
	const d = engine.detectionFor(id)
	if (!d) return ''
	if (id === 'gemini-api') return d.status === 'per-token' ? 'Per token · your API key' : 'No API key saved'
	const status = STATUS_LABEL[d.status]
	return [d.version ? `v${d.version}` : null, status].filter(Boolean).join(' · ')
}

const toggle = () => {
	open.value = !open.value
	if (open.value && !engine.loaded) void engine.load()
}

const pick = async (id: EngineId) => {
	open.value = false
	if (id !== engine.settings.engine) await engine.select(id)
}

const openSettings = () => {
	open.value = false
	void router.push('/settings')
}

const onDocClick = (e: MouseEvent) => {
	if (open.value && rootRef.value && !rootRef.value.contains(e.target as Node)) open.value = false
}
onMounted(() => {
	document.addEventListener('click', onDocClick)
	if (!engine.loaded) void engine.load()
})
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>
