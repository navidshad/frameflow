<template>
	<div class="relative shrink-0" ref="rootRef" @keydown.esc.stop="close(true)">
		<button
			ref="chipRef"
			class="flex items-center gap-1.5 px-1 py-0.5 rounded-md text-violet-500 dark:text-violet-400 hover:text-violet-300 transition disabled:opacity-50"
			:title="`AI engine and model: ${engine.chipLabel} — click to change`"
			aria-haspopup="menu"
			:aria-expanded="open"
			:disabled="editor.promptRunning"
			@click="toggle">
			<span class="w-1.5 h-1.5 rounded-full bg-secondary-light shrink-0"></span>
			<span class="text-[11px] font-semibold max-w-[170px] truncate">{{ engine.chipLabel }}</span>
			<span class="iconify tabler--chevron-up w-2.5 h-2.5 opacity-50 transition-transform" :class="{ 'rotate-180': open }"></span>
		</button>

		<div v-if="open" ref="menuRef" role="menu" aria-label="Engine and model"
			class="absolute bottom-full left-0 mb-2 w-72 pop z-50 p-1.5 origin-bottom animate-menu"
			@keydown="onMenuKey">
			<template v-for="(group, gi) in groups" :key="group.id">
				<div v-if="gi > 0" class="h-px bg-zinc-200 dark:bg-zinc-800 mx-1 my-1.5" role="separator"></div>
				<div class="flex items-center gap-2 px-2.5 pt-2 pb-1.5">
					<span class="flex-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">{{ ENGINES[group.id].label }}</span>
					<span class="text-[10px] text-zinc-500">{{ group.note }}</span>
				</div>
				<button v-for="item in group.items" :key="item.value"
					role="menuitemradio"
					:aria-checked="item.checked"
					:disabled="!group.runnable"
					class="w-full h-[30px] px-2.5 rounded flex items-center gap-2 text-xs text-left text-zinc-700 dark:text-zinc-200 hover:bg-violet-500/10 focus-visible:bg-violet-500/10 focus-visible:outline-none transition disabled:opacity-50 disabled:hover:bg-transparent"
					:class="{ 'bg-violet-500/15 font-semibold': item.checked }"
					@click="pick(group.id, item.value)">
					<span class="flex-1 truncate">{{ item.label }}</span>
					<span v-if="item.price" class="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{{ item.price }}</span>
					<span v-if="item.checked" class="iconify tabler--check w-3.5 h-3.5 text-violet-400 shrink-0"></span>
				</button>
			</template>
			<div class="h-px bg-zinc-200 dark:bg-zinc-800 mx-1 my-1.5" role="separator"></div>
			<button role="menuitem"
				class="w-full h-[30px] px-2.5 rounded flex items-center gap-2 text-xs font-semibold text-zinc-500 hover:text-violet-400 hover:bg-violet-500/10 focus-visible:bg-violet-500/10 focus-visible:outline-none transition"
				@click="openSettings">
				<span class="iconify tabler--settings w-3.5 h-3.5"></span>
				Models for other jobs
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { asSetIn, CLI_MODELS, ENGINES, engineRunnable, STATUS_LABEL, type EngineId } from '@shared/engines'
import { useEngineStore } from '../../stores/engineStore'
import { useEditorStore } from '../../stores/editorStore'

const engine = useEngineStore()
const editor = useEditorStore()
const router = useRouter()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const chipRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)

interface Item { value: string; label: string; price?: string; checked: boolean }
interface Group { id: EngineId; runnable: boolean; note: string; items: Item[] }

const runnable = (id: EngineId) => engineRunnable(engine.detectionFor(id))

/** Why a group is disabled, in the header's right corner; otherwise what it costs. */
const reason = (id: EngineId) => {
	const d = engine.detectionFor(id)
	if (!d) return 'Checking…'
	if (id === 'gemini-api') return 'No API key saved'
	return STATUS_LABEL[d.status]
}

const groups = computed<Group[]>(() => {
	const current = engine.settings.engine
	const cliModel = engine.settings.models['claude-code'] || ''
	const claudeOptions = [{ value: '', label: asSetIn('claude-code') }, ...CLI_MODELS['claude-code']]
	if (cliModel && !claudeOptions.some((o) => o.value === cliModel)) claudeOptions.push({ value: cliModel, label: cliModel })
	const claudeOk = runnable('claude-code')
	const geminiOk = runnable('gemini-api')
	return [
		{
			id: 'claude-code', runnable: claudeOk, note: claudeOk ? 'your plan' : reason('claude-code'),
			items: claudeOptions.map((o) => ({ ...o, checked: current === 'claude-code' && cliModel === o.value }))
		},
		{
			id: 'gemini-api', runnable: geminiOk, note: geminiOk ? 'per 1M in' : reason('gemini-api'),
			items: engine.geminiModels.map((m) => ({
				value: m.value, label: m.label, price: `$${m.inputPerM.toFixed(2)}`,
				checked: current === 'gemini-api' && engine.editorModel === m.value
			}))
		}
	]
})

const items = () => Array.from(menuRef.value?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') || [])

const toggle = () => (open.value ? close(true) : show())

const show = async () => {
	open.value = true
	if (!engine.loaded) void engine.load()
	await nextTick()
	const list = items()
	;(list.find((el) => el.getAttribute('aria-checked') === 'true') || list[0])?.focus()
}

const close = (refocus = false) => {
	if (!open.value) return
	open.value = false
	if (refocus) void nextTick(() => chipRef.value?.focus())
}

const onMenuKey = (e: KeyboardEvent) => {
	const list = items()
	const i = list.indexOf(document.activeElement as HTMLElement)
	const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus() }
	if (e.key === 'ArrowDown') go(i + 1)
	else if (e.key === 'ArrowUp') go(i - 1)
	else if (e.key === 'Home') go(0)
	else if (e.key === 'End') go(list.length - 1)
	else if (e.key === 'Tab') close()
}

const pick = async (id: EngineId, value: string) => {
	close(true)
	if (id === 'claude-code') {
		await engine.update({ engine: id, models: { ...engine.settings.models, 'claude-code': value } })
	} else {
		await engine.setEditorModel(value)
		if (engine.settings.engine !== id) await engine.select(id)
	}
}

const openSettings = () => {
	close()
	void router.push('/settings')
}

const onDocClick = (e: MouseEvent) => {
	if (open.value && rootRef.value && !rootRef.value.contains(e.target as Node)) close()
}
onMounted(() => {
	document.addEventListener('click', onDocClick)
	if (!engine.loaded) void engine.load()
})
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>
