import { estimateCredits, type GenerateRequest, type ProviderAccount, type Voice, type VoiceKind } from '../../shared/audioProviders'
import { modelOf, parseSpecDefaults, parseSpecModels, parseSpeechModels, type AudioModel, type ModelCatalog } from '../../shared/audioModels'
import { ProviderError, type AudioProviderImpl, type ProviderContext, type ProviderOutput } from './provider'

/**
 * ElevenLabs: voices, sound effects from a prompt, and music.
 *
 * Request shapes are from the official API reference (elevenlabs.io/docs/api-reference),
 * re-read on 2026-11-24: auth is the `xi-api-key` header; the output format is the
 * `output_format` query parameter; text-to-speech is `POST /v1/text-to-speech/{voice_id}`,
 * sound effects `POST /v1/sound-generation`, music `POST /v1/music`, voices
 * `GET /v2/voices` (paged by `next_page_token`), the account's allowance
 * `GET /v1/user/subscription`. Each generation returns the audio file as the body.
 *
 * Models are never listed here. `fetchCatalog` asks ElevenLabs which exist
 * today (`GET /v1/models` for voices; the API's own OpenAPI spec for effects and
 * music), and every request names one of those: left out, the API falls back to
 * models it has deprecated.
 *
 * ElevenLabs bills in credits. `credits` is what the reply's `character-cost`
 * header says it used, or the estimate from rates learned earlier when there is
 * none. The USD figure is the API pricing page's list price, kept for the
 * agent's dollar cap and labelled an estimate wherever it is shown.
 */

export const ELEVENLABS_BASE = 'https://api.elevenlabs.io'
/** The API's published spec: the one place that lists the effect and music model ids. No key needed. */
export const ELEVENLABS_SPEC_URL = `${ELEVENLABS_BASE}/openapi.json`
const OUTPUT_FORMAT = 'mp3_44100_128'

const SPEECH_USD_PER_1K_CHARS = 0.08
const SFX_USD_PER_MIN = 0.12
const MUSIC_USD_PER_MIN = 0.15
/** What a sound effect costs when the provider picks its length: five seconds is a fair guess. */
const SFX_DEFAULT_SEC = 5
const MUSIC_DEFAULT_SEC = 30
/** Voices are listed a page of 100 at a time; past this many, the rest are left out. */
const MAX_VOICE_PAGES = 5

const ESTIMATE = 'estimated at list price'

/** A provider's complaint, turned into one sentence for the person. */
async function failure(res: Response): Promise<ProviderError> {
	let message = ''
	try {
		const body = await res.json() as { detail?: unknown }
		const d = body?.detail
		if (typeof d === 'string') message = d
		else if (Array.isArray(d)) message = d.map((x: { msg?: string }) => x?.msg).filter(Boolean).join('; ')
		else if (d && typeof d === 'object') {
			const o = d as { message?: string; code?: string }
			message = o.message || o.code || ''
		}
	} catch { /* a body that is not JSON says nothing more */ }
	const said = message ? `: ${message}` : ''
	if (res.status === 401) return new ProviderError(`ElevenLabs did not accept the API key${said}. Check it in Settings → Audio providers.`, 401, 'auth')
	if (res.status === 402) return new ProviderError(`ElevenLabs says the plan is out of credits${said}.`, 402, 'quota')
	if (res.status === 429) return new ProviderError(`ElevenLabs is rate limiting this key${said}. Try again in a moment.`, 429, 'rate')
	if (res.status === 400 || res.status === 422 || res.status === 404) return new ProviderError(`ElevenLabs could not use that request${said}.`, res.status, 'input')
	if (res.status === 403) return new ProviderError(`ElevenLabs refused this on your plan${said}. Music and some voices need a paid plan.`, 403, 'auth')
	return new ProviderError(`ElevenLabs had a problem (${res.status})${said}. Try again.`, res.status)
}

function headers(key: string, json = true): Record<string, string> {
	return { 'xi-api-key': key, ...(json ? { 'content-type': 'application/json', accept: 'audio/mpeg' } : {}) }
}

const round4 = (n: number) => Math.round(n * 10000) / 10000

/**
 * The credits a call really used. Voice-over and sound effects say so in a
 * `character-cost` header (seen on every such reply, 2026-11-24, though the API
 * reference does not list it); music does not, so it falls back to the estimate.
 */
export function chargedCredits(res: Pick<Response, 'headers'>): number | null {
	const raw = res.headers.get('character-cost')
	const n = raw === null ? Number.NaN : Number(raw)
	return Number.isFinite(n) && n >= 0 ? n : null
}

/** ElevenLabs' `category` in the words the app uses. */
const KIND: Record<string, VoiceKind> = {
	cloned: 'cloned', professional: 'professional', generated: 'designed', premade: 'premade', famous: 'library', high_quality: 'library'
}

interface ApiVoice {
	voice_id: string
	name: string
	category?: string
	preview_url?: string
	description?: string
	labels?: Record<string, string>
	verified_languages?: { language?: string }[]
}

function toVoice(v: ApiVoice): Voice {
	const labels = v.labels ?? {}
	// Labels say more than a missing description: "american, female, narration".
	const fromLabels = ['accent', 'gender', 'age', 'descriptive', 'use_case', 'use case']
		.map((k) => labels[k]).filter(Boolean).join(', ')
	const language = labels.language || v.verified_languages?.[0]?.language
	return {
		id: v.voice_id, name: v.name,
		...(v.preview_url ? { previewUrl: v.preview_url } : {}),
		...(v.description || fromLabels ? { description: v.description || fromLabels } : {}),
		kind: KIND[v.category ?? ''] ?? 'other',
		...(language ? { language } : {})
	}
}

/** Every voice the account can use, the person's own first, then the rest by name. */
async function listVoices(ctx: ProviderContext): Promise<Voice[]> {
	const all: Voice[] = []
	let token: string | undefined
	for (let page = 0; page < MAX_VOICE_PAGES; page++) {
		const query = new URLSearchParams({ page_size: '100', ...(token ? { next_page_token: token } : {}) })
		const res = await ctx.fetch(`${ELEVENLABS_BASE}/v2/voices?${query}`, { headers: headers(ctx.key, false), signal: ctx.signal })
		if (!res.ok) throw await failure(res)
		const body = await res.json() as { voices?: ApiVoice[]; has_more?: boolean; next_page_token?: string | null }
		all.push(...(body.voices ?? []).map(toVoice))
		if (!body.has_more || !body.next_page_token) break
		token = body.next_page_token
	}
	const rank = (v: Voice) => (v.kind === 'cloned' || v.kind === 'professional' || v.kind === 'designed' ? 0 : v.kind === 'premade' ? 1 : 2)
	return all.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * The voice to read with when none is named: a stock voice, never the person's
 * own clone. A clone says words in someone's real voice, so it is used only when
 * it is chosen.
 */
export function fallbackVoice(voices: Voice[]): Voice | undefined {
	return voices.find((v) => v.kind === 'premade') ?? voices.find((v) => v.kind !== 'cloned' && v.kind !== 'professional') ?? voices[0]
}

async function account(ctx: ProviderContext): Promise<ProviderAccount> {
	const res = await ctx.fetch(`${ELEVENLABS_BASE}/v1/user/subscription`, { headers: headers(ctx.key, false), signal: ctx.signal })
	if (!res.ok) throw await failure(res)
	const body = await res.json() as { tier?: string; character_count?: number; character_limit?: number; next_character_count_reset_unix?: number }
	return {
		provider: 'elevenlabs',
		...(body.tier ? { tier: body.tier } : {}),
		creditsUsed: Number(body.character_count) || 0,
		creditsLimit: Number(body.character_limit) || 0,
		...(body.next_character_count_reset_unix ? { resetsAt: body.next_character_count_reset_unix * 1000 } : {})
	}
}

/**
 * Which models ElevenLabs offers today. Two sources, each allowed to fail on
 * its own: what one cannot say, the list known before keeps (`prior`), and
 * `gaps` says why in words for the person. Throws only when neither answered.
 */
export async function fetchCatalog(ctx: ProviderContext, prior: ModelCatalog | null, now = Date.now()): Promise<ModelCatalog> {
	const gaps: string[] = []
	let speech: AudioModel[] | null = null
	let others: AudioModel[] | null = null
	let defaults = prior?.defaults

	try {
		const res = await ctx.fetch(`${ELEVENLABS_BASE}/v1/models`, { headers: headers(ctx.key, false), signal: ctx.signal })
		if (res.ok) speech = parseSpeechModels(await res.json())
		else {
			const why = (await failure(res)).message
			gaps.push(/models_read/.test(why)
				? 'Voice models: the API key needs the "Models: read" permission (ElevenLabs → Developers → API keys).'
				: `Voice models: ${why}`)
		}
	} catch (error) {
		gaps.push(`Voice models: ${(error as Error).message}`)
	}

	try {
		const res = await ctx.fetch(ELEVENLABS_SPEC_URL, { signal: ctx.signal })
		if (!res.ok) gaps.push(`Sound effect and music models: the API spec answered ${res.status}.`)
		else {
			const spec = await res.json()
			others = parseSpecModels(spec)
			defaults = parseSpecDefaults(spec)
			if (!others.length) { others = null; gaps.push('Sound effect and music models: the API spec listed none.') }
		}
	} catch (error) {
		gaps.push(`Sound effect and music models: ${(error as Error).message}`)
	}

	if (!speech && !others) throw new ProviderError(gaps.join(' '))
	const kept = (keep: (m: AudioModel) => boolean) => (prior?.models ?? []).filter(keep)
	return {
		provider: 'elevenlabs',
		models: [...(speech ?? kept((m) => m.capability === 'speech')), ...(others ?? kept((m) => m.capability !== 'speech'))],
		fetchedAt: now,
		...(gaps.length ? { gaps } : {}),
		...(defaults && Object.keys(defaults).length ? { defaults } : {}),
		rates: prior?.rates ?? {}
	}
}

export const elevenlabs: AudioProviderImpl = {
	id: 'elevenlabs',
	capabilities: ['speech', 'sfx', 'music'],

	estimateUsd(req: GenerateRequest, catalog?: ModelCatalog | null) {
		if (req.capability === 'speech') {
			// List price is the base rate; the model list says how far each model is from it (Flash is half).
			const ratio = modelOf(catalog, req)?.costMultiplier ?? 1
			return round4((req.prompt.trim().length / 1000) * SPEECH_USD_PER_1K_CHARS * ratio)
		}
		if (req.capability === 'sfx') return round4(((req.durationSec ?? SFX_DEFAULT_SEC) / 60) * SFX_USD_PER_MIN)
		return round4(((req.durationSec ?? MUSIC_DEFAULT_SEC) / 60) * MUSIC_USD_PER_MIN)
	},

	voices: listVoices,
	account,
	catalog: fetchCatalog,
	// The models page in markdown: one section per model, the selection guide, what is retiring and when.
	docsUrl: 'https://elevenlabs.io/docs/overview/models.md',

	async generate(req, ctx): Promise<ProviderOutput> {
		const text = req.prompt.trim()
		// The model asked for, else the one chosen from today's list. With no list
		// at all (never reached), the API's own default is the only choice left.
		const model = modelOf(ctx.catalog, req)?.id
		const named = model ? { model_id: model } : {}
		let url: string
		let body: Record<string, unknown>

		if (req.capability === 'speech') {
			// A voice is required by the endpoint. Asked for none, read with a stock one.
			let voice = req.voice
			if (!voice) {
				voice = fallbackVoice(await listVoices(ctx))?.id
				if (!voice) throw new ProviderError('ElevenLabs has no voices on this account to read with.', undefined, 'input')
			}
			url = `${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${OUTPUT_FORMAT}`
			body = { text, ...named }
		} else if (req.capability === 'sfx') {
			url = `${ELEVENLABS_BASE}/v1/sound-generation?output_format=${OUTPUT_FORMAT}`
			body = {
				text, ...named, prompt_influence: 0.3,
				...(req.durationSec !== undefined ? { duration_seconds: req.durationSec } : {}),
				...(req.loop ? { loop: true } : {})
			}
		} else {
			url = `${ELEVENLABS_BASE}/v1/music?output_format=${OUTPUT_FORMAT}`
			body = {
				prompt: text, ...named, force_instrumental: req.instrumental !== false,
				...(req.durationSec !== undefined ? { music_length_ms: Math.round(req.durationSec * 1000) } : {})
			}
		}

		const res = await ctx.fetch(url, { method: 'POST', headers: headers(ctx.key), body: JSON.stringify(body), signal: ctx.signal })
		if (!res.ok) throw await failure(res)
		const bytes = Buffer.from(await res.arrayBuffer())
		if (!bytes.length) throw new ProviderError('ElevenLabs returned no audio.', res.status)

		return {
			bytes, format: 'mp3', model: model ?? 'provider default',
			costUsd: this.estimateUsd(req, ctx.catalog), costNote: ESTIMATE,
			credits: chargedCredits(res) ?? estimateCredits({ ...req, ...(model ? { model } : {}) }, ctx.catalog),
			// A rate is learned per model: with none named there is nothing to learn it for.
			measured: chargedCredits(res) !== null && !!model
		}
	}
}
