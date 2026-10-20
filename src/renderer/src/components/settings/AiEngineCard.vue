<template>
	<!-- Board 4, upper card -->
	<Card
		class="!bg-white/90 dark:!bg-zinc-900/90 backdrop-blur-xl !rounded-lg border !border-zinc-200 dark:!border-zinc-700 !p-8">
		<div class="flex items-center gap-5 mb-8">
			<div
				class="w-14 h-14 rounded-lg bg-purple-50 dark:bg-purple-500/10 flex items-center justify-center text-purple-600 dark:text-purple-400 border border-purple-100 dark:border-purple-500/20 shrink-0">
				<span class="iconify tabler--terminal w-7 h-7"></span>
			</div>
			<div>
				<h3 class="font-heading font-bold text-xl text-zinc-900 dark:text-white">AI engine</h3>
				<p class="text-sm text-zinc-500 dark:text-zinc-400 font-medium">Which AI edits when you chat in FrameFlow. A CLI you already use runs on your own plan.</p>
			</div>
			<button
				class="ml-auto px-2.5 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs font-semibold text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5 transition hover:border-primary/40 hover:text-primary shrink-0 disabled:opacity-50"
				:disabled="engine.detecting" @click="engine.detect()">
				<span class="iconify tabler--refresh w-3.5 h-3.5" :class="{ 'animate-spin': engine.detecting }"></span>
				{{ engine.detecting ? 'Detecting…' : 'Detect again' }}
			</button>
		</div>

		<!-- Four radio cards -->
		<div class="grid grid-cols-2 gap-3" role="radiogroup" aria-label="AI engine">
			<button v-for="id in ENGINE_IDS" :key="id" role="radio" :aria-checked="selected === id"
				class="flex flex-col gap-1.5 p-4 rounded-lg border text-left transition disabled:cursor-not-allowed"
				:class="selected === id
					? 'border-purple-500 bg-purple-500/[0.08] ring-1 ring-purple-500/40'
					: 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/50 hover:border-purple-500/30'"
				:disabled="!selectable(id)"
				@click="engine.select(id)">
				<span class="flex items-center gap-2 w-full">
					<span class="w-4 h-4 rounded-full box-border shrink-0"
						:class="selected === id ? 'border-[5px] border-purple-500' : 'border-2 border-zinc-400 dark:border-zinc-600'"></span>
					<span class="text-sm font-bold" :class="selected === id ? 'text-zinc-900 dark:text-white' : 'text-zinc-700 dark:text-zinc-200'">{{ ENGINES[id].label }}</span>
					<span v-if="badge(id)" class="ml-auto px-1.5 py-0.5 rounded text-[9px] font-bold uppercase" :class="badge(id)!.cls">{{ badge(id)!.text }}</span>
				</span>
				<span class="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 pl-6 truncate w-full">{{ where(id) }}</span>
				<span class="text-xs pl-6 leading-normal"
					:class="selected === id ? 'text-zinc-700 dark:text-zinc-300' : 'text-zinc-500 dark:text-zinc-400'">{{ blurb(id) }}</span>
			</button>
		</div>

		<!-- Model + steps -->
		<div class="grid grid-cols-2 gap-3 mt-4">
			<div class="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800">
				<label for="eng-model" class="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2">Model</label>
				<div class="relative">
					<select id="eng-model"
						class="w-full appearance-none px-4 py-2 pr-9 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm font-medium text-zinc-900 dark:text-white outline-none focus:border-purple-500 disabled:opacity-60"
						:disabled="!engine.isCli" :value="modelValue" @change="setModel(($event.target as HTMLSelectElement).value)">
						<option v-if="!engine.isCli" value="">Set under Model Selection below</option>
						<option v-for="m in engine.modelOptions" :key="m.value" :value="m.value">{{ m.label }}</option>
					</select>
					<span class="iconify tabler--chevron-down w-3.5 h-3.5 text-zinc-400 absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none"></span>
				</div>
			</div>
			<div class="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800">
				<span class="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2">Steps per turn</span>
				<div class="flex items-center gap-3 h-[38px]" :class="{ 'opacity-50': !engine.isCli }">
					<input type="range" class="steps-range flex-1" :min="STEPS_MIN" :max="STEPS_MAX" step="1"
						:style="{ '--fill': `${fill}%` }"
						:disabled="!engine.isCli" :value="steps" aria-label="Steps per turn"
						@input="steps = Number(($event.target as HTMLInputElement).value)"
						@change="engine.update({ maxSteps: steps })" />
					<span class="font-mono text-[13px] text-zinc-900 dark:text-white shrink-0">{{ engine.isCli ? `up to ${steps}` : 'one reply' }}</span>
				</div>
			</div>
		</div>

		<p v-if="selectedNote" class="mt-4 text-xs text-red-500 leading-relaxed">{{ selectedNote }}</p>

		<div class="mt-4 px-3.5 py-2.5 rounded-lg bg-zinc-500/5 border border-zinc-500/10 flex gap-2 items-center text-xs text-zinc-500 dark:text-zinc-400">
			<span class="iconify tabler--info-circle w-3.5 h-3.5 shrink-0"></span>
			Transcripts and scene descriptions still run on your Gemini API key: they upload audio and frames.
		</div>
	</Card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Card } from 'pilotui/elements'
import {
	ENGINE_IDS, ENGINES, engineRunnable, isCliEngine, STATUS_LABEL, STATUS_TONE, STEPS_MAX, STEPS_MIN, type EngineId
} from '@shared/engines'
import { useEngineStore } from '../../stores/engineStore'

const engine = useEngineStore()

const selected = computed(() => engine.settings.engine)
const steps = ref(engine.settings.maxSteps)
watch(() => engine.settings.maxSteps, (v) => { steps.value = v })
const fill = computed(() => ((steps.value - STEPS_MIN) / (STEPS_MAX - STEPS_MIN)) * 100)

const TONE_CLASS: Record<string, string> = {
	green: 'bg-emerald-500/10 text-emerald-500',
	zinc: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400',
	amber: 'bg-amber-500/10 text-amber-500 dark:text-amber-400',
	red: 'bg-red-500/10 text-red-500'
}

const badge = (id: EngineId) => {
	const d = engine.detectionFor(id)
	if (!d) return engine.detecting ? { text: '…', cls: TONE_CLASS.zinc } : null
	return { text: STATUS_LABEL[d.status], cls: TONE_CLASS[STATUS_TONE[d.status]] }
}

const where = (id: EngineId) => {
	const d = engine.detectionFor(id)
	if (id === 'gemini-api') return d?.status === 'per-token' ? 'API key saved · today’s engine' : 'No API key saved'
	if (!d) return 'Looking…'
	if (d.status === 'missing') return 'Not on this computer'
	return [d.version ? `v${d.version}` : null, d.displayPath].filter(Boolean).join(' · ')
}

/** The status note replaces the blurb when the user has to do something. */
const blurb = (id: EngineId) => {
	const d = engine.detectionFor(id)
	if (d && (d.status === 'missing' || d.status === 'signed-out') && d.note) return d.note
	return ENGINES[id].blurb
}

const selectable = (id: EngineId) => id === selected.value || engineRunnable(engine.detectionFor(id))

const selectedNote = computed(() => {
	const d = engine.detectionFor(selected.value)
	return d?.status === 'unusable' ? d.note : null
})

const modelValue = computed(() => {
	const id = selected.value
	return isCliEngine(id) ? engine.settings.models[id] || '' : ''
})

const setModel = (value: string) => {
	const id = selected.value
	if (isCliEngine(id)) void engine.update({ models: { [id]: value } })
}

onMounted(() => {
	if (!engine.loaded) void engine.load()
})
</script>

<style scoped>
/* Board 4: a 4px track, violet fill to the thumb, a 14px violet thumb. */
.steps-range {
	-webkit-appearance: none;
	appearance: none;
	height: 4px;
	border-radius: 2px;
	background: linear-gradient(to right, #a855f7 var(--fill), #3f3f46 var(--fill));
	outline: none;
}
.steps-range::-webkit-slider-thumb {
	-webkit-appearance: none;
	width: 14px;
	height: 14px;
	border-radius: 50%;
	background: #a855f7;
	cursor: pointer;
}
.steps-range:disabled::-webkit-slider-thumb { cursor: not-allowed; }
</style>
