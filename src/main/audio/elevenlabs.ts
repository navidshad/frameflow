import type { GenerateRequest } from '../../shared/audioProviders'
import { ProviderError, type AudioProviderImpl, type ProviderContext, type ProviderOutput, type Voice } from './provider'

/**
 * ElevenLabs: voices, sound effects from a prompt, and music.
 *
 * Request shapes are from the official API reference (elevenlabs.io/docs/api-reference),
 * read on 2026-10-21: auth is the `xi-api-key` header; the output format is the
 * `output_format` query parameter; text-to-speech is `POST /v1/text-to-speech/{voice_id}`,
 * sound effects `POST /v1/sound-generation`, music `POST /v1/music`, voices
 * `GET /v2/voices`. Each returns the audio file as the response body.
 *
 * Prices are the API pricing page's list prices in USD (per 1K characters for
 * speech, per minute for effects and music). The page contradicts itself about
 * whether effects and music bill per minute or per generation, so a cost here is
 * an ESTIMATE and is labelled as one: the spend cap and the receipt both say so.
 */

export const ELEVENLABS_BASE = 'https://api.elevenlabs.io'
export const SPEECH_MODEL = 'eleven_multilingual_v2'
export const SFX_MODEL = 'eleven_text_to_sound_v2'
export const MUSIC_MODEL = 'music_v1'
const OUTPUT_FORMAT = 'mp3_44100_128'

const SPEECH_USD_PER_1K_CHARS = 0.08
const SFX_USD_PER_MIN = 0.12
const MUSIC_USD_PER_MIN = 0.15
/** What a sound effect costs when the provider picks its length: five seconds is a fair guess. */
const SFX_DEFAULT_SEC = 5
const MUSIC_DEFAULT_SEC = 30

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

async function listVoices(ctx: ProviderContext): Promise<Voice[]> {
	const res = await ctx.fetch(`${ELEVENLABS_BASE}/v2/voices?page_size=100`, { headers: headers(ctx.key, false), signal: ctx.signal })
	if (!res.ok) throw await failure(res)
	const body = await res.json() as { voices?: { voice_id: string; name: string; preview_url?: string; description?: string; labels?: Record<string, string> }[] }
	return (body.voices ?? []).map((v) => ({
		id: v.voice_id, name: v.name, previewUrl: v.preview_url,
		description: v.description || (v.labels ? Object.values(v.labels).filter(Boolean).join(', ') : undefined)
	}))
}

export const elevenlabs: AudioProviderImpl = {
	id: 'elevenlabs',
	capabilities: ['speech', 'sfx', 'music'],

	estimateUsd(req: GenerateRequest) {
		if (req.capability === 'speech') return round4((req.prompt.trim().length / 1000) * SPEECH_USD_PER_1K_CHARS)
		if (req.capability === 'sfx') return round4(((req.durationSec ?? SFX_DEFAULT_SEC) / 60) * SFX_USD_PER_MIN)
		return round4(((req.durationSec ?? MUSIC_DEFAULT_SEC) / 60) * MUSIC_USD_PER_MIN)
	},

	voices: listVoices,

	async generate(req, ctx): Promise<ProviderOutput> {
		const text = req.prompt.trim()
		let url: string
		let body: Record<string, unknown>
		let model: string

		if (req.capability === 'speech') {
			// A voice is required by the endpoint. Asked for none, use the first one the account has.
			let voice = req.voice
			if (!voice) {
				const voices = await listVoices(ctx)
				if (!voices.length) throw new ProviderError('ElevenLabs has no voices on this account to read with.', undefined, 'input')
				voice = voices[0].id
			}
			model = SPEECH_MODEL
			url = `${ELEVENLABS_BASE}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${OUTPUT_FORMAT}`
			body = { text, model_id: model }
		} else if (req.capability === 'sfx') {
			model = SFX_MODEL
			url = `${ELEVENLABS_BASE}/v1/sound-generation?output_format=${OUTPUT_FORMAT}`
			body = { text, model_id: model, prompt_influence: 0.3, ...(req.durationSec !== undefined ? { duration_seconds: req.durationSec } : {}) }
		} else {
			model = MUSIC_MODEL
			url = `${ELEVENLABS_BASE}/v1/music?output_format=${OUTPUT_FORMAT}`
			body = {
				prompt: text, model_id: model, force_instrumental: true,
				...(req.durationSec !== undefined ? { music_length_ms: Math.round(req.durationSec * 1000) } : {})
			}
		}

		const res = await ctx.fetch(url, { method: 'POST', headers: headers(ctx.key), body: JSON.stringify(body), signal: ctx.signal })
		if (!res.ok) throw await failure(res)
		const bytes = Buffer.from(await res.arrayBuffer())
		if (!bytes.length) throw new ProviderError('ElevenLabs returned no audio.', res.status)

		// `character-cost` is the one billing header the docs mention (on speech); the
		// rest is the list price, so say it is an estimate.
		return {
			bytes, format: 'mp3', model,
			costUsd: this.estimateUsd(req), costNote: ESTIMATE
		}
	}
}
