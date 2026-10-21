<template>
	<SettingsSection title="AI engine"
		description="Which AI edits when you chat in FrameFlow. A CLI you already use runs on your own plan.">
		<div class="flex justify-end -mt-1 mb-3">
			<button class="btn-text btn-text-primary" :disabled="engine.detecting" @click="engine.detect()">
				<span class="iconify tabler--refresh w-3.5 h-3.5" :class="{ 'animate-spin': engine.detecting }"></span>
				{{ engine.detecting ? 'Detecting…' : 'Detect again' }}
			</button>
		</div>

		<!-- Radio options: AI is violet -->
		<div class="flex flex-wrap gap-3.5" role="radiogroup" aria-label="AI engine">
			<button v-for="id in ENGINE_IDS" :key="id" role="radio" :aria-checked="selected === id"
				class="flex-1 min-w-[220px] flex flex-col gap-1.5 p-3.5 rounded text-left transition disabled:cursor-not-allowed disabled:opacity-60"
				:class="selected === id ? 'bg-secondary/[0.07] ring-1 ring-inset ring-secondary/60' : 'ring-1 ring-inset ring-[color:var(--ff-hairline-strong)] hover:ring-secondary/40'"
				:disabled="!selectable(id)"
				@click="engine.select(id)">
				<span class="flex items-center gap-2 w-full">
					<span class="w-4 h-4 rounded-full box-border shrink-0"
						:class="selected === id ? 'border-[5px] border-secondary' : 'border-2 border-zinc-400 dark:border-zinc-600'"></span>
					<span class="text-[13px] font-bold">{{ ENGINES[id].label }}</span>
					<span v-if="badge(id)" class="ml-auto text-[9px] font-bold uppercase" :class="badge(id)!.cls">{{ badge(id)!.text }}</span>
				</span>
				<span class="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 pl-6 truncate w-full">{{ where(id) }}</span>
				<span class="text-xs pl-6 leading-normal"
					:class="selected === id ? 'text-zinc-700 dark:text-zinc-200' : 'text-zinc-500 dark:text-zinc-400'">{{ blurb(id) }}</span>
			</button>
		</div>

		<!-- Model + steps -->
		<div class="grid grid-cols-2 gap-10 mt-5 max-sm:grid-cols-1">
			<div>
				<label for="eng-model" class="lbl block">Model</label>
				<select id="eng-model" class="field" :disabled="!engine.isCli" :value="modelValue"
					@change="setModel(($event.target as HTMLSelectElement).value)">
					<option v-if="!engine.isCli" value="">Set under Model Selection below</option>
					<option v-for="m in engine.modelOptions" :key="m.value" :value="m.value">{{ m.label }}</option>
				</select>
			</div>
			<div>
				<span class="lbl block">Steps per turn</span>
				<div class="flex items-center gap-3 h-[30px]" :class="{ 'opacity-50': !engine.isCli }">
					<input type="range" class="steps-range flex-1" :min="STEPS_MIN" :max="STEPS_MAX" step="1"
						:style="{ '--fill': `${fill}%` }"
						:disabled="!engine.isCli" :value="steps" aria-label="Steps per turn"
						@input="steps = Number(($event.target as HTMLInputElement).value)"
						@change="engine.update({ maxSteps: steps })" />
					<span class="font-mono text-xs shrink-0">{{ engine.isCli ? `up to ${steps}` : 'one reply' }}</span>
				</div>
			</div>
		</div>

		<p v-if="selectedNote" class="mt-4 text-xs text-red-500 leading-relaxed">{{ selectedNote }}</p>

		<p class="mt-4 flex gap-2 items-center text-[11px] text-zinc-500 dark:text-zinc-400">
			<span class="iconify tabler--info-circle w-3.5 h-3.5 shrink-0"></span>
			Transcripts and scene descriptions still run on your Gemini API key: they upload audio and frames.
		</p>
	</SettingsSection>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
	ENGINE_IDS, ENGINES, engineRunnable, isCliEngine, STATUS_LABEL, STATUS_TONE, STEPS_MAX, STEPS_MIN, type EngineId
} from '@shared/engines'
import { useEngineStore } from '../../stores/engineStore'
import SettingsSection from './SettingsSection.vue'

const engine = useEngineStore()

const selected = computed(() => engine.settings.engine)
const steps = ref(engine.settings.maxSteps)
watch(() => engine.settings.maxSteps, (v) => { steps.value = v })
const fill = computed(() => ((steps.value - STEPS_MIN) / (STEPS_MAX - STEPS_MIN)) * 100)

const TONE_CLASS: Record<string, string> = {
	green: 'text-accent',
	zinc: 'text-zinc-500 dark:text-zinc-400',
	amber: 'text-amber-600 dark:text-amber-400',
	red: 'text-red-500'
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
/* A 2px track, violet fill to the thumb, a 12px violet thumb. */
.steps-range {
	-webkit-appearance: none;
	appearance: none;
	height: 3px;
	border-radius: 2px;
	background: linear-gradient(to right, #8b5cf6 var(--fill), rgba(128, 128, 128, 0.3) var(--fill));
	outline: none;
}
.steps-range::-webkit-slider-thumb {
	-webkit-appearance: none;
	width: 12px;
	height: 12px;
	border-radius: 50%;
	background: #8b5cf6;
	cursor: pointer;
}
.steps-range:disabled::-webkit-slider-thumb { cursor: not-allowed; }
</style>
