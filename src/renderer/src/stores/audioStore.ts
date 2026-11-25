import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
	DEFAULT_AUDIO_SETTINGS, type AudioCapability, type AudioProviderSettings, type GenerateRequest, type ProviderAccount,
	type ProviderId, type ProviderStatus, type Voice
} from '@shared/audioProviders'
import type { ModelCatalog } from '@shared/audioModels'
import type { AudioProposal, ProposalAnswer } from '@shared/audioProposals'
import { EMPTY_NOTES, type AudioNotes, type ModelNote, type ModelPick } from '@shared/audioNotes'
import type { MediaAsset } from '@shared/types'

/**
 * Audio providers, renderer side: which are connected, the spend limits, the
 * voices to choose from. Main owns the keys and never sends one here; this only
 * mirrors what Settings and the Sound tab need to draw.
 */

const api = (window as any).api

/**
 * A plain copy for IPC. Requests come from reactive form state, and Electron
 * cannot send a reactive proxy: the call fails before it leaves the page.
 */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value))

export type VoiceOption = Voice

export const useAudioStore = defineStore('audio', () => {
	const providers = ref<ProviderStatus[]>([])
	const settings = ref<AudioProviderSettings>({ ...DEFAULT_AUDIO_SETTINGS })
	const loaded = ref(false)
	const voices = ref<Partial<Record<ProviderId, VoiceOption[]>>>({})
	/** Each provider's models as it lists them today; null when it publishes none or could not be asked. */
	const catalogs = ref<Partial<Record<ProviderId, ModelCatalog | null>>>({})
	/** Agents' audio proposals, as main last sent them: main owns their state, this only draws it. */
	const proposals = ref<Record<string, AudioProposal>>({})
	api.onAudioProposal?.((proposal: AudioProposal) => {
		proposals.value = { ...proposals.value, [proposal.id]: proposal }
		// Something was made: the balance and the learned rates moved.
		if (proposal.status === 'made') {
			const provider = proposal.items[0]?.request.provider
			if (provider) {
				void loadAccount(provider, true)
				catalogs.value = { ...catalogs.value, [provider]: undefined }
				void loadCatalog(provider)
			}
		}
	})
	/** Late answers already passed on to the assistant, so each is told once. */
	const toldAssistant = ref<Set<string>>(new Set())
	/** What each account has left, as last read; null when the provider could not say. */
	const accounts = ref<Partial<Record<ProviderId, ProviderAccount | null>>>({})

	const apply = (state: { providers: ProviderStatus[]; settings: AudioProviderSettings } | null) => {
		if (!state) return
		providers.value = state.providers
		settings.value = state.settings
		loaded.value = true
	}

	const load = async () => apply(await api.audioProviders())

	const connected = computed(() => providers.value.filter((p) => p.connected))
	/** The connected providers that can make this kind, in the order Settings lists them. */
	const forCapability = (capability: AudioCapability) => connected.value.filter((p) => p.capabilities.includes(capability))
	const statusOf = (id: ProviderId) => providers.value.find((p) => p.id === id)

	const saveElevenLabsKey = async (key: string) => {
		apply(await api.setElevenLabsKey(key))
		voices.value = { ...voices.value, elevenlabs: undefined }
		accounts.value = { ...accounts.value, elevenlabs: undefined }
		catalogs.value = { ...catalogs.value, elevenlabs: undefined }
	}

	const update = async (patch: Partial<Omit<AudioProviderSettings, 'spend'>> & { spend?: Partial<AudioProviderSettings['spend']> }) =>
		apply(await api.updateAudioSettings(patch))

	/** Voices are listed once per provider and kept; a changed key forgets them. */
	const loadVoices = async (id: ProviderId): Promise<VoiceOption[]> => {
		const known = voices.value[id]
		if (known) return known
		const list: VoiceOption[] = await api.audioVoices(id)
		voices.value = { ...voices.value, [id]: list }
		return list
	}

	/**
	 * What the account has left. Asking is free, so it is read again whenever
	 * something was made (`fresh`), and otherwise kept.
	 */
	const loadAccount = async (id: ProviderId, fresh = false): Promise<ProviderAccount | null> => {
		if (!fresh && accounts.value[id] !== undefined) return accounts.value[id] ?? null
		const account: ProviderAccount | null = await api.audioAccount(id)
		accounts.value = { ...accounts.value, [id]: account }
		return account
	}

	/**
	 * The provider's models. Main asks the provider at most once a day; `refresh`
	 * asks it now. Read again after a generation for the rates it taught.
	 */
	const loadCatalog = async (id: ProviderId, refresh = false): Promise<ModelCatalog | null> => {
		if (!refresh && catalogs.value[id] !== undefined) return catalogs.value[id] ?? null
		const catalog: ModelCatalog | null = await api.audioModels(id, refresh)
		catalogs.value = { ...catalogs.value, [id]: catalog }
		return catalog
	}

	/** The proposals shown under one chat turn, or (turnId null) the outside agents' ones, oldest first. */
	const proposalsFor = (threadId: string | null | undefined, turnId: string | null): AudioProposal[] =>
		Object.values(proposals.value)
			.filter((p) => p.threadId === threadId && (turnId === null ? !p.turnId : p.turnId === turnId))
			.sort((a, b) => a.createdAt - b.createdAt)

	/** Sends what the person pressed; main does the rest and sends the card each step. */
	const answerProposal = async (id: string, answer: ProposalAnswer): Promise<string | null> => {
		const result = await api.answerAudioProposal(id, plain(answer))
		return result?.ok ? null : (result?.error || 'The proposal could not be answered.')
	}

	const setProjectAuto = (threadId: string, auto: boolean): Promise<boolean> => api.setProjectAudioAuto(threadId, auto)

	/** What agents learned about models: one list for every project. */
	const notes = ref<AudioNotes>({ ...EMPTY_NOTES })
	const loadNotes = async () => { notes.value = (await api.audioNotes()) ?? { ...EMPTY_NOTES } }
	const removeNote = async (n: ModelNote) => {
		notes.value = await api.removeAudioNote({ kind: 'note', provider: n.provider, capability: n.capability, model: n.model, source: n.source })
	}
	/** Forgetting a pick changes what Auto uses, which travels with the model list. */
	const removePick = async (p: ModelPick) => {
		notes.value = await api.removeAudioNote({ kind: 'pick', provider: p.provider, capability: p.capability })
		catalogs.value = { ...catalogs.value, [p.provider]: undefined }
		void loadCatalog(p.provider)
	}

	/** Makes the sound and returns the asset (the project already has it); `error` carries the provider's words. */
	const generate = async (threadId: string, request: GenerateRequest): Promise<{ asset: MediaAsset } | { error: string }> => {
		const result = await api.generateAudio({ threadId, request: plain(request) })
		if (result?.ok) {
			void loadAccount(request.provider, true)
			catalogs.value = { ...catalogs.value, [request.provider]: undefined }
			void loadCatalog(request.provider)
		}
		return result?.ok ? { asset: result.asset } : { error: result?.error || 'The sound could not be made.' }
	}

	/** What a request would cost in USD, for the spend cap's estimate; null when it cannot be priced. */
	const estimateUsd = (request: GenerateRequest): Promise<number | null> => api.estimateAudio(plain(request))

	return {
		estimateUsd,
		providers, settings, loaded, connected, voices, accounts, catalogs, proposals, toldAssistant,
		load, forCapability, statusOf, saveElevenLabsKey, update, loadVoices, loadAccount, loadCatalog, generate,
		proposalsFor, answerProposal, setProjectAuto, notes, loadNotes, removeNote, removePick
	}
})
