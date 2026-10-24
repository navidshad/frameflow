<template>
	<SectionHeader title="Connections"
		description="Your keys and the AI tools found on this computer. Each job’s model is picked under Video editing and Image editing." />

	<SettingsGroup title="Keys and tools">
		<template #action>
			<button class="btn-text btn-text-primary !h-auto !px-0" :disabled="engine.detecting" @click="engine.detect()">
				{{ engine.detecting ? 'Detecting…' : 'Detect again' }}
			</button>
		</template>

		<SettingsRow title="Gemini API key"
			description="Transcripts, scene descriptions, images, Gemini voices and the Gemini engine." top>
			<div class="field gap-2.5">
				<template v-if="saved && !replacing">
					<span class="flex-1 font-mono tracking-wider">{{ masked }}</span>
					<span :class="TAG + ' text-accent bg-accent/10'">Saved</span>
				</template>
				<template v-else>
					<label for="gemini-key" class="sr-only">Gemini API key</label>
					<input id="gemini-key" v-model="draft" type="password" placeholder="Enter API key…" autocomplete="off"
						spellcheck="false" class="flex-1 bg-transparent outline-none font-mono text-xs" @keydown.enter="save" />
				</template>
			</div>
			<div class="mt-1.5 flex gap-4">
				<button v-if="saved && !replacing" class="btn-text btn-text-primary !px-0" @click="replacing = true">Replace key</button>
				<template v-else>
					<button class="btn-text btn-text-primary !px-0" :disabled="!draft.trim()" @click="save">Save key</button>
					<button v-if="saved" class="btn-text !px-0" @click="cancel">Cancel</button>
				</template>
			</div>
		</SettingsRow>

		<SettingsRow title="Claude Code">
			<template #aside>
				<div class="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 mt-[3px]">{{ where }}</div>
				<div v-if="note" class="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{{ note }}</div>
			</template>
			<div class="flex items-center gap-2.5">
				<span :class="[TAG, badge.cls]">{{ badge.text }}</span>
				<span v-if="signedIn" class="text-xs text-zinc-500 dark:text-zinc-400">Uses your Claude plan</span>
			</div>
		</SettingsRow>
	</SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { STATUS_LABEL, STATUS_TONE } from '@shared/engines'
import { useEngineStore } from '../../stores/engineStore'
import SectionHeader from './SectionHeader.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingsRow from './SettingsRow.vue'

const TAG = 'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap '
const TONE: Record<string, string> = {
	green: 'text-accent bg-accent/10',
	zinc: 'text-zinc-500 dark:text-zinc-400 bg-zinc-500/10',
	amber: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
	red: 'text-red-500 bg-red-500/10'
}

const api = (window as any).api
const engine = useEngineStore()

// Gemini key. The saved value is shown masked; "Replace key" opens an empty field.
const saved = ref('')
const draft = ref('')
const replacing = ref(false)
const masked = computed(() => `${'•'.repeat(12)}${saved.value.slice(-4)}`)
const save = async () => {
	const key = draft.value.trim()
	if (!key) return
	await api.setGeminiApiKey(key)
	saved.value = key
	draft.value = ''
	replacing.value = false
}
const cancel = () => {
	draft.value = ''
	replacing.value = false
}

// Claude Code
const detection = computed(() => engine.detectionFor('claude-code'))
const signedIn = computed(() => detection.value?.status === 'signed-in')
const badge = computed(() => {
	const d = detection.value
	if (!d) return { text: engine.detecting ? '…' : 'Unknown', cls: TONE.zinc }
	return { text: STATUS_LABEL[d.status], cls: TONE[STATUS_TONE[d.status]] }
})
const where = computed(() => {
	const d = detection.value
	if (!d) return 'Looking…'
	if (d.status === 'missing') return 'Not on this computer'
	return [d.version ? `v${d.version}` : null, d.displayPath].filter(Boolean).join(' · ')
})
const note = computed(() => {
	const d = detection.value
	return d && (d.status === 'missing' || d.status === 'signed-out' || d.status === 'unusable') ? d.note : ''
})

onMounted(async () => {
	saved.value = (await api.getGeminiApiKey()) || ''
	if (!engine.loaded) await engine.load()
})
</script>
