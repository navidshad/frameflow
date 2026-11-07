<template>
	<div class="relative shrink-0" ref="rootRef" @keydown.esc.stop="close(true)">
		<!-- An outside agent holds the project: the chip says who is working instead -->
		<div v-if="mcp" class="flex items-center gap-1.5 px-1 py-0.5 rounded-md text-violet-500 dark:text-violet-400"
			role="status" :title="`${mcp.clientName} is working over MCP (round ${mcp.seq}). The engine can be changed when its round ends.`">
			<span class="relative flex w-1.5 h-1.5 shrink-0">
				<span class="absolute inset-0 rounded-full bg-secondary-light animate-ping opacity-75"></span>
				<span class="relative w-1.5 h-1.5 rounded-full bg-secondary-light"></span>
			</span>
			<span class="text-[11px] font-semibold max-w-[170px] truncate">MCP · {{ mcp.clientName }} working</span>
		</div>
		<button v-else
			ref="chipRef"
			class="flex items-center gap-1.5 px-1 py-0.5 rounded-md text-violet-500 dark:text-violet-400 hover:text-violet-300 transition disabled:opacity-50"
			:title="`AI engine, model and effort: ${engine.chipLabel} — click to change`"
			aria-haspopup="menu"
			:aria-expanded="open"
			:disabled="editor.promptRunning"
			@click="toggle">
			<span class="w-1.5 h-1.5 rounded-full bg-secondary-light shrink-0"></span>
			<span class="text-[11px] font-semibold max-w-[170px] truncate">{{ engine.chipLabel }}</span>
			<span class="iconify tabler--chevron-up w-2.5 h-2.5 opacity-50 transition-transform" :class="{ 'rotate-180': open }"></span>
		</button>

		<div v-if="open" ref="menuRef" role="menu" aria-label="Engine, model and effort"
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
					@click="pick(group.id, 'model', item.value)">
					<span class="flex-1 truncate">{{ item.label }}</span>
					<span v-if="item.price" class="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{{ item.price }}</span>
					<span v-if="item.checked" class="iconify tabler--check w-3.5 h-3.5 text-violet-400 shrink-0"></span>
				</button>
				<!-- How hard the engine thinks. Only an engine whose CLI has the control lists any. -->
				<div v-if="group.efforts.length" class="px-2.5 pt-1.5 pb-1">
					<div class="pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">Effort</div>
					<div class="flex flex-wrap gap-1" role="group" aria-label="Effort">
						<button v-for="item in group.efforts" :key="item.value"
							role="menuitemradio"
							:aria-checked="item.checked"
							:disabled="!group.runnable"
							class="h-6 px-2 rounded text-[11px] text-zinc-600 dark:text-zinc-300 bg-zinc-500/10 hover:bg-violet-500/15 focus-visible:bg-violet-500/15 focus-visible:outline-none transition disabled:opacity-50 disabled:hover:bg-zinc-500/10"
							:class="{ '!bg-violet-500/25 font-semibold text-violet-600 dark:text-violet-300': item.checked }"
							@click="pick(group.id, 'effort', item.value)">{{ item.label }}</button>
					</div>
				</div>
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
import {
	asSetIn, CLI_EFFORTS, CLI_ENGINE_IDS, CLI_MODELS, ENGINES, engineRunnable, isCliEngine, STATUS_LABEL,
	type CliEngineId, type EngineId
} from '@shared/engines'
import { useEngineStore } from '../../stores/engineStore'
import { useEditorStore } from '../../stores/editorStore'
import { useAgentStore } from '../../stores/agentStore'

const engine = useEngineStore()
const editor = useEditorStore()
const router = useRouter()
const agent = useAgentStore()
const mcp = computed(() => agent.mcpWorking)

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)
const chipRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)

interface Item { value: string; label: string; price?: string; checked: boolean }
interface Group { id: EngineId; runnable: boolean; note: string; items: Item[]; efforts: Item[] }

const runnable = (id: EngineId) => engineRunnable(engine.detectionFor(id))

/** Why a group is disabled, in the header's right corner; otherwise what it costs. */
const reason = (id: EngineId) => {
	const d = engine.detectionFor(id)
	if (!d) return 'Checking…'
	if (id === 'gemini-api') return 'No API key saved'
	return STATUS_LABEL[d.status]
}

/** A CLI's group, from the capability tables: its models and, where its CLI has the control, its efforts. */
const cliGroup = (id: CliEngineId): Group => {
	const current = engine.settings.engine
	const model = engine.settings.models[id] || ''
	const effort = engine.settings.efforts[id] || ''
	const models = [{ value: '', label: asSetIn(id) }, ...CLI_MODELS[id]]
	if (model && !models.some((o) => o.value === model)) models.push({ value: model, label: model })
	const ok = runnable(id)
	return {
		id, runnable: ok, note: ok ? 'your plan' : reason(id),
		items: models.map((o) => ({ ...o, checked: current === id && model === o.value })),
		efforts: [{ value: '', label: 'Default' }, ...CLI_EFFORTS[id]].map((o) => ({ ...o, checked: current === id && effort === o.value }))
	}
}

const groups = computed<Group[]>(() => {
	const current = engine.settings.engine
	const geminiOk = runnable('gemini-api')
	return [
		...CLI_ENGINE_IDS.map(cliGroup),
		{
			id: 'gemini-api', runnable: geminiOk, note: geminiOk ? 'per 1M in' : reason('gemini-api'),
			items: engine.geminiModels.map((m) => ({
				value: m.value, label: m.label, price: `$${m.inputPerM.toFixed(2)}`,
				checked: current === 'gemini-api' && engine.editorModel === m.value
			})),
			// One structured call per turn: there is no effort to turn.
			efforts: []
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

const pick = async (id: EngineId, kind: 'model' | 'effort', value: string) => {
	close(true)
	if (isCliEngine(id)) {
		const field = kind === 'model' ? 'models' : 'efforts'
		await engine.update({ engine: id, [field]: { ...engine.settings[field], [id]: value } })
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
