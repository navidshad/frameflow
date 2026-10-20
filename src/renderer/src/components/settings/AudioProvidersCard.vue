<template>
	<SettingsSection title="Audio providers"
		description="Voices, sound effects and music made from a prompt. Each one costs money, so nothing is generated until you ask, or allow an agent to.">
		<!-- One row per provider -->
		<div v-for="p in audio.providers" :key="p.id" class="py-3 hair-t first:border-t-0 first:pt-0">
			<div class="flex items-center gap-2">
				<span class="text-[13px] font-bold">{{ p.label }}</span>
				<span class="text-[9px] font-bold uppercase tracking-wide" :class="p.connected ? 'text-accent' : 'text-zinc-500'">
					{{ p.connected ? 'Connected' : 'Not connected' }}
				</span>
			</div>
			<p class="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{{ p.note }}</p>

			<!-- ElevenLabs: its own key -->
			<div v-if="p.id === 'elevenlabs'" class="mt-2.5 flex items-end gap-3">
				<div class="flex-1 max-w-[360px]">
					<label for="el-key" class="lbl block">API key</label>
					<input id="el-key" v-model="elevenLabsKey" type="password" class="field font-mono" autocomplete="off" spellcheck="false"
						:placeholder="p.keySaved ? 'A key is saved. Paste a new one to replace it.' : 'Paste your ElevenLabs key'"
						@keydown.enter="saveKey" />
				</div>
				<button class="btn-text btn-text-primary" :disabled="!elevenLabsKey.trim() || savingKey" @click="saveKey">Save</button>
				<button v-if="p.keySaved" class="btn-text" :disabled="savingKey" @click="removeKey">Remove</button>
			</div>

			<!-- Gemini voices: the Gemini key the app already has -->
			<div v-else class="mt-2.5">
				<button role="checkbox" :aria-checked="audio.settings.geminiVoices" class="flex gap-2.5 text-left disabled:opacity-50"
					:disabled="!p.keySaved" @click="audio.update({ geminiVoices: !audio.settings.geminiVoices })">
					<span v-if="audio.settings.geminiVoices" class="w-4 h-4 mt-px rounded bg-primary text-white flex items-center justify-center shrink-0">
						<span class="iconify tabler--check w-3 h-3"></span>
					</span>
					<span v-else class="w-4 h-4 mt-px rounded border border-zinc-400 dark:border-zinc-600 shrink-0"></span>
					<span>
						<span class="block font-semibold text-xs">Offer Gemini voices for voice-over</span>
						<span class="block text-[11px] text-zinc-500 dark:text-zinc-400">
							{{ p.keySaved ? 'Billed to your Gemini key, per token.' : 'Save a Gemini API key below first.' }}
						</span>
					</span>
				</button>
			</div>
		</div>

		<!-- What an agent may spend -->
		<div class="mt-5 pt-4 hair-t">
			<span class="lbl block">What an agent may spend in one turn</span>
			<p class="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
				Applies only when “Generate voices, sounds and music” is allowed under Agent access. When you press Generate yourself, you see the cost first and choose.
			</p>
			<div class="flex gap-10 mt-2.5 max-sm:flex-col max-sm:gap-3">
				<div>
					<label for="sp-count" class="lbl block">Generations</label>
					<input id="sp-count" class="field w-24" type="number" min="0" max="50" step="1" :value="audio.settings.spend.maxGenerationsPerTurn"
						@change="audio.update({ spend: { maxGenerationsPerTurn: Number(($event.target as HTMLInputElement).value) } })" />
				</div>
				<div>
					<label for="sp-usd" class="lbl block">Dollars</label>
					<div class="flex items-center gap-2">
						<input id="sp-usd" class="field w-24" type="number" min="0" step="0.25" :disabled="audio.settings.spend.maxUsdPerTurn === null"
							:value="audio.settings.spend.maxUsdPerTurn ?? ''"
							@change="audio.update({ spend: { maxUsdPerTurn: Number(($event.target as HTMLInputElement).value) } })" />
						<button role="checkbox" :aria-checked="audio.settings.spend.maxUsdPerTurn === null" class="text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
							@click="audio.update({ spend: { maxUsdPerTurn: audio.settings.spend.maxUsdPerTurn === null ? DEFAULT_SPEND_POLICY.maxUsdPerTurn : null } })">
							{{ audio.settings.spend.maxUsdPerTurn === null ? 'Set a limit' : 'No dollar limit' }}
						</button>
					</div>
				</div>
			</div>
			<p class="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
				Prices are estimates from the providers’ list prices. ElevenLabs bills in credits, so only the count guards those.
			</p>
		</div>
	</SettingsSection>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { DEFAULT_SPEND_POLICY } from '@shared/audioProviders'
import SettingsSection from './SettingsSection.vue'
import { useAudioStore } from '../../stores/audioStore'

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
