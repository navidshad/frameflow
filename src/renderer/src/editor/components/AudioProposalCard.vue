<template>
	<div class="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3.5 py-3 space-y-3"
		:data-testid="`audio-proposal-${proposal.id}`">
		<!-- Who asked, and why -->
		<div class="flex items-start gap-2">
			<span class="iconify tabler--wave-sine w-4 h-4 mt-px shrink-0 text-violet-500"></span>
			<div class="flex-1 min-w-0">
				<p class="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{{ heading }}</p>
				<p v-if="proposal.message" class="text-[11px] text-zinc-500 leading-snug mt-0.5">{{ proposal.message }}</p>
			</div>
			<span class="shrink-0 text-[9px] font-bold uppercase tracking-widest px-1.5 py-px rounded" :class="pill.cls">{{ pill.text }}</span>
		</div>

		<!-- Open: the form -->
		<template v-if="proposal.status === 'open'">
			<div v-for="(item, i) in proposal.items" :key="i" class="pt-3 hair-t first-of-type:pt-0 first-of-type:border-t-0 space-y-2">
				<div class="flex items-center gap-1.5">
					<span class="iconify w-3.5 h-3.5 text-zinc-400" :class="KIND_ICON[item.request.capability]"></span>
					<span class="text-xs font-semibold">{{ item.purpose || CAPABILITY_LABEL[item.request.capability] }}</span>
					<span class="ml-auto text-[10px] text-zinc-500 tabular-nums">{{ itemCost(i) }}</span>
				</div>
				<p v-if="item.why" class="text-[11px] text-zinc-500 leading-snug">{{ item.why }}</p>
				<AudioRequestFields v-model="drafts[i]" :auto-model="item.autoModel ?? ''" auto-voice="" :rows="item.request.capability === 'speech' ? 3 : 2" />
			</div>

			<div class="pt-3 hair-t space-y-2.5">
				<div class="flex justify-between gap-3 text-[11px] text-zinc-500">
					<span>{{ totalLine }}</span>
					<span v-if="left !== null" class="tabular-nums">{{ left.toLocaleString() }} credits left</span>
				</div>
				<label class="flex items-center gap-2 text-[11px] text-zinc-600 dark:text-zinc-300">
					<input v-model="remember" type="checkbox" />
					Don’t ask again in this project (Auto)
				</label>
				<div class="flex flex-wrap items-center gap-2">
					<button class="btn-text btn-text-primary" :disabled="!!problem || sending" data-testid="proposal-make" @click="make('person')">
						<span class="iconify w-3.5 h-3.5" :class="sending ? 'tabler--loader-2 animate-spin' : 'tabler--sparkles'"></span>
						Make it
					</button>
					<button class="btn-text" :disabled="sending" data-testid="proposal-choose" @click="make('assistant')">You choose for me</button>
					<button class="btn-text" :disabled="sending" data-testid="proposal-decline" @click="decline">Not now</button>
				</div>
				<p v-if="problem" class="text-[11px] text-amber-500 leading-snug">{{ problem }}</p>
				<p v-if="error" class="text-[11px] text-red-500 leading-snug">{{ error }}</p>
			</div>
		</template>

		<!-- Making, made, failed: one line per item -->
		<div v-else-if="proposal.status !== 'declined'" class="space-y-1">
			<div v-for="(item, i) in proposal.items" :key="i" class="flex items-center gap-2 min-h-[30px]">
				<span v-if="!item.result && !item.error" class="w-6 h-6 flex items-center justify-center shrink-0">
					<span class="iconify tabler--loader-2 w-3.5 h-3.5 animate-spin text-violet-400"></span>
				</span>
				<button v-else-if="item.result && assetOf(item)" class="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-zinc-400 hover:text-accent-light transition"
					:aria-label="`Hear ${item.result.name}`" @click="store.auditionAsset(assetOf(item)!)">
					<span class="iconify tabler--player-play-filled w-3 h-3"></span>
				</button>
				<span v-else class="w-6 h-6 flex items-center justify-center shrink-0">
					<span class="iconify tabler--alert-triangle w-3.5 h-3.5 text-red-500"></span>
				</span>
				<span class="flex-1 min-w-0">
					<span class="block text-xs font-semibold truncate">{{ item.purpose || CAPABILITY_LABEL[item.request.capability] }}</span>
					<span class="block text-[10px] truncate" :class="item.error ? 'text-red-500' : 'text-zinc-500'">{{ itemLine(item) }}</span>
				</span>
			</div>
		</div>

		<p v-if="proposal.status === 'declined'" class="text-[11px] text-zinc-500">Not made{{ proposal.note ? `: ${proposal.note}` : '.' }}</p>

		<!-- Answered after the assistant stopped waiting: it hears of it in the next message -->
		<div v-if="needsTelling" class="flex items-center gap-2 pt-2 hair-t">
			<span class="text-[11px] text-zinc-500 flex-1">{{ proposal.agent }} is waiting for its turn to finish.</span>
			<button class="btn-text btn-text-primary" @click="tellAssistant">Tell {{ proposal.agent }}</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CAPABILITY_LABEL, creditsLeft, estimateCredits, requestProblem, type AudioCapability, type GenerateRequest } from '@shared/audioProviders'
import { assistantChoices, followUpMessage, proposalCredits, type AudioProposal, type ProposalItem } from '@shared/audioProposals'
import { findModel } from '@shared/audioModels'
import { useAudioStore } from '../../stores/audioStore'
import { useEditorStore } from '../../stores/editorStore'
import AudioRequestFields from './AudioRequestFields.vue'

/**
 * An agent's proposal to make audio, in the chat.
 *
 * Open, it is a form: each item's model (Auto shows what it stands for), voice,
 * words and length, what it will cost and what the account has left. Make it
 * sends the form as edited; You choose for me sends the assistant's own picks;
 * Not now declines. Pressing one is the person's consent. Main makes the audio
 * and sends this card each step, so it turns into a receipt in place.
 */
const props = defineProps<{ proposal: AudioProposal }>()

const audio = useAudioStore()
const store = useEditorStore()

const KIND_ICON: Record<AudioCapability, string> = { speech: 'tabler--microphone', sfx: 'tabler--wave-saw-tool', music: 'tabler--music' }

// ===== The form: a copy of each request the person may edit =====

const drafts = ref<GenerateRequest[]>(props.proposal.items.map((i) => ({ ...i.request })))
watch(() => props.proposal.id, () => { drafts.value = props.proposal.items.map((i) => ({ ...i.request })) })
const remember = ref(false)
const sending = ref(false)
const error = ref('')

const provider = computed(() => props.proposal.items[0]?.request.provider)
const catalog = computed(() => (provider.value ? audio.catalogs[provider.value] ?? null : null))
watch(provider, (id) => { if (id) { void audio.loadCatalog(id); void audio.loadAccount(id) } }, { immediate: true })

/** An empty model on the form is Auto: the proposal's own pick stands for it. */
const resolved = (req: GenerateRequest, item: ProposalItem): GenerateRequest =>
	req.model || !item.autoModel ? req : { ...req, model: item.autoModel }
const finalRequests = computed(() => drafts.value.map((r, i) => resolved(r, props.proposal.items[i])))

const problem = computed(() => {
	for (const [i, req] of finalRequests.value.entries()) {
		const p = requestProblem(req, catalog.value)
		if (p) return `${props.proposal.items[i].purpose || CAPABILITY_LABEL[req.capability]}: ${p}`
	}
	return null
})

const itemCost = (i: number) => {
	const c = estimateCredits(finalRequests.value[i], catalog.value)
	return c === null ? '' : `about ${c.toLocaleString()} credits`
}
const totalLine = computed(() => {
	const total = proposalCredits(finalRequests.value, catalog.value)
	return total === null ? 'Costs credits; the exact number shows once made' : `Total about ${total.toLocaleString()} credits`
})
const left = computed(() => {
	const a = provider.value ? audio.accounts[provider.value] : null
	return a ? creditsLeft(a) : null
})

const make = async (chosenBy: 'person' | 'assistant') => {
	if (chosenBy === 'person' && problem.value) return
	sending.value = true
	error.value = ''
	const items = chosenBy === 'assistant' ? assistantChoices(props.proposal) : finalRequests.value
	error.value = (await audio.answerProposal(props.proposal.id, { action: 'make', items, chosenBy, remember: remember.value })) ?? ''
	sending.value = false
}

const decline = async () => {
	sending.value = true
	error.value = (await audio.answerProposal(props.proposal.id, { action: 'decline' })) ?? ''
	sending.value = false
}

// ===== After: the receipt =====

const A_KIND: Record<AudioCapability, string> = { speech: 'a voice-over', sfx: 'a sound effect', music: 'music' }
const heading = computed(() => {
	const n = props.proposal.items.length
	const kind = props.proposal.items[0]?.request.capability
	const what = n === 1 && kind ? A_KIND[kind] : `${n} sounds`
	if (props.proposal.status === 'open') return `${props.proposal.agent} would like to make ${what}`
	if (props.proposal.auto) return `${props.proposal.agent} made ${what} (Auto)`
	if (props.proposal.status === 'declined') return `${props.proposal.agent} proposed ${what}`
	return `${props.proposal.agent} made ${what}`
})

const pill = computed(() => {
	switch (props.proposal.status) {
		case 'open': return { text: 'Needs you', cls: 'bg-violet-500/10 text-violet-500' }
		case 'making': return { text: 'Making', cls: 'bg-zinc-500/10 text-zinc-500' }
		case 'made': {
			const credits = props.proposal.items.reduce((n, i) => n + (i.result?.credits ?? 0), 0)
			return { text: credits ? `${credits.toLocaleString()} credits` : 'Made', cls: 'bg-accent/10 text-accent' }
		}
		case 'declined': return { text: 'Not now', cls: 'bg-zinc-500/10 text-zinc-500' }
		default: return { text: 'Failed', cls: 'bg-red-500/10 text-red-500' }
	}
})

const assetOf = (item: ProposalItem) => store.assets.find((a) => a.id === item.result?.assetId)
const itemLine = (item: ProposalItem) => {
	if (item.error) return item.error
	if (!item.result) return 'Making…'
	const r = item.result
	// With no model list (a key that may not read it), the provider picked its own default.
	const model = !r.model ? '' : r.model === 'provider default' ? 'default model'
		: findModel(catalog.value, item.request.capability, r.model)?.label ?? r.model
	return [model, r.lengthSec ? `${r.lengthSec.toFixed(1)} s` : '', typeof r.credits === 'number' ? `${r.credits.toLocaleString()} credits` : '']
		.filter(Boolean).join(' · ')
}

// ===== Answered late: tell the assistant in the next message =====

const settled = computed(() => props.proposal.status === 'made' || props.proposal.status === 'declined')
const needsTelling = computed(() =>
	settled.value && !!props.proposal.late && !!props.proposal.turnId && !audio.toldAssistant.has(props.proposal.id))

const tellAssistant = async () => {
	if (!needsTelling.value || store.promptRunning) return
	audio.toldAssistant.add(props.proposal.id)
	await store.runPrompt(followUpMessage(props.proposal))
}

// It goes by itself once the chat is free; the button is there while it is not.
watch(() => [needsTelling.value, store.promptRunning] as const, ([needs, running]) => {
	if (needs && !running) void tellAssistant()
}, { immediate: true })
</script>
