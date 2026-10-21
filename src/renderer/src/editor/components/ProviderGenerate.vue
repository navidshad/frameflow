<template>
	<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-3 space-y-4">
		<!-- No provider yet: say what this will be and where to get it -->
		<div v-if="!available.length" class="flex gap-2.5 text-zinc-500">
			<span class="iconify tabler--lock w-4 h-4 mt-0.5 shrink-0"></span>
			<div class="text-[11px] leading-snug">
				<p class="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
					{{ mode === 'generate' ? 'Sound effects and music from a prompt' : 'Voice-over from text' }}
				</p>
				<p class="mt-1">
					{{ mode === 'generate'
						? 'Describe a sound and a provider makes it once; after that it is a file in your project. Needs a provider key.'
						: 'Type a line and a voice reads it. Needs a provider key.' }}
				</p>
				<button class="mt-2 font-semibold text-primary hover:underline" @click="router.push('/settings')">Add one in Settings</button>
			</div>
		</div>

		<template v-else>
			<!-- Effect or music -->
			<div v-if="mode === 'generate'" class="flex gap-3.5" role="radiogroup" aria-label="What to make">
				<button v-for="c in GENERATE_KINDS" :key="c" role="radio" :aria-checked="capability === c" class="tab-u !h-6 !text-[11px]"
					:class="{ 'tab-u-active': capability === c }" @click="capability = c">{{ CAPABILITY_LABEL[c] }}</button>
			</div>

			<div v-if="available.length > 1">
				<label for="pg-provider" class="lbl block">Provider</label>
				<select id="pg-provider" v-model="provider" class="field">
					<option v-for="p in available" :key="p.id" :value="p.id">{{ p.label }}</option>
				</select>
			</div>

			<div v-if="capability === 'speech'">
				<label for="pg-voice" class="lbl block">Voice</label>
				<select id="pg-voice" v-model="voice" class="field" :disabled="!voiceList.length">
					<option value="">{{ voiceList.length ? 'Default voice' : 'Loading voices…' }}</option>
					<option v-for="v in voiceList" :key="v.id" :value="v.id">{{ v.name }}{{ v.description ? ` · ${v.description}` : '' }}</option>
				</select>
			</div>

			<div>
				<label for="pg-prompt" class="lbl block">{{ capability === 'speech' ? 'Line to read' : 'Describe it' }}</label>
				<textarea id="pg-prompt" v-model="prompt" rows="4" class="field resize-none leading-snug"
					:placeholder="PLACEHOLDER[capability]" :maxlength="capability === 'speech' ? LIMITS.speechChars.max : LIMITS.promptChars.max"></textarea>
				<div class="mt-0.5 flex justify-between text-[10px] text-zinc-500">
					<span :class="{ 'text-amber-500': problem && prompt.trim() }">{{ prompt.trim() ? problem : '' }}</span>
					<span class="tabular-nums">{{ prompt.length }} / {{ capability === 'speech' ? LIMITS.speechChars.max : LIMITS.promptChars.max }}</span>
				</div>
			</div>

			<div v-if="capability !== 'speech'">
				<label for="pg-dur" class="lbl block">Length in seconds</label>
				<input id="pg-dur" v-model="durationText" type="number" class="field w-28" :min="range.min" :max="range.max" step="0.5"
					:placeholder="`${range.min}–${range.max}, or let it choose`" />
			</div>

			<!-- The price comes before the press -->
			<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
				<button class="btn-text btn-text-primary shrink-0 whitespace-nowrap" :disabled="!!problem || busy" @click="make">
					<span class="iconify w-3.5 h-3.5" :class="busy ? 'tabler--loader-2 animate-spin' : 'tabler--sparkles'"></span>
					{{ busy ? 'Making…' : 'Generate' }}
				</button>
				<span class="text-[11px] text-zinc-500">{{ costLine }}</span>
			</div>
			<p v-if="error" class="text-[11px] text-red-500 leading-snug">{{ error }}</p>
		</template>

		<!-- What has been made in this project. Each is a file now: it plays and exports with no provider. -->
		<div v-if="made.length" class="pt-2 hair-t">
			<span class="lbl block mt-2 mb-1">Made in this project</span>
			<div v-for="a in made" :key="a.id" class="group flex items-center gap-2 min-h-[36px] py-1 hair-t first:border-t-0">
				<button class="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-zinc-400 hover:text-accent-light transition"
					:aria-label="`Hear ${a.name}`" @click="store.auditionAsset(a)">
					<span class="iconify tabler--player-play-filled w-3 h-3"></span>
				</button>
				<span class="flex-1 min-w-0">
					<span class="block text-xs font-semibold truncate" :title="a.generated!.prompt">{{ a.name }}</span>
					<span class="block text-[10px] text-zinc-500 truncate">
						{{ providerLabel(a.generated!.provider) }} · {{ formatCost(a.generated!) }} · {{ (a.metadata?.duration || 0).toFixed(1) }} s
					</span>
				</span>
				<button class="w-6 h-6 rounded flex items-center justify-center shrink-0 text-zinc-400 hover:text-accent-light hover:bg-accent/10 transition"
					:aria-label="`Add ${a.name} at the playhead`" title="Add at the playhead" @click="store.placeGeneratedAudio(a)">
					<span class="iconify tabler--plus w-3.5 h-3.5"></span>
				</button>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
	CAPABILITY_LABEL, formatCost, LIMITS, providerInfo, requestProblem,
	type AudioCapability, type GenerateRequest, type ProviderId
} from '@shared/audioProviders'
import { useAudioStore, type VoiceOption } from '../../stores/audioStore'
import { useEditorStore } from '../../stores/editorStore'

/**
 * The Sound tab's Generate (effects, music) and Voice (voice-over) pages.
 *
 * The price is shown before the button is pressed, and a made sound is kept in
 * a list below as an ordinary file: hear it, add it, and it exports with no
 * provider or connection. Generating is never automatic here: the person pressed it.
 */
const props = defineProps<{ mode: 'generate' | 'voice' }>()

const api = (window as any).api
const router = useRouter()
const store = useEditorStore()
const audio = useAudioStore()

const GENERATE_KINDS: AudioCapability[] = ['sfx', 'music']
const PLACEHOLDER: Record<AudioCapability, string> = {
	speech: 'Welcome back. Today we are looking at how the team cut triage time.',
	sfx: 'A heavy wooden door closing in a stone hall',
	music: 'Calm piano with a slow build, no drums'
}

const capability = ref<AudioCapability>(props.mode === 'voice' ? 'speech' : 'sfx')
watch(() => props.mode, (mode) => { capability.value = mode === 'voice' ? 'speech' : 'sfx' })

const available = computed(() => audio.forCapability(capability.value))
const provider = ref<ProviderId | ''>('')
watch(available, (list) => { if (!list.some((p) => p.id === provider.value)) provider.value = list[0]?.id ?? '' }, { immediate: true })

const voice = ref('')
const voiceList = ref<VoiceOption[]>([])
watch([capability, provider], async () => {
	voice.value = ''
	voiceList.value = []
	if (capability.value === 'speech' && provider.value) voiceList.value = await audio.loadVoices(provider.value)
}, { immediate: true })

const prompt = ref('')
const durationText = ref('')
const busy = ref(false)
const error = ref('')

const range = computed(() => (capability.value === 'music' ? LIMITS.musicSec : LIMITS.sfxSec))
const request = computed<GenerateRequest | null>(() => {
	if (!provider.value) return null
	const seconds = Number(durationText.value)
	return {
		provider: provider.value, capability: capability.value, prompt: prompt.value,
		...(capability.value === 'speech' && voice.value ? { voice: voice.value } : {}),
		...(capability.value !== 'speech' && durationText.value.trim() && Number.isFinite(seconds) ? { durationSec: seconds } : {})
	}
})
const problem = computed(() => {
	if (!request.value) return 'Connect a provider first.'
	// An empty box is not a mistake yet: the button is simply off.
	return requestProblem(request.value) ?? null
})

// ===== The price, before the press =====

const estimate = ref<number | null | undefined>(undefined)
let timer: ReturnType<typeof setTimeout> | undefined
watch(request, (req) => {
	clearTimeout(timer)
	estimate.value = undefined
	if (!req || requestProblem(req)) return
	timer = setTimeout(async () => { estimate.value = await api.estimateAudio(req) }, 250)
}, { deep: true })
onBeforeUnmount(() => clearTimeout(timer))

const costLine = computed(() => {
	if (!request.value || problem.value) return `${CAPABILITY_LABEL[capability.value]} · costs money`
	if (estimate.value === undefined) return ''
	if (estimate.value === null) return `Billed in ${providerInfo(provider.value as ProviderId)?.label ?? 'the provider'} credits`
	return `About $${estimate.value < 0.005 ? '0.01' : estimate.value.toFixed(2)}`
})

const make = async () => {
	if (!request.value || problem.value || !store.threadId) return
	busy.value = true
	error.value = ''
	try {
		const result = await audio.generate(store.threadId, request.value)
		if ('error' in result) { error.value = result.error; return }
		store.upsertAsset(result.asset)
		store.auditionAsset(result.asset)
	} finally {
		busy.value = false
	}
}

const made = computed(() => store.generatedAssets)
const providerLabel = (id: ProviderId) => providerInfo(id)?.label ?? id
</script>
