import type { MediaAsset } from '../../shared/types'
import {
	PROVIDERS, type GenerateRequest, type ProviderId, type ProviderStatus
} from '../../shared/audioProviders'
import { settingsManager } from '../settings'
import { threadManager } from '../threads'
import { createMediaAsset, patchAsset } from '../editor/assets'
import { PROVIDER_IMPLS } from './index'
import { generateAudioAsset, type GenerateDeps, type Generated } from './generate'
import type { Voice } from './provider'

/**
 * The app's own wiring of the audio providers: where keys come from, and how a
 * generated sound becomes part of a project. Everything with a policy or a
 * network call is elsewhere and tested without Electron; this file only connects
 * them to settings and the project store.
 */

/** The key for a provider, or undefined when it is not connected. */
export function keyFor(id: ProviderId): string | undefined {
	if (id === 'elevenlabs') return settingsManager.getElevenLabsKey()
	// Gemini voices use the key the app already has, once the user has switched them on.
	return settingsManager.getAudioSettings().geminiVoices ? settingsManager.getGeminiApiKey() || undefined : undefined
}

export function providerStatuses(): ProviderStatus[] {
	return PROVIDERS.map((p) => ({
		id: p.id, label: p.label, capabilities: p.capabilities, note: p.note, needs: p.needs,
		connected: !!keyFor(p.id),
		keySaved: p.id === 'elevenlabs' ? !!settingsManager.getElevenLabsKey() : !!settingsManager.getGeminiApiKey()
	}))
}

export const connectedProviders = (): ProviderId[] => providerStatuses().filter((p) => p.connected).map((p) => p.id)

const store: GenerateDeps['store'] = {
	tempDir: (threadId) => threadManager.getThread(threadId)?.tempDir ?? null,
	addAsset: (threadId, o) => createMediaAsset(threadId, { sourcePath: o.sourcePath, name: o.name, assetId: o.assetId, referenceInPlace: true, deriveTitle: false }),
	patchAsset: (threadId, id, patch) => patchAsset(threadId, id, patch),
	addUsage: (threadId, record) => threadManager.updateThreadWith(threadId, (t) => ({ usageHistory: [...(t.usageHistory || []), record] })),
	getAsset: (threadId, id) => threadManager.getThread(threadId)?.editor?.media.find((a) => a.id === id) ?? null
}

export const realDeps = (): GenerateDeps => ({ providers: PROVIDER_IMPLS, keyFor, store })

export function generateForProject(threadId: string, req: GenerateRequest, signal?: AbortSignal): Promise<Generated> {
	return generateAudioAsset(threadId, req, realDeps(), signal)
}

export async function voicesFor(id: ProviderId): Promise<Voice[]> {
	const impl = PROVIDER_IMPLS[id]
	const key = keyFor(id)
	if (!impl?.voices) return []
	// Gemini's voices are a fixed list and need no key; ElevenLabs lists the account's.
	if (id !== 'gemini' && !key) return []
	return impl.voices({ fetch, key: key ?? '' })
}

/** A request's price before it is made, for the spend cap. */
export const estimateUsd = (req: GenerateRequest): number | null => PROVIDER_IMPLS[req.provider]?.estimateUsd(req) ?? null

export type { MediaAsset }
