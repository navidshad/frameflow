import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { MediaAsset } from '../../shared/types'
import {
	PROVIDERS, type AudioCapability, type GenerateRequest, type ProviderAccount, type ProviderId, type ProviderStatus
} from '../../shared/audioProviders'
import { findModel, modelsFor, type ModelCatalog } from '../../shared/audioModels'
import type { AudioNotes, NotesInput } from '../../shared/audioNotes'
import { docsFor as cutDocs } from '../../shared/providerDocs'
import { createCatalogStore, type CatalogStore } from './catalog'
import { createNotesStore } from './notesStore'
import { createDocsCache, type SavedDoc } from './docs'
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

// ===== Model lists =====

/** One file per provider beside the settings: the last list it gave, and the rates learned since. */
const catalogFile = (id: ProviderId) => path.join(app.getPath('userData'), `audio-models-${id}.json`)
const catalogs = new Map<ProviderId, CatalogStore>()

function catalogStore(id: ProviderId): CatalogStore | null {
	const impl = PROVIDER_IMPLS[id]
	if (!impl?.catalog) return null
	let made = catalogs.get(id)
	if (!made) {
		made = createCatalogStore({
			provider: id,
			fetchCatalog: (prior) => {
				const key = keyFor(id)
				return impl.catalog!({ fetch, key: key ?? '' }, prior)
			},
			load: () => {
				const file = catalogFile(id)
				return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) as ModelCatalog : null
			},
			save: (catalog) => fs.writeFileSync(catalogFile(id), JSON.stringify(catalog, null, 1))
		})
		catalogs.set(id, made)
	}
	return made
}

/** The list with what agents picked for each kind attached: what "Auto" uses. */
function withPicks(id: ProviderId, catalog: ModelCatalog | null): ModelCatalog | null {
	if (!catalog) return null
	const picks = Object.fromEntries(notesStore.get().picks.filter((p) => p.provider === id).map((p) => [p.capability, p.model]))
	return { ...catalog, picks }
}

/** The provider's models as it lists them today: refreshed when a day old, or at once with `force`. */
export async function catalogFor(id: ProviderId, force = false): Promise<ModelCatalog | null> {
	if (!keyFor(id)) return withPicks(id, catalogStore(id)?.current() ?? null)
	return withPicks(id, (await catalogStore(id)?.ensure(force)) ?? null)
}

// ===== What agents learned about models: one file for every project =====

const notesFile = () => path.join(app.getPath('userData'), 'audio-model-notes.json')
const notesStore = createNotesStore({
	load: () => (fs.existsSync(notesFile()) ? JSON.parse(fs.readFileSync(notesFile(), 'utf-8')) : null),
	save: (notes) => fs.writeFileSync(notesFile(), JSON.stringify(notes, null, 1))
})

export const audioNotes = (): AudioNotes => notesStore.get()

/** An agent's findings and pick, checked against today's list so a misspelt model is refused. */
export async function saveAudioNotes(provider: ProviderId, input: NotesInput, by: string): Promise<{ saved: number; problems: string[] }> {
	const catalog = await catalogFor(provider)
	return notesStore.save(input, by, provider, (capability, model) => !!findModel(catalog, capability, model))
}

export const removeAudioNote = (target: Parameters<typeof notesStore.remove>[0]): AudioNotes => notesStore.remove(target)

// ===== The provider's own docs about its models =====

const docsFile = (url: string) => path.join(app.getPath('userData'), `audio-docs-${Buffer.from(url).toString('base64url').slice(-40)}.json`)
const docsCache = createDocsCache({
	fetch,
	load: (url) => (fs.existsSync(docsFile(url)) ? JSON.parse(fs.readFileSync(docsFile(url), 'utf-8')) as SavedDoc : null),
	save: (doc) => fs.writeFileSync(docsFile(doc.url), JSON.stringify(doc))
})

/** The parts of the provider's models page about one kind; null when it has none or it cannot be read. */
export async function audioDocs(id: ProviderId, capability: AudioCapability): Promise<{ url: string; fetchedAt: number; text: string } | null> {
	const url = PROVIDER_IMPLS[id]?.docsUrl
	if (!url) return null
	const doc = await docsCache.get(url)
	if (!doc) return null
	const catalog = await catalogFor(id)
	const models = modelsFor(catalog, capability)
	return { url, fetchedAt: doc.fetchedAt, text: cutDocs(doc.text, capability, models.map((m) => m.id), undefined, models.map((m) => m.label)) }
}

/** A new key may be another account, with other models and other prices: start over. */
export function forgetCatalog(id: ProviderId): void {
	catalogStore(id)?.reset()
}

export const realDeps = (): GenerateDeps => ({
	providers: PROVIDER_IMPLS, keyFor, store,
	catalog: (id) => catalogFor(id),
	learnRate: (id, model, credits, units) => catalogStore(id)?.learnRate(model, credits, units)
})

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

/** What the provider account has left; null when it is not connected or has no allowance to report. */
export async function accountFor(id: ProviderId): Promise<ProviderAccount | null> {
	const impl = PROVIDER_IMPLS[id]
	const key = keyFor(id)
	if (!impl?.account || !key) return null
	return impl.account({ fetch, key })
}

/** A request's price before it is made, for the spend cap. */
export const estimateUsd = (req: GenerateRequest): number | null =>
	PROVIDER_IMPLS[req.provider]?.estimateUsd(req, catalogStore(req.provider)?.current()) ?? null

/** The models as last known, without asking: for an estimate that must not wait. */
export const knownCatalog = (id: ProviderId): ModelCatalog | null => catalogStore(id)?.current() ?? null

export type { MediaAsset }
