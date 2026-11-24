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
				<!-- What the account has left, and the models ElevenLabs lists today -->
				<div v-if="p.connected" class="mt-3 space-y-1 text-[11px] text-zinc-500 dark:text-zinc-400" data-testid="elevenlabs-account">
					<p v-if="account">
						<span class="font-semibold text-zinc-700 dark:text-zinc-200 tabular-nums">{{ creditsLeft(account).toLocaleString() }}</span>
						of {{ account.creditsLimit.toLocaleString() }} credits left<span v-if="account.tier"> · {{ account.tier.charAt(0).toUpperCase() + account.tier.slice(1) }} plan</span><span
							v-if="account.resetsAt"> · refills {{ new Date(account.resetsAt).toLocaleDateString() }}</span>
					</p>
					<p v-else-if="account === null">The balance could not be read.</p>
					<p>
						{{ modelsLine }}
						<button class="ml-1 font-semibold text-primary hover:underline disabled:opacity-50" :disabled="refreshing" @click="refreshModels">
							{{ refreshing ? 'Checking…' : 'Check for new models' }}
						</button>
					</p>
					<p v-for="gap in catalog?.gaps ?? []" :key="gap" class="text-amber-600 dark:text-amber-400 leading-snug">{{ gap }}</p>
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

	<!-- What agents found out about the models, kept for every project. Auto uses the picks. -->
	<SettingsGroup title="What agents learned about models">
		<p v-if="!audio.notes.picks.length && !audio.notes.notes.length" class="py-2 text-[11px] text-zinc-500 dark:text-zinc-400">
			Nothing yet. When an agent researches the models (their docs, the web, what things cost here), it writes down
			what it found and which model it picks for each kind. Every project starts from those notes, and Auto uses the picks.
		</p>
		<div v-for="p in audio.notes.picks" :key="`pick-${p.provider}-${p.capability}`" class="group flex gap-3 py-2 hair-b" data-testid="model-pick">
			<span :class="[TAG, 'text-accent bg-accent/10 self-start mt-px']">{{ KIND[p.capability] }} pick</span>
			<span class="flex-1 min-w-0">
				<span class="block text-xs font-semibold">{{ modelName(p.provider, p.capability, p.model) }}</span>
				<span class="block text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">{{ p.why }}</span>
				<span class="block text-[10px] text-zinc-400 mt-0.5">{{ p.by }} · {{ new Date(p.at).toLocaleDateString() }}</span>
			</span>
			<button class="btn-text !px-0 self-start opacity-0 group-hover:opacity-100 focus:opacity-100" @click="audio.removePick(p)">Forget</button>
		</div>
		<div v-for="n in sortedNotes" :key="`note-${n.provider}-${n.capability}-${n.model}-${n.source}`" class="group flex gap-3 py-2 hair-b" data-testid="model-note">
			<span :class="[TAG, 'text-zinc-500 dark:text-zinc-400 bg-zinc-500/10 self-start mt-px']">{{ SOURCE[n.source] }}</span>
			<span class="flex-1 min-w-0">
				<span class="block text-xs font-semibold">{{ modelName(n.provider, n.capability, n.model) }} <span class="font-normal text-zinc-500">· {{ KIND[n.capability] }}</span></span>
				<span class="block text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">{{ n.text }}</span>
				<span class="block text-[10px] text-zinc-400 mt-0.5">{{ n.by }} · {{ new Date(n.at).toLocaleDateString() }}</span>
			</span>
			<button class="btn-text !px-0 self-start opacity-0 group-hover:opacity-100 focus:opacity-100" @click="audio.removeNote(n)">Delete</button>
		</div>
	</SettingsGroup>

	<SettingsGroup title="What an agent may spend in one turn">
		<SettingsRow title="Limits"
			description="Applies when agents are set to Auto under Agent access. Past these, an agent asks you instead. When you press Make it or Generate yourself, you see the cost first and choose.">
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
			Dollar prices are estimates from the providers’ list prices. ElevenLabs bills in credits: what each one used is shown where it was made.
		</p>
	</SettingsGroup>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { creditsLeft, DEFAULT_SPEND_POLICY } from '@shared/audioProviders'
import { findModel, usableModels } from '@shared/audioModels'
import type { NoteSource } from '@shared/audioNotes'
import type { AudioCapability, ProviderId } from '@shared/audioProviders'
import SectionHeader from './SectionHeader.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingsRow from './SettingsRow.vue'
import { useAudioStore } from '../../stores/audioStore'

const TAG = 'text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded whitespace-nowrap'
const audio = useAudioStore()
const elevenLabsKey = ref('')
const savingKey = ref(false)

onMounted(() => { void audio.load(); void audio.loadNotes() })

const KIND: Record<AudioCapability, string> = { speech: 'Voice-over', sfx: 'Sound effect', music: 'Music' }
const SOURCE: Record<NoteSource, string> = { docs: 'From docs', tried: 'Tried', person: 'From you' }
const sortedNotes = computed(() => [...audio.notes.notes].sort((a, b) => b.at - a.at))
/** The provider's own name for a model, while it lists it; the id otherwise. */
const modelName = (provider: ProviderId, capability: AudioCapability, model: string) =>
	findModel(audio.catalogs[provider] ?? null, capability, model)?.label ?? model

// ===== ElevenLabs: balance and today's models =====

const connected = computed(() => !!audio.statusOf('elevenlabs')?.connected)
watch(connected, (on) => {
	if (!on) return
	void audio.loadAccount('elevenlabs', true)
	void audio.loadCatalog('elevenlabs')
}, { immediate: true })
const account = computed(() => audio.accounts.elevenlabs)
const catalog = computed(() => audio.catalogs.elevenlabs ?? null)
const modelsLine = computed(() => {
	const c = catalog.value
	if (!c || !c.models.length) return 'No model list yet.'
	const counts = (['speech', 'sfx', 'music'] as const).map((k) => usableModels(c, k).length)
	const when = c.fetchedAt ? new Date(c.fetchedAt).toLocaleString() : 'never'
	return `${counts[0]} voice, ${counts[1]} sound effect and ${counts[2]} music models, as ElevenLabs listed them ${when}.`
})
const refreshing = ref(false)
const refreshModels = async () => {
	refreshing.value = true
	try { await audio.loadCatalog('elevenlabs', true) } finally { refreshing.value = false }
}

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
