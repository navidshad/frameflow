import { describe, expect, it } from 'vitest'
import { elevenlabs } from './elevenlabs'
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

describe('ElevenLabs', () => {
	it('reads a line with the chosen voice: the documented endpoint, header and body', async () => {
		const { f, seen } = fakeFetch(audio())
		const out = await elevenlabs.generate({ provider: 'elevenlabs', capability: 'speech', prompt: ' Hello there. ', voice: 'v123' }, { fetch: f, key: 'sk_x' })
		expect(seen[0].url).toBe('https://api.elevenlabs.io/v1/text-to-speech/v123?output_format=mp3_44100_128')
		expect((seen[0].init.headers as Record<string, string>)['xi-api-key']).toBe('sk_x')
		expect(seen[0].init.method).toBe('POST')
		expect(seen[0].body).toEqual({ text: 'Hello there.', model_id: 'eleven_multilingual_v2' })
		expect(out.format).toBe('mp3')
		expect(out.bytes.toString()).toBe('MP3DATA')
		// 12 characters at $0.08 per 1K characters, labelled as an estimate.
		expect(out.costUsd).toBeCloseTo(0.001, 3)
		expect(out.costNote).toMatch(/estimated/)
	})

	it('takes the account’s first voice when none is named', async () => {
		const { f, seen } = fakeFetch(json({ voices: [{ voice_id: 'first', name: 'Rachel' }, { voice_id: 'second', name: 'Adam' }] }), audio())
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'speech', prompt: 'Hello there.' }, { fetch: f, key: 'k' })
		expect(seen[0].url).toBe('https://api.elevenlabs.io/v2/voices?page_size=100')
		expect(seen[1].url).toContain('/v1/text-to-speech/first?')
	})

	it('describes a sound effect, with its length when it has one', async () => {
		const { f, seen } = fakeFetch(audio(), audio())
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a heavy door slamming', durationSec: 2 }, { fetch: f, key: 'k' })
		expect(seen[0].url).toBe('https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128')
		expect(seen[0].body).toEqual({ text: 'a heavy door slamming', model_id: 'eleven_text_to_sound_v2', prompt_influence: 0.3, duration_seconds: 2 })
		await elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'wind in trees' }, { fetch: f, key: 'k' })
		expect(seen[1].body.duration_seconds).toBeUndefined()
	})

	it('asks for instrumental music, in milliseconds', async () => {
		const { f, seen } = fakeFetch(audio())
		const out = await elevenlabs.generate({ provider: 'elevenlabs', capability: 'music', prompt: 'calm piano', durationSec: 30 }, { fetch: f, key: 'k' })
		expect(seen[0].url).toBe('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128')
		expect(seen[0].body).toEqual({ prompt: 'calm piano', model_id: 'music_v1', force_instrumental: true, music_length_ms: 30000 })
		expect(out.costUsd).toBeCloseTo(0.075, 4) // half a minute at $0.15
	})

	it('prices a request before it is made, for the spend cap', () => {
		expect(elevenlabs.estimateUsd({ provider: 'elevenlabs', capability: 'speech', prompt: 'x'.repeat(1000) })).toBeCloseTo(0.08)
		expect(elevenlabs.estimateUsd({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door', durationSec: 30 })).toBeCloseTo(0.06)
		expect(elevenlabs.estimateUsd({ provider: 'elevenlabs', capability: 'music', prompt: 'calm', durationSec: 60 })).toBeCloseTo(0.15)
	})

	it('lists voices with what it says about each', async () => {
		const { f } = fakeFetch(json({ voices: [{ voice_id: 'a', name: 'Rachel', preview_url: 'https://x/p.mp3', labels: { accent: 'american', gender: 'female' } }] }))
		const voices = await elevenlabs.voices!({ fetch: f, key: 'k' })
		expect(voices).toEqual([{ id: 'a', name: 'Rachel', previewUrl: 'https://x/p.mp3', description: 'american, female' }])
	})

	it.each([
		[401, { detail: { code: 'invalid_api_key', message: 'Invalid API key' } }, 'auth', /did not accept the API key: Invalid API key.*Audio providers/],
		[402, { detail: { code: 'insufficient_credits', message: 'Out of credits' } }, 'quota', /out of credits: Out of credits/],
		[429, { detail: { code: 'rate_limit_exceeded', message: 'Slow down' } }, 'rate', /rate limiting/],
		[422, { detail: [{ loc: ['body', 'text'], msg: 'field required', type: 'missing' }] }, 'input', /could not use that request: field required/],
		[403, { detail: { code: 'subscription_required', message: 'Upgrade' } }, 'auth', /paid plan/],
		[500, { detail: { message: 'oops' } }, 'other', /had a problem \(500\)/]
	])('turns a %i into one sentence for the person', async (status, body, kind, message) => {
		const { f } = fakeFetch(json(body, status as number))
		const err = await elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door slamming' }, { fetch: f, key: 'k' }).catch((e) => e)
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
		await expect(elevenlabs.generate({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door slamming' }, { fetch: f, key: 'k' })).rejects.toThrow(/no audio/)
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
