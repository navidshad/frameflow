<template>
	<div class="space-y-3">
		<!-- Model: the first option is the default, or "Auto" when someone else may choose -->
		<div v-if="models.length">
			<label :for="`${uid}-model`" class="lbl block">Model</label>
			<select :id="`${uid}-model`" class="field" :value="req.model ?? ''" @change="set({ model: ($event.target as HTMLSelectElement).value || undefined })">
				<option value="">{{ firstModelLabel }}</option>
				<option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}{{ m.deprecated ? ' (retiring)' : '' }}</option>
			</select>
			<p v-if="shownModel?.description" class="mt-0.5 text-[10px] text-zinc-500 leading-snug line-clamp-2" :title="shownModel.description">{{ shownModel.description }}</p>
		</div>

		<!-- Voice: the person's own voices first -->
		<div v-if="req.capability === 'speech'">
			<label :for="`${uid}-voice`" class="lbl block">Voice</label>
			<div class="flex gap-1.5">
				<select :id="`${uid}-voice`" class="field flex-1 min-w-0" :value="req.voice ?? ''" :disabled="!voices.length"
					@change="set({ voice: ($event.target as HTMLSelectElement).value || undefined })">
					<option value="">{{ voices.length ? firstVoiceLabel : 'Loading voices…' }}</option>
					<optgroup v-if="own.length" label="Your voices">
						<option v-for="v in own" :key="v.id" :value="v.id">{{ voiceLine(v) }}</option>
					</optgroup>
					<optgroup v-if="stock.length" :label="`${providerLabel} voices`">
						<option v-for="v in stock" :key="v.id" :value="v.id">{{ voiceLine(v) }}</option>
					</optgroup>
				</select>
				<button v-if="preview" class="w-7 h-7 rounded flex items-center justify-center shrink-0 text-zinc-400 hover:text-accent-light hover:bg-accent/10 transition"
					:aria-label="playing ? 'Stop the sample' : 'Hear a sample of this voice'" :title="playing ? 'Stop' : 'Hear a sample (free)'" @click="toggleSample">
					<span class="iconify w-3.5 h-3.5" :class="playing ? 'tabler--player-stop' : 'tabler--player-play'"></span>
				</button>
			</div>
			<p v-if="chosenVoice && isOwnVoice(chosenVoice)" class="mt-0.5 text-[10px] text-zinc-500 leading-snug">
				Your own voice: it will say these words as if you did.
			</p>
		</div>

		<div>
			<label :for="`${uid}-prompt`" class="lbl block">{{ req.capability === 'speech' ? 'Line to read' : 'Describe it' }}</label>
			<textarea :id="`${uid}-prompt`" :value="req.prompt" :rows="rows" class="field resize-none leading-snug"
				:placeholder="PLACEHOLDER[req.capability]" :maxlength="maxChars"
				@input="set({ prompt: ($event.target as HTMLTextAreaElement).value })"></textarea>
			<div class="mt-0.5 flex justify-between gap-2 text-[10px] text-zinc-500">
				<span :class="{ 'text-amber-500': problem && req.prompt.trim() }">{{ req.prompt.trim() ? problem : '' }}</span>
				<span class="tabular-nums shrink-0">{{ req.prompt.length }} / {{ maxChars }}</span>
			</div>
		</div>

		<div v-if="req.capability !== 'speech'" class="flex flex-wrap items-end gap-x-5 gap-y-2">
			<div>
				<label :for="`${uid}-dur`" class="lbl block">Length in seconds</label>
				<input :id="`${uid}-dur`" type="number" class="field w-28" :min="range.min" :max="range.max" step="0.5"
					:value="req.durationSec ?? ''" :placeholder="`${range.min}–${range.max}, or auto`"
					@change="setDuration(($event.target as HTMLInputElement).value)" />
			</div>
			<label v-if="req.capability === 'sfx'" class="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300 pb-1.5">
				<input type="checkbox" :checked="!!req.loop" @change="set({ loop: ($event.target as HTMLInputElement).checked || undefined })" />
				Loops seamlessly
			</label>
			<label v-if="req.capability === 'music'" class="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300 pb-1.5">
				<input type="checkbox" :checked="req.instrumental === false" @change="set({ instrumental: ($event.target as HTMLInputElement).checked ? false : undefined })" />
				With singing
			</label>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import {
	isOwnVoice, LIMITS, providerInfo, requestProblem, speechMaxChars, type AudioCapability, type GenerateRequest, type Voice
} from '@shared/audioProviders'
import { chooseModel, findModel, modelsFor } from '@shared/audioModels'
import { useAudioStore } from '../../stores/audioStore'

/**
 * The fields of one generation request: model, voice, text, length, loop,
 * singing. The Sound tab's Generate and Voice pages and the assistant's
 * proposal card both draw them, so a choice looks and behaves the same in both.
 *
 * An empty model or voice means "not chosen": the provider's default in the
 * Sound tab, or "let the assistant pick" on a proposal (`autoModel` and
 * `autoVoice` name what it would pick).
 */
const props = withDefaults(defineProps<{
	modelValue: GenerateRequest
	/** What an empty model resolves to, when someone other than the default picks it. */
	autoModel?: string
	autoVoice?: string
	rows?: number
}>(), { rows: 4 })
const emit = defineEmits<{ 'update:modelValue': [GenerateRequest] }>()

const uid = useId()
const audio = useAudioStore()
const req = computed(() => props.modelValue)
const set = (patch: Partial<GenerateRequest>) => {
	const next = { ...req.value, ...patch }
	for (const k of Object.keys(patch) as (keyof GenerateRequest)[]) if (patch[k] === undefined) delete next[k]
	emit('update:modelValue', next)
}

const PLACEHOLDER: Record<AudioCapability, string> = {
	speech: 'Welcome back. Today we are looking at how the team cut triage time.',
	sfx: 'A heavy wooden door closing in a stone hall',
	music: 'Calm piano with a slow build, no drums'
}

const providerLabel = computed(() => providerInfo(req.value.provider)?.label ?? 'Provider')
/** The provider's models as it lists them today. */
const catalog = computed(() => audio.catalogs[req.value.provider] ?? null)
watch(() => req.value.provider, (id) => { void audio.loadCatalog(id) }, { immediate: true })
// Every model the provider lists, retiring ones too (marked): nothing is hidden.
const models = computed(() => modelsFor(catalog.value, req.value.capability))
const autoModel = computed(() => findModel(catalog.value, req.value.capability, props.autoModel))
/** What FrameFlow picks when nobody does. */
const chosen = computed(() => chooseModel(catalog.value, {
	capability: req.value.capability, prompt: req.value.prompt, ownVoice: !!chosenVoice.value && isOwnVoice(chosenVoice.value)
}))
const firstModelLabel = computed(() => {
	if (props.autoModel !== undefined) {
		const pick = autoModel.value ?? chosen.value
		return pick ? `Auto (I'd pick ${pick.label})` : 'Auto'
	}
	return chosen.value ? `Default (${chosen.value.label})` : 'Default'
})
/** The model the request will run on, for its one-line note. */
const shownModel = computed(() => findModel(catalog.value, req.value.capability, req.value.model) ?? autoModel.value ?? chosen.value)

const voices = ref<Voice[]>([])
watch(() => [req.value.provider, req.value.capability] as const, async ([provider, capability]) => {
	voices.value = []
	if (capability === 'speech') voices.value = await audio.loadVoices(provider)
}, { immediate: true })
const own = computed(() => voices.value.filter(isOwnVoice))
const stock = computed(() => voices.value.filter((v) => !isOwnVoice(v)))
const voiceLine = (v: Voice) => `${v.name}${v.description ? ` · ${v.description}` : ''}`
const autoVoice = computed(() => voices.value.find((v) => v.id === props.autoVoice || v.name === props.autoVoice))
const firstVoiceLabel = computed(() =>
	props.autoVoice !== undefined ? (autoVoice.value ? `Auto (I'd pick ${autoVoice.value.name})` : 'Auto') : 'Default voice')
const chosenVoice = computed(() => voices.value.find((v) => v.id === req.value.voice) ?? autoVoice.value)

// ===== A voice's sample: the provider's own preview file, free to play =====

const preview = computed(() => chosenVoice.value?.previewUrl)
const playing = ref(false)
let player: HTMLAudioElement | null = null
const stopSample = () => { player?.pause(); player = null; playing.value = false }
const toggleSample = () => {
	if (playing.value) return stopSample()
	if (!preview.value) return
	player = new Audio(preview.value)
	player.onended = stopSample
	playing.value = true
	player.play().catch(stopSample)
}
watch(preview, stopSample)
onBeforeUnmount(stopSample)

// ===== Limits =====

const range = computed(() => (req.value.capability === 'music' ? LIMITS.musicSec : LIMITS.sfxSec))
const maxChars = computed(() => (req.value.capability === 'speech' ? speechMaxChars(req.value, catalog.value) : LIMITS.promptChars.max))
const problem = computed(() => requestProblem(req.value, catalog.value))
const setDuration = (text: string) => {
	const n = Number(text)
	set({ durationSec: text.trim() && Number.isFinite(n) ? n : undefined })
}

</script>
