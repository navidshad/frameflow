import type { AudioCapability, ProviderId } from './audioProviders'

/**
 * The models a provider makes each kind of sound with, AS THE PROVIDER LISTS
 * THEM TODAY. FrameFlow keeps no list of model ids: ElevenLabs renamed and
 * retired models twice in 2026, and a list kept here would send a retired one.
 *
 * Where the lists come from (read 2026-11-24):
 * - Voice-over: `GET /v1/models`, the API's own model list (needs the key's
 *   "Models: read" permission). Each says what it is, how much text one request
 *   takes, its languages, and its cost per character relative to the base rate.
 * - Sound effects and music have no list endpoint. The API's published OpenAPI
 *   spec (`/openapi.json`) declares the model ids each endpoint accepts, in
 *   release order, and marks the deprecated ones (`x-fern-enum`).
 *
 * Main fetches both, keeps the last answer on disk for when it cannot ask, and
 * hands the result around as a `ModelCatalog`. Everything here is pure: parsing,
 * finding, and choosing, so tests feed it replies captured from the real API.
 */

export interface AudioModel {
	id: string
	provider: ProviderId
	capability: AudioCapability
	/** "Music v2.5": the provider's own name when it gives one. */
	label: string
	/** The provider's own words about it, when it gives any. */
	description?: string
	/** Speech: the longest text one request takes. */
	maxChars?: number
	/** Speech: how many languages it reads. */
	languages?: number
	/** Speech: cost per character relative to the provider's base rate (1 = base, 0.5 = half). */
	costMultiplier?: number
	/** The provider says it is going away: never chosen for anyone, shown last with a warning. */
	deprecated?: boolean
}

export interface ModelCatalog {
	provider: ProviderId
	/** In the provider's own order (release order for effects and music). */
	models: AudioModel[]
	/** When the provider was last asked successfully; 0 when it never was. */
	fetchedAt: number
	/** What could not be read, in words for the person ("voice models need the key's Models: read permission"). */
	gaps?: string[]
	/**
	 * Credits each model was seen to use per unit (a character for speech, a
	 * second for effects and music), learned from the provider's own count on
	 * each reply. Empty until something has been made.
	 */
	rates?: Record<string, number>
	/**
	 * The model an agent picked for each kind after researching them (kept in
	 * audioNotes, not in the list's file): what Auto uses. Main adds it when it
	 * hands the list out.
	 */
	picks?: Partial<Record<AudioCapability, string>>
	/**
	 * The model the provider's own API uses when a request names none, for a
	 * kind whose list is in no particular order (voice-over). Read from the
	 * API spec. Effects and music have none here: their spec defaults are the
	 * models being retired, and their lists are in release order instead.
	 */
	defaults?: Partial<Record<AudioCapability, string>>
}

// ===== Names =====

/** "music_v2_5" → "Music v2.5", "eleven_text_to_sound_v3" → "Text to sound v3", for ids the provider gives no name. */
export function labelFor(id: string): string {
	const words = id.replace(/^eleven_/, '').split('_')
	const out: string[] = []
	for (let i = 0; i < words.length; i++) {
		const w = words[i]
		if (/^v\d+$/.test(w)) {
			// v2 then 5 → v2.5
			const minor = words[i + 1] && /^\d+$/.test(words[i + 1]) ? `.${words[++i]}` : ''
			out.push(`${w}${minor}`)
		} else out.push(w)
	}
	const text = out.join(' ')
	return text.charAt(0).toUpperCase() + text.slice(1)
}

// ===== Parsing what the provider says =====

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * `GET /v1/models` → the voice-over models. Only ones that can read text, and
 * not ones that need alpha access the account may not have.
 */
export function parseSpeechModels(body: unknown): AudioModel[] {
	if (!Array.isArray(body)) return []
	const out: AudioModel[] = []
	for (const raw of body) {
		const m = raw as Record<string, any>
		if (!m || typeof m.model_id !== 'string' || m.can_do_text_to_speech !== true || m.requires_alpha_access === true) continue
		const maxChars = num(m.maximum_text_length_per_request) ?? num(m.max_characters_request_subscribed_user)
		const languages = Array.isArray(m.languages) ? m.languages.length : undefined
		const costMultiplier = num(m.model_rates?.character_cost_multiplier)
		out.push({
			id: m.model_id, provider: 'elevenlabs', capability: 'speech',
			label: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : labelFor(m.model_id),
			...(typeof m.description === 'string' && m.description.trim() ? { description: m.description.trim() } : {}),
			...(maxChars ? { maxChars } : {}),
			...(languages ? { languages } : {}),
			...(costMultiplier !== undefined ? { costMultiplier } : {}),
			...(/deprecat/i.test(String(m.description ?? '')) ? { deprecated: true } : {})
		})
	}
	return out
}

/** The endpoints whose `model_id` the spec declares, and the kind each makes. */
export const SPEC_ENDPOINTS: readonly { path: string; capability: Exclude<AudioCapability, 'speech'> }[] = [
	{ path: '/v1/sound-generation', capability: 'sfx' },
	{ path: '/v1/music', capability: 'music' }
]

/**
 * The voice-over endpoint's own default model, from the spec: what the API
 * reads with when asked for no model. Voice models come from `/v1/models` in
 * no release order, so this is the fallback before anyone has picked.
 */
export function parseSpecDefaults(spec: unknown): Partial<Record<AudioCapability, string>> {
	const root = spec as Record<string, any>
	const schemas = root?.components?.schemas ?? {}
	const resolve = (node: any): any => (typeof node?.$ref === 'string' ? schemas[node.$ref.split('/').pop()!] : node)
	const content = root?.paths?.['/v1/text-to-speech/{voice_id}']?.post?.requestBody?.content ?? {}
	const body = resolve((content['application/json'] ?? Object.values(content)[0])?.schema)
	const field = body?.properties?.model_id
	const id = typeof field?.default === 'string' ? field.default : typeof resolve(field)?.default === 'string' ? resolve(field).default : undefined
	return id ? { speech: id } : {}
}

/**
 * The API's OpenAPI spec → the effect and music models: each endpoint's
 * request body, its `model_id` property, and the enum that property points at.
 * Followed by reference, not by schema name, so a renamed schema still reads.
 */
export function parseSpecModels(spec: unknown): AudioModel[] {
	const root = spec as Record<string, any>
	const schemas = root?.components?.schemas ?? {}
	const resolve = (node: any): any => {
		const ref = typeof node?.$ref === 'string' ? node.$ref : null
		return ref ? schemas[ref.split('/').pop()!] : node
	}
	const out: AudioModel[] = []
	for (const { path, capability } of SPEC_ENDPOINTS) {
		const content = root?.paths?.[path]?.post?.requestBody?.content ?? {}
		const body = resolve((content['application/json'] ?? Object.values(content)[0])?.schema)
		const field = resolve(body?.properties?.model_id)
		const ids: unknown[] = Array.isArray(field?.enum) ? field.enum : []
		const notes = field?.['x-fern-enum'] ?? {}
		for (const id of ids) {
			if (typeof id !== 'string') continue
			const note = notes[id] ?? {}
			out.push({
				id, provider: 'elevenlabs', capability, label: labelFor(id),
				...(note.deprecated === true ? { deprecated: true } : {})
			})
		}
	}
	return out
}

// ===== Finding and choosing =====

export const modelsFor = (catalog: ModelCatalog | null | undefined, capability: AudioCapability): AudioModel[] =>
	(catalog?.models ?? []).filter((m) => m.capability === capability)

/** The ones not retiring. Every model is still offered; these are the ones to prefer. */
export const usableModels = (catalog: ModelCatalog | null | undefined, capability: AudioCapability): AudioModel[] =>
	modelsFor(catalog, capability).filter((m) => !m.deprecated)

export const findModel = (catalog: ModelCatalog | null | undefined, capability: AudioCapability, id: string | undefined): AudioModel | undefined =>
	id ? modelsFor(catalog, capability).find((m) => m.id === id) : undefined

/** What a request says about itself when a model is chosen for it. */
export interface ModelNeeds {
	capability: AudioCapability
	/** The text to read (speech) or the description (effects, music). */
	prompt: string
	/** Speech: the voice is the person's own clone. */
	ownVoice?: boolean
}

/**
 * The model to use when nobody named one: the Sound tab's "Default" and the
 * proposal card's "Auto".
 *
 * FrameFlow does not judge models itself. An agent researches them and saves
 * its pick for each kind (audioNotes.ts); main hands that pick around with the
 * list (`catalog.picks`), and this uses it while the provider still lists it and
 * has not retired it. Before anyone has researched: for voice-over, the model
 * the provider's own API uses by default (its voice list is in no order); for
 * effects and music, the provider's newest model that is not retiring (their
 * lists are in release order); failing those, the newest of all. Undefined
 * only when the provider listed none.
 */
export function chooseModel(catalog: ModelCatalog | null | undefined, needs: ModelNeeds): AudioModel | undefined {
	const all = modelsFor(catalog, needs.capability)
	const picked = findModel(catalog, needs.capability, catalog?.picks?.[needs.capability])
	if (picked && !picked.deprecated) return picked
	const fallback = findModel(catalog, needs.capability, catalog?.defaults?.[needs.capability])
	if (fallback && !fallback.deprecated) return fallback
	const current = all.filter((m) => !m.deprecated)
	return current[current.length - 1] ?? all[all.length - 1]
}

/** The model a request will run on: the one it names, else the chosen one. */
export function modelOf(
	catalog: ModelCatalog | null | undefined,
	req: { capability: AudioCapability; prompt: string; model?: string },
	ownVoice = false
): AudioModel | undefined {
	return findModel(catalog, req.capability, req.model) ?? chooseModel(catalog, { capability: req.capability, prompt: req.prompt, ownVoice })
}
