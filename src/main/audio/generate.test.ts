import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import type { MediaAsset, UsageRecord } from '../../shared/types'
import type { GenerateRequest } from '../../shared/audioProviders'
import { generatedName, generateAudioAsset, type GenerateDeps, type GenerateStore } from './generate'
import { ProviderError, type AudioProviderImpl } from './provider'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-gen-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A project that is a folder and a list: enough to see what generating leaves behind. */
function fakeStore() {
	const assets = new Map<string, MediaAsset>()
	const usage: UsageRecord[] = []
	const store: GenerateStore = {
		tempDir: (id) => (id === 'gone' ? null : dir),
		async addAsset(_t, o) {
			const a = { id: o.assetId, kind: 'audio', name: o.name, originalPath: o.sourcePath, preprocessing: {}, clips: [], createdAt: 0 } as MediaAsset
			assets.set(a.id, a)
			return a
		},
		async patchAsset(_t, id, patch) { assets.set(id, { ...assets.get(id)!, ...patch }) },
		async addUsage(_t, r) { usage.push(r) },
		getAsset: (_t, id) => assets.get(id) ?? null
	}
	return { store, assets, usage }
}

const pcm = (samples: number) => { const b = Buffer.alloc(samples * 2); b.writeInt16LE(1000, 0); return b }

const provider = (over: Partial<AudioProviderImpl> = {}): AudioProviderImpl => ({
	id: 'elevenlabs', capabilities: ['speech', 'sfx', 'music'], estimateUsd: () => null,
	async generate() { return { bytes: Buffer.from('ID3-fake-mp3'), format: 'mp3', model: 'eleven_test', costUsd: 0.04 } },
	...over
})

const req: GenerateRequest = { provider: 'elevenlabs', capability: 'speech', prompt: 'Welcome to the show.', voice: 'Rachel' }

let calls: number
let s: ReturnType<typeof fakeStore>
const deps = (impl: AudioProviderImpl | undefined, key: string | null = 'k'): GenerateDeps => ({
	providers: impl ? { elevenlabs: impl } : {}, keyFor: () => key ?? undefined, store: s.store, now: () => 1234
})

beforeEach(() => { calls = 0; s = fakeStore() })

describe('generateAudioAsset', () => {
	it('keeps what the provider made as a file, with a receipt, and charges the project for it', async () => {
		const impl = provider({ async generate() { calls++; return { bytes: Buffer.from('ID3-fake-mp3'), format: 'mp3', model: 'eleven_test', costUsd: 0.04 } } })
		const { asset, provenance } = await generateAudioAsset('t1', req, deps(impl))
		expect(calls).toBe(1)
		expect(asset.id).toMatch(/^gen-[0-9a-f]{16}$/)
		expect(asset.name).toBe('Voice-over: Welcome to the show.')
		expect(fs.readFileSync(asset.originalPath).toString()).toBe('ID3-fake-mp3')
		expect(asset.originalPath).toMatch(/generated[\\/].+\.mp3$/)
		expect(asset.preprocessState).toBe('completed')
		expect(provenance).toEqual({
			provider: 'elevenlabs', capability: 'speech', prompt: 'Welcome to the show.', voice: 'Rachel',
			model: 'eleven_test', costUsd: 0.04, madeAt: 1234
		})
		expect(asset.generated).toEqual(provenance)
		expect(s.usage).toEqual([{ usage: { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 }, cost: 0.04, timestamp: 1234, source: 'audio:elevenlabs' }])
	})

	it('wraps raw PCM into a WAV the rest of the app can read', async () => {
		const impl = provider({ async generate() { return { bytes: pcm(2400), format: 'pcm16', sampleRate: 24000, channels: 1, model: 'tts', costUsd: 0.001 } } })
		const { asset } = await generateAudioAsset('t1', { ...req, provider: 'elevenlabs' }, deps(impl))
		const wav = fs.readFileSync(asset.originalPath)
		expect(wav.subarray(0, 4).toString()).toBe('RIFF')
		expect(wav.subarray(8, 12).toString()).toBe('WAVE')
		expect(wav.readUInt32LE(24)).toBe(24000)
		expect(wav.readUInt16LE(22)).toBe(1)
		expect(wav.readUInt32LE(40)).toBe(4800)
		expect(asset.originalPath).toMatch(/\.wav$/)
	})

	it('makes each generation its own take, even for the same words', async () => {
		const a = await generateAudioAsset('t1', req, deps(provider()))
		const b = await generateAudioAsset('t1', req, deps(provider()))
		expect(a.asset.id).not.toBe(b.asset.id)
	})

	it('records no spend for a provider that bills in credits, and keeps its note', async () => {
		const impl = provider({ async generate() { return { bytes: Buffer.from('x'), format: 'mp3', model: 'm', costUsd: null, costNote: '120 credits' } } })
		const { provenance } = await generateAudioAsset('t1', req, deps(impl))
		expect(provenance.costUsd).toBeNull()
		expect(provenance.costNote).toBe('120 credits')
		expect(s.usage).toEqual([])
	})

	it('refuses a request that cannot be made before it spends anything', async () => {
		const impl = provider({ async generate() { calls++; throw new Error('should not be called') } })
		await expect(generateAudioAsset('t1', { ...req, prompt: ' ' }, deps(impl))).rejects.toMatchObject({ kind: 'input' })
		await expect(generateAudioAsset('t1', { ...req, provider: 'gemini', capability: 'sfx' }, deps(impl))).rejects.toThrow(/does not make/)
		expect(calls).toBe(0)
	})

	it('says what to do when the provider is not connected', async () => {
		const err = await generateAudioAsset('t1', req, deps(provider(), null)).catch((e) => e)
		expect(err).toBeInstanceOf(ProviderError)
		expect(err.kind).toBe('auth')
		expect(err.message).toMatch(/ElevenLabs is not connected.*its own API key.*Audio providers/)
		await expect(generateAudioAsset('t1', req, deps(undefined))).rejects.toThrow(/not available/)
	})

	it('refuses when the project is gone, and passes a provider’s own error through untouched', async () => {
		await expect(generateAudioAsset('gone', req, deps(provider()))).rejects.toThrow(/not open any more/)
		const impl = provider({ async generate() { throw new ProviderError('Quota exceeded: top up your plan.', 402, 'quota') } })
		await expect(generateAudioAsset('t1', req, deps(impl))).rejects.toMatchObject({ kind: 'quota', status: 402 })
		expect(s.assets.size).toBe(0)
	})
})

describe('generatedName', () => {
	it('shortens a long prompt and collapses its whitespace', () => {
		expect(generatedName({ ...req, prompt: 'a   door\n slamming' , capability: 'sfx' })).toBe('Sound effect: a door slamming')
		expect(generatedName({ ...req, prompt: 'x'.repeat(100) })).toMatch(/^Voice-over: x{34}…$/)
	})
})
