<template>
	<SectionHeader title="Audio"
		description="Voices, sound effects and music made from a prompt. Each one costs money, so nothing is generated until you ask, or allow an agent to." />

	<SettingsGroup title="Providers">
		<template v-for="p in audio.providers" :key="p.id">
			<!-- ElevenLabs: its own key -->
			<SettingsRow v-if="p.id === 'elevenlabs'" :title="p.label" :description="p.note" top>
				<template #badge>
					<span :class="[TAG, p.connected ? 'text-accent bg-accent/10' : 'text-zinc-500 dark:text-zinc-400 bg-zinc-500/10']">
						{{ p.connected ? 'Connected' : 'Not connected' }}
					</span>
				</template>
				<label for="el-key" class="lbl block">API key</label>
				<input id="el-key" v-model="elevenLabsKey" type="password" class="field font-mono" autocomplete="off" spellcheck="false"
					:placeholder="p.keySaved ? 'A key is saved. Paste a new one to replace it.' : 'Paste your ElevenLabs key'"
					@keydown.enter="saveKey" />
				<div class="mt-1.5 flex gap-4">
					<button class="btn-text btn-text-primary !px-0" :disabled="!elevenLabsKey.trim() || savingKey" @click="saveKey">Save</button>
					<button v-if="p.keySaved" class="btn-text !px-0" :disabled="savingKey" @click="removeKey">Remove</button>
				</div>
			</SettingsRow>

			<!-- Gemini voices: the Gemini key the app already has -->
			<SettingsRow v-else :title="p.label" :description="p.note">
				<template #badge>
					<span :class="[TAG, p.connected ? 'text-accent bg-accent/10' : 'text-zinc-500 dark:text-zinc-400 bg-zinc-500/10']">
						{{ p.connected ? 'Connected' : 'Not connected' }}
					</span>
				</template>
				<button role="checkbox" :aria-checked="audio.settings.geminiVoices" class="flex gap-2.5 text-left disabled:opacity-50"
					:disabled="!p.keySaved" @click="audio.update({ geminiVoices: !audio.settings.geminiVoices })">
					<span v-if="audio.settings.geminiVoices" class="w-4 h-4 mt-px rounded bg-primary text-white flex items-center justify-center shrink-0">
						<span class="iconify tabler--check w-3 h-3"></span>
					</span>
					<span v-else class="w-4 h-4 mt-px rounded border-[1.5px] border-zinc-400 dark:border-zinc-600 shrink-0"></span>
					<span>
						<span class="block font-semibold text-xs">Offer Gemini voices for voice-over</span>
						<span class="block text-[11px] text-zinc-500 dark:text-zinc-400">
							{{ p.keySaved ? 'Billed to your Gemini key, per token.' : 'Save a Gemini API key under Connections first.' }}
						</span>
					</span>
				</button>
			</SettingsRow>
		</template>
	</SettingsGroup>

	<SettingsGroup title="What an agent may spend in one turn">
		<SettingsRow title="Limits"
			description="Applies only when “Generate audio with a provider” is allowed under Agent access. When you press Generate yourself, you see the cost first and choose.">
			<div class="flex gap-10">
				<div>
					<label for="sp-count" class="lbl block">Generations</label>
					<input id="sp-count" class="field w-24" type="number" min="0" max="50" step="1" :value="audio.settings.spend.maxGenerationsPerTurn"
						@change="audio.update({ spend: { maxGenerationsPerTurn: Number(($event.target as HTMLInputElement).value) } })" />
				</div>
				<div>
					<label for="sp-usd" class="lbl block">Dollars</label>
					<input id="sp-usd" class="field w-24" type="number" min="0" step="0.25" :disabled="audio.settings.spend.maxUsdPerTurn === null"
						:value="audio.settings.spend.maxUsdPerTurn ?? ''"
						@change="audio.update({ spend: { maxUsdPerTurn: Number(($event.target as HTMLInputElement).value) } })" />
					<button role="checkbox" :aria-checked="audio.settings.spend.maxUsdPerTurn === null"
						class="mt-1.5 text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
						@click="audio.update({ spend: { maxUsdPerTurn: audio.settings.spend.maxUsdPerTurn === null ? DEFAULT_SPEND_POLICY.maxUsdPerTurn : null } })">
						{{ audio.settings.spend.maxUsdPerTurn === null ? 'Set a limit' : 'No dollar limit' }}
					</button>
				</div>
			</div>
		</SettingsRow>
		<p class="mt-3 text-[11px] text-zinc-500 dark:text-zinc-400">
			Prices are estimates from the providers’ list prices. ElevenLabs bills in credits, so only the count guards those.
		</p>
	</SettingsGroup>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { DEFAULT_SPEND_POLICY } from '@shared/audioProviders'
import SectionHeader from './SectionHeader.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingsRow from './SettingsRow.vue'
import { useAudioStore } from '../../stores/audioStore'

const TAG = 'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap'
const audio = useAudioStore()
const elevenLabsKey = ref('')
const savingKey = ref(false)

onMounted(() => audio.load())

async function saveKey() {
	const key = elevenLabsKey.value.trim()
	if (!key || savingKey.value) return
	savingKey.value = true
	try {
		await audio.saveElevenLabsKey(key)
		elevenLabsKey.value = ''
	} finally {
		savingKey.value = false
	}
}

async function removeKey() {
	savingKey.value = true
	try { await audio.saveElevenLabsKey('') } finally { savingKey.value = false }
}
</script>
