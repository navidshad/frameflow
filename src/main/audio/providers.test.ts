import { describe, expect, it } from 'vitest'
import { chargedCredits, elevenlabs, fetchCatalog } from './elevenlabs'
import { parseSpecModels, parseSpeechModels, type ModelCatalog } from '../../shared/audioModels'
import spec from '../../shared/__fixtures__/elevenlabs-openapi-slice.json'
import { gemini, GEMINI_VOICES, ttsPricing } from './gemini'
import { ProviderError } from './provider'

/** A fetch that records what it was asked and answers with what it is given. */
function fakeFetch(...replies: (Response | ((url: string, init: RequestInit) => Response))[]) {
	const seen: { url: string; init: RequestInit; body: any }[] = []
	const f = (async (url: string, init: RequestInit = {}) => {
		seen.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined })
		const next = replies.shift()
		if (!next) throw new Error('unexpected request: ' + url)
		return typeof next === 'function' ? next(url, init) : next
	}) as unknown as typeof fetch
	return { f, seen }
}
const audio = (bytes = 'MP3DATA') => new Response(Buffer.from(bytes), { status: 200 })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Today's models: two voice models, and the effect and music ids from ElevenLabs' real spec (music_v1 deprecated). */
const SPEECH_MODELS = [
	{ model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true, maximum_text_length_per_request: 10000, model_rates: { character_cost_multiplier: 1 } },
	{ model_id: 'eleven_flash_v2_5', name: 'Flash v2.5', can_do_text_to_speech: true, maximum_text_length_per_request: 40000, model_rates: { character_cost_multiplier: 0.5 } }
]
const CATALOG = (): ModelCatalog => ({ provider: 'elevenlabs', fetchedAt: 1, models: [...parseSpeechModels(SPEECH_MODELS), ...parseSpecModels(spec)] })
const withList = (f: typeof fetch) => ({ fetch: f, key: 'k', catalog: CATALOG() })

describe('ElevenLabs', () => {
	it('reads a line with the chosen voice and model: the documented endpoint, header and body', async () => {
		const { f, seen } = fakeFetch(audio())
		const out = await elevenlabs.generate({ provider: 'elevenlabs', capability: 'speech', prompt: ' Hello there. ', voice: 'v123', model: 'eleven_flash_v2_5' }, { ...withList(f), key: 'sk_x' })
		expect(seen[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/v123?output_format=mp3_44100_128')
		expect((seen[0].init.headers as Record<string, string>)['xi-api-key']).toBe('sk_x')
		expect(seen[0].init.method).toBe('POST')
		expect(seen[0].body).toEqual({ text: 'Hello there.', model_id: 'eleven_flash_v2_5' })
		expect(out.format).toBe('mp3')
		expect(out.model).toBe('eleven_flash_v2_5')
		expect(out.bytes.toString()).toBe('MP3DATA')
		expect(out.costNote).toMatch(/estimated/)
	})

	it('names a model from today’s list when none is asked for, and never a deprecated one', async () => {
		const { f, seen } = fakeFetch(audio(), audio(), audio())
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'speech', prompt: 'Hi.', voice: 'v' }, withList(f))
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door' }, withList(f))
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'music', prompt: 'calm piano' }, withList(f))
		const listed = CATALOG().models.filter((m) => !m.deprecated).map((m) => m.id)
		for (const s of seen) expect(listed).toContain(s.body.model_id)
		expect(seen.map((s) => s.body.model_id)).not.toContain('music_v1')
	})

	it('leaves the model to the API only when there is no list at all, and learns no rate from it', async () => {
		const charged = new Response(Buffer.from('MP3'), { status: 200, headers: { 'character-cost': '10' } })
		const { f, seen } = fakeFetch(charged)
		const out = await elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door' }, { fetch: f, key: 'k' })
		expect(seen[0].body.model_id).toBeUndefined()
		expect(out).toMatchObject({ model: 'provider default', credits: 10, measured: false })
	})

	it('reads with a stock voice when none is named, never the person’s own clone', async () => {
		const { f, seen } = fakeFetch(json({ voices: [
			{ voice_id: 'mine', name: 'Me', category: 'cloned' },
			{ voice_id: 'stock', name: 'Rachel', category: 'premade' }
		] }), audio())
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'speech', prompt: 'Hello there.' }, withList(f))
		expect(seen[0].url).toBe('https://api.elevenlabs.io/v2/voices?page_size=100')
		expect(seen[1].url).toContain('/v1/text-to-speech/stock?')
	})

	it('describes a sound effect, with its length when it has one, and a loop when asked', async () => {
		const { f, seen } = fakeFetch(audio(), audio(), audio())
		const v3 = 'eleven_text_to_sound_v3'
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a heavy door slamming', durationSec: 2, model: v3 }, withList(f))
		expect(seen[0].url).toBe('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128')
		expect(seen[0].body).toEqual({ text: 'a heavy door slamming', model_id: v3, prompt_influence: 0.3, duration_seconds: 2 })
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'wind in trees', model: v3 }, withList(f))
		expect(seen[1].body.duration_seconds).toBeUndefined()
		expect(seen[1].body.loop).toBeUndefined()
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'rain on a tin roof', durationSec: 10, loop: true, model: v3 }, withList(f))
		expect(seen[2].body.loop).toBe(true)
	})

	it('asks for instrumental music in milliseconds, and sung music when asked', async () => {
		const { f, seen } = fakeFetch(audio(), audio())
		const out = await elevenlabs.generate({ provider: 'elevenlabs', capability: 'music', prompt: 'calm piano', durationSec: 30, model: 'music_v2_5' }, withList(f))
		expect(seen[0].url).toBe('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128')
		expect(seen[0].body).toEqual({ prompt: 'calm piano', model_id: 'music_v2_5', force_instrumental: true, music_length_ms: 30000 })
		expect(out.costUsd).toBeCloseTo(0.075, 4) // half a minute at $0.15
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'music', prompt: 'a folk song about the sea', durationSec: 20, instrumental: false, model: 'music_v2' }, withList(f))
		expect(seen[1].body).toMatchObject({ model_id: 'music_v2', force_instrumental: false, music_length_ms: 20000 })
	})

	it('prices a request before it is made, for the spend cap; a cheaper model by the provider’s own ratio', () => {
		const c = CATALOG()
		expect(elevenlabs.estimateUsd({ provider: 'elevenlabs', capability: 'speech', prompt: 'x'.repeat(1000), model: 'eleven_multilingual_v2' }, c)).toBeCloseTo(0.08)
		expect(elevenlabs.estimateUsd({ provider: 'elevenlabs', capability: 'speech', prompt: 'x'.repeat(1000), model: 'eleven_flash_v2_5' }, c)).toBeCloseTo(0.04)
		expect(elevenlabs.estimateUsd({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door', durationSec: 30 })).toBeCloseTo(0.06)
		expect(elevenlabs.estimateUsd({ provider: 'elevenlabs', capability: 'music', prompt: 'calm', durationSec: 60 })).toBeCloseTo(0.15)
	})

	it('reports the credits a call used from the reply’s own count, and says when it is only an estimate', async () => {
		const charged = new Response(Buffer.from('MP3'), { status: 200, headers: { 'character-cost': '37' } })
		const { f } = fakeFetch(charged, audio())
		const said = await elevenlabs.generate({ provider: 'elevenlabs', capability: 'speech', prompt: 'x'.repeat(200), voice: 'v', model: 'eleven_flash_v2_5' }, withList(f))
		expect(said).toMatchObject({ credits: 37, measured: true })
		// Music replies carry no count; with a rate learned earlier, the estimate stands in.
		const learned = { ...CATALOG(), rates: { music_v2_5: 12 } }
		const guessed = await elevenlabs.generate({ provider: 'elevenlabs', capability: 'music', prompt: 'calm piano', durationSec: 10, model: 'music_v2_5' }, { fetch: f, key: 'k', catalog: learned })
		expect(guessed).toMatchObject({ credits: 120, measured: false })
	})

	it('reads the count only when it is a number', () => {
		const h = (v?: string) => ({ headers: new Headers(v === undefined ? {} : { 'character-cost': v }) })
		expect(chargedCredits(h('20'))).toBe(20)
		expect(chargedCredits(h())).toBeNull()
		expect(chargedCredits(h('lots'))).toBeNull()
		expect(chargedCredits(h('-3'))).toBeNull()
	})

	it('lists every voice, the person’s own first, with whose it is', async () => {
		const { f, seen } = fakeFetch(
			json({ voices: [
				{ voice_id: 'a', name: 'Rachel', category: 'premade', preview_url: 'https://x/p.mp3', labels: { accent: 'american', gender: 'female' } },
				{ voice_id: 'b', name: 'Zed', category: 'cloned', labels: { language: 'fa' } }
			], has_more: true, next_page_token: 'tok 2' }),
			json({ voices: [{ voice_id: 'c', name: 'Narrator', category: 'generated', description: 'warm and slow' }], has_more: false })
		)
		const voices = await elevenlabs.voices!({ fetch: f, key: 'k' })
		expect(seen[1].url).toBe('https://api.elevenlabs.io/v2/voices?page_size=100&next_page_token=tok+2')
		expect(voices).toEqual([
			{ id: 'c', name: 'Narrator', description: 'warm and slow', kind: 'designed' },
			{ id: 'b', name: 'Zed', kind: 'cloned', language: 'fa' },
			{ id: 'a', name: 'Rachel', previewUrl: 'https://x/p.mp3', description: 'american, female', kind: 'premade' }
		])
	})

	it('reads what the account has left this month', async () => {
		const { f, seen } = fakeFetch(json({ tier: 'starter', character_count: 183, character_limit: 36784, next_character_count_reset_unix: 1796924787 }))
		const acct = await elevenlabs.account!({ fetch: f, key: 'k' })
		expect(seen[0].url).toBe('https://api.elevenlabs.io/v1/user/subscription')
		expect(acct).toEqual({ provider: 'elevenlabs', tier: 'starter', creditsUsed: 183, creditsLimit: 36784, resetsAt: 1796924787000 })
	})

	it.each([
		[401, { detail: { code: 'invalid_api_key', message: 'Invalid API key' } }, 'auth', /did not accept the API key: Invalid API key.*Audio providers/],
		[402, { detail: { code: 'insufficient_credits', message: 'Out of credits' } }, 'quota', /out of credits: Out of credits/],
		[429, { detail: { code: 'rate_limit_exceeded', message: 'Slow down' } }, 'rate', /rate limiting/],
		[422, { detail: [{ loc: ['body', 'text'], msg: 'field required', type: 'missing' }] }, 'input', /could not use that request: field required/],
		// The reply a real call with an unknown model gave, 2026-11-24.
		[400, { detail: { status: 'model_not_found', message: 'A model with model ID no_such_model does not exist ...' } }, 'input', /does not exist/],
		[403, { detail: { code: 'subscription_required', message: 'Upgrade' } }, 'auth', /paid plan/],
		[500, { detail: { message: 'oops' } }, 'other', /had a problem \(500\)/]
	])('turns a %i into one sentence for the person', async (status, body, kind, message) => {
		const { f } = fakeFetch(json(body, status as number))
		const err = await elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door slamming' }, withList(f)).catch((e) => e)
		expect(err).toBeInstanceOf(ProviderError)
		expect(err.kind).toBe(kind)
		expect(err.message).toMatch(message as RegExp)
		expect(err.status).toBe(status)
	})

	it('does not leak the key into an error', async () => {
		const { f } = fakeFetch(json({ detail: { message: 'bad' } }, 401))
		const err = await elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door slamming' }, { fetch: f, key: 'sk_SECRET' }).catch((e) => e)
		expect(err.message).not.toContain('sk_SECRET')
	})

	it('says so when it gets nothing back', async () => {
		const { f } = fakeFetch(new Response(Buffer.alloc(0), { status: 200 }))
		await expect(elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door slamming' }, withList(f))).rejects.toThrow(/no audio/)
	})
})

describe('ElevenLabs’ model list', () => {
	const MISSING_PERMISSION = { detail: { type: 'authentication_error', code: 'unauthorized', message: 'The API key you used is missing the permission models_read to execute this operation.', status: 'missing_permissions' } }

	it('asks the model list and the spec, and keeps the rates learned before', async () => {
		const { f, seen } = fakeFetch(json(SPEECH_MODELS), json(spec))
		const prior: ModelCatalog = { provider: 'elevenlabs', fetchedAt: 1, models: [], rates: { eleven_flash_v2_5: 0.2 } }
		const c = await fetchCatalog({ fetch: f, key: 'k' }, prior, 5000)
		expect(seen.map((s) => s.url)).toEqual(['https://api.elevenlabs.io/v1/models', 'https://api.elevenlabs.io/openapi.json'])
		expect((seen[0].init.headers as Record<string, string>)['xi-api-key']).toBe('k')
		// The spec is public: the key is not sent to it.
		expect(seen[1].init.headers).toBeUndefined()
		expect(c.models.map((m) => `${m.capability}:${m.id}`)).toEqual([
			'speech:eleven_multilingual_v2', 'speech:eleven_flash_v2_5',
			'sfx:eleven_text_to_sound_v2', 'sfx:eleven_text_to_sound_v3',
			'music:music_v1', 'music:music_v2', 'music:music_v2_5'
		])
		expect(c).toMatchObject({ fetchedAt: 5000, rates: { eleven_flash_v2_5: 0.2 } })
		expect(c.gaps).toBeUndefined()
	})

	it('keeps the voice models it knew when the key may not list them, and says how to fix it', async () => {
		const { f } = fakeFetch(json(MISSING_PERMISSION, 401), json(spec))
		const prior: ModelCatalog = { provider: 'elevenlabs', fetchedAt: 1, models: parseSpeechModels(SPEECH_MODELS) }
		const c = await fetchCatalog({ fetch: f, key: 'k' }, prior)
		expect(c.models.filter((m) => m.capability === 'speech').map((m) => m.id)).toEqual(['eleven_multilingual_v2', 'eleven_flash_v2_5'])
		expect(c.models.filter((m) => m.capability === 'music')).toHaveLength(3)
		expect(c.gaps).toEqual(['Voice models: the API key needs the "Models: read" permission (ElevenLabs → Developers → API keys).'])
	})

	it('keeps the effect and music models it knew when the spec cannot be read', async () => {
		const { f } = fakeFetch(json(SPEECH_MODELS), new Response('<html>busy</html>', { status: 503 }))
		const prior: ModelCatalog = { provider: 'elevenlabs', fetchedAt: 1, models: parseSpecModels(spec) }
		const c = await fetchCatalog({ fetch: f, key: 'k' }, prior)
		expect(c.models.map((m) => m.capability)).toEqual(['speech', 'speech', 'sfx', 'sfx', 'music', 'music', 'music'])
		expect(c.gaps![0]).toMatch(/spec answered 503/)
	})

	it('fails only when neither source answered, so the list known before stays', async () => {
		const { f } = fakeFetch(json(MISSING_PERMISSION, 401), () => { throw new Error('offline') })
		await expect(fetchCatalog({ fetch: f, key: 'k' }, null)).rejects.toThrow(/Models: read.*offline/)
	})
})

// ===== Gemini =====

const pcmBase64 = (samples: number) => Buffer.alloc(samples * 2, 1).toString('base64')
const reply = (data: string, mimeType: string, usage?: { promptTokenCount: number; candidatesTokenCount: number }) =>
	json({ candidates: [{ content: { parts: [{ inlineData: { data, mimeType } }] } }], usageMetadata: usage })

describe('Gemini voices', () => {
	it('asks for audio with a prebuilt voice: the documented request over REST', async () => {
		const { f, seen } = fakeFetch(reply(pcmBase64(24000), 'audio/L16;codec=pcm;rate=24000'))
		await gemini.generate({ provider: 'gemini', capability: 'speech', prompt: 'Hello there.', voice: 'Puck' }, { fetch: f, key: 'AIza' })
		expect(seen[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent')
		expect((seen[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza')
		expect(seen[0].body).toEqual({
			contents: [{ parts: [{ text: 'Hello there.' }] }],
			generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } } }
		})
	})

	it('wraps headerless PCM at the rate it is given, and leaves a finished WAV alone', async () => {
		const raw = fakeFetch(reply(pcmBase64(24000), 'audio/L16;codec=pcm;rate=16000'))
		const a = await gemini.generate({ provider: 'gemini', capability: 'speech', prompt: 'Hi there.' }, { fetch: raw.f, key: 'k' })
		expect(a).toMatchObject({ format: 'pcm16', sampleRate: 16000, channels: 1 })

		const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(44, 0), Buffer.alloc(48000, 1)]).toString('base64')
		const full = fakeFetch(reply(wav, 'audio/wav'))
		const b = await gemini.generate({ provider: 'gemini', capability: 'speech', prompt: 'Hi there.' }, { fetch: full.f, key: 'k' })
		expect(b.format).toBe('wav')
	})

	it('falls back to the next model when one is not there', async () => {
		const { f, seen } = fakeFetch(json({ error: { message: 'not found' } }, 404), reply(pcmBase64(100), 'audio/L16;rate=24000'))
		const out = await gemini.generate({ provider: 'gemini', capability: 'speech', prompt: 'Hi there.' }, { fetch: f, key: 'k' })
		expect(seen.map((s) => s.url.split('/models/')[1])).toEqual(['gemini-3.8-flash-tts:generateContent', 'gemini-3.1-flash-tts-preview:generateContent'])
		expect(out.model).toBe('gemini-3.1-flash-tts-preview')
	})

	it('says so when every model is missing', async () => {
		const { f } = fakeFetch(json({}, 404), json({}, 404), json({}, 404))
		await expect(gemini.generate({ provider: 'gemini', capability: 'speech', prompt: 'Hi there.' }, { fetch: f, key: 'k' })).rejects.toThrow(/no model/)
	})

	it('prices from the tokens it is told it used', async () => {
		const { f } = fakeFetch(reply(pcmBase64(24000), 'audio/L16;rate=24000', { promptTokenCount: 10, candidatesTokenCount: 250 }))
		const out = await gemini.generate({ provider: 'gemini', capability: 'speech', prompt: 'Hi there.' }, { fetch: f, key: 'k' })
		// 10 text tokens at $0.50 and 250 audio tokens at $9.00 per million.
		expect(out.costUsd).toBeCloseTo((10 * 0.5 + 250 * 9) / 1e6, 8)
	})

	it('prices from the length when it is not told, and the page’s price rise is dated', async () => {
		const { f } = fakeFetch(reply(pcmBase64(48000), 'audio/L16;rate=24000'))
		const out = await gemini.generate({ provider: 'gemini', capability: 'speech', prompt: 'Hi there.' }, { fetch: f, key: 'k' })
		expect(out.costUsd).toBeGreaterThan(0) // 2 s of audio, 50 tokens
		expect(ttsPricing('gemini-3.8-flash-tts', new Date('2026-12-31'))).toEqual({ input: 0.5, output: 9 })
		expect(ttsPricing('gemini-3.8-flash-tts', new Date('2027-01-01'))).toEqual({ input: 1, output: 18 })
	})

	it('calls a bad key a bad key, even though Gemini says 400', async () => {
		const { f } = fakeFetch(json({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 400))
		const err = await gemini.generate({ provider: 'gemini', capability: 'speech', prompt: 'Hi there.' }, { fetch: f, key: 'bad' }).catch((e) => e)
		expect(err.kind).toBe('auth')
		expect(err.message).toMatch(/did not accept the API key/)
	})

	it('offers the thirty prebuilt voices, and Kore when none is chosen', async () => {
		expect(GEMINI_VOICES).toHaveLength(30)
		expect((await gemini.voices!({ fetch: fetch, key: '' })).map((v) => v.name)).toEqual(GEMINI_VOICES)
		const { f, seen } = fakeFetch(reply(pcmBase64(10), 'audio/L16;rate=24000'))
		await gemini.generate({ provider: 'gemini', capability: 'speech', prompt: 'Hi there.', voice: 'Nobody' }, { fetch: f, key: 'k' })
		expect(seen[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore')
	})
})
