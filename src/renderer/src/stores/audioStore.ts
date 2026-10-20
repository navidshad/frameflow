import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
	DEFAULT_AUDIO_SETTINGS, type AudioCapability, type AudioProviderSettings, type GenerateRequest, type ProviderId, type ProviderStatus
} from '@shared/audioProviders'
import type { MediaAsset } from '@shared/types'

/**
 * Audio providers, renderer side: which are connected, the spend limits, the
 * voices to choose from. Main owns the keys and never sends one here; this only
 * mirrors what Settings and the Sound tab need to draw.
 */

const api = (window as any).api

export interface VoiceOption { id: string; name: string; description?: string }

export const useAudioStore = defineStore('audio', () => {
	const providers = ref<ProviderStatus[]>([])
	const settings = ref<AudioProviderSettings>({ ...DEFAULT_AUDIO_SETTINGS })
	const loaded = ref(false)
	const voices = ref<Partial<Record<ProviderId, VoiceOption[]>>>({})

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

	/** Makes the sound and returns the asset (the project already has it); `error` carries the provider's words. */
	const generate = async (threadId: string, request: GenerateRequest): Promise<{ asset: MediaAsset } | { error: string }> => {
		const result = await api.generateAudio({ threadId, request })
		return result?.ok ? { asset: result.asset } : { error: result?.error || 'The sound could not be made.' }
	}

	return { providers, settings, loaded, connected, voices, load, forCapability, statusOf, saveElevenLabsKey, update, loadVoices, generate }
})
