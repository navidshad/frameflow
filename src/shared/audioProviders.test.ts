import { describe, expect, it } from 'vitest'
import {
	DEFAULT_SPEND_POLICY, estimateCredits, formatCost, isProviderId, LIMITS, normalizeSpendPolicy, PROVIDERS, providerInfo, requestProblem,
	spendDecision, type GenerateRequest
} from './audioProviders'
import { parseSpecModels, parseSpeechModels, type ModelCatalog } from './audioModels'
import spec from './__fixtures__/elevenlabs-openapi-slice.json'

const speech = (over: Partial<GenerateRequest> = {}): GenerateRequest =>
	({ provider: 'elevenlabs', capability: 'speech', prompt: 'Welcome to the show.', ...over })

/** Today's models as ElevenLabs lists them: two voice models, and the effect and music ids from the real spec. */
const CATALOG = (): ModelCatalog => ({
	provider: 'elevenlabs', fetchedAt: 1,
	models: [
		...parseSpeechModels([
			{ model_id: 'eleven_multilingual_v2', name: 'Multilingual v2', can_do_text_to_speech: true, maximum_text_length_per_request: 10000, model_rates: { character_cost_multiplier: 1 } },
			{ model_id: 'eleven_flash_v2_5', name: 'Flash v2.5', can_do_text_to_speech: true, maximum_text_length_per_request: 40000, model_rates: { character_cost_multiplier: 0.5 } }
		]),
		...parseSpecModels(spec)
	]
})

describe('the providers', () => {
	it('says what each one makes, and what it needs', () => {
		expect(providerInfo('gemini')!.capabilities).toEqual(['speech'])
		expect(providerInfo('elevenlabs')!.capabilities).toEqual(['speech', 'sfx', 'music'])
		for (const p of PROVIDERS) expect(p.needs, p.id).toMatch(/key/)
		expect(isProviderId('elevenlabs')).toBe(true)
		expect(isProviderId('suno')).toBe(false)
	})
})

describe('requestProblem', () => {
	it('lets a good request through', () => {
		expect(requestProblem(speech())).toBeNull()
		expect(requestProblem({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door slamming', durationSec: 2 })).toBeNull()
		expect(requestProblem({ provider: 'elevenlabs', capability: 'music', prompt: 'calm piano', durationSec: 30 })).toBeNull()
	})

	it('says which provider does what you asked for', () => {
		const p = requestProblem({ provider: 'gemini', capability: 'sfx', prompt: 'a door slamming' })!
		expect(p).toMatch(/Gemini voices does not make sound effect; ElevenLabs does/)
	})

	it('refuses an empty line, a line too long to speak in one go, and a thin description', () => {
		expect(requestProblem(speech({ prompt: '   ' }))).toMatch(/Say what/)
		expect(requestProblem(speech({ provider: 'gemini', prompt: 'x'.repeat(LIMITS.speechChars.max + 1) }))).toMatch(/Split it/)
		expect(requestProblem({ provider: 'elevenlabs', capability: 'sfx', prompt: 'hi' })).toMatch(/Describe the sound/)
	})

	it('holds a sound effect and music to the lengths the providers take', () => {
		expect(requestProblem({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door slamming', durationSec: 60 })).toMatch(/0\.5 to 30 seconds/)
		expect(requestProblem({ provider: 'elevenlabs', capability: 'music', prompt: 'calm piano', durationSec: 1 })).toMatch(/3 to 300 seconds/)
		expect(requestProblem({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door slamming', durationSec: Number.NaN })).toMatch(/seconds/)
	})

	it('holds a line to what its model reads in one go, as the provider’s list says', () => {
		const c = CATALOG()
		expect(requestProblem(speech({ prompt: 'x'.repeat(10_000), model: 'eleven_multilingual_v2' }), c)).toBeNull()
		expect(requestProblem(speech({ prompt: 'x'.repeat(10_001), model: 'eleven_multilingual_v2' }), c)).toMatch(/at most 10000 with this model/)
		expect(requestProblem(speech({ prompt: 'x'.repeat(20_000), model: 'eleven_flash_v2_5' }), c)).toBeNull()
		// With no list at all, only the general bound applies.
		expect(requestProblem(speech({ prompt: 'x'.repeat(LIMITS.speechChars.max + 1) }))).toMatch(/Split it/)
	})

	it('names today’s models when asked for one that does not exist, and lets a retiring one through', () => {
		const c = CATALOG()
		expect(requestProblem(speech({ model: 'eleven_turbo_v2' }), c)).toMatch(/no voice-over model "eleven_turbo_v2". Models: eleven_multilingual_v2, eleven_flash_v2_5/)
		// Still served until its removal date: the agent saw it marked retiring and chose it.
		expect(requestProblem({ provider: 'elevenlabs', capability: 'music', prompt: 'calm piano', model: 'music_v1' }, c)).toBeNull()
		expect(requestProblem(speech({ model: 'eleven_flash_v2_5' }), c)).toBeNull()
		// Without a list there is nothing to check a model against: the provider decides.
		expect(requestProblem(speech({ model: 'anything' }))).toBeNull()
	})

	it('knows when it has not heard of a provider or a kind', () => {
		expect(requestProblem(speech({ provider: 'suno' as never }))).toMatch(/Unknown provider/)
		expect(requestProblem(speech({ capability: 'jingle' as never }))).toMatch(/Unknown kind/)
	})
})

describe('estimateCredits', () => {
	it('knows nothing until a call has taught it the rate', () => {
		expect(estimateCredits(speech({ prompt: 'x'.repeat(100), model: 'eleven_multilingual_v2' }), CATALOG())).toBeNull()
		expect(estimateCredits(speech({ prompt: 'Hello there.' }))).toBeNull()
	})

	it('counts speech by the character and effects by the second, at the rates calls were seen to cost', () => {
		const c = { ...CATALOG(), rates: { eleven_multilingual_v2: 0.4, eleven_text_to_sound_v3: 10 } }
		expect(estimateCredits(speech({ prompt: 'x'.repeat(100), model: 'eleven_multilingual_v2' }), c)).toBe(40)
		expect(estimateCredits({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door', durationSec: 2, model: 'eleven_text_to_sound_v3' }, c)).toBe(20)
		// A provider-chosen length is assumed to be five seconds.
		expect(estimateCredits({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door', model: 'eleven_text_to_sound_v3' }, c)).toBe(50)
	})

	it('prices a voice model never used from one that was, through the relative cost the provider lists', () => {
		// Multilingual (×1) was seen at 0.4 a character, so Flash (×0.5) is 0.2.
		const c = { ...CATALOG(), rates: { eleven_multilingual_v2: 0.4 } }
		expect(estimateCredits(speech({ prompt: 'x'.repeat(100), model: 'eleven_flash_v2_5' }), c)).toBe(20)
	})
})

describe('the spend policy', () => {
	it('reads settings that are missing or wrong as the default, and clamps the rest', () => {
		expect(normalizeSpendPolicy(undefined)).toEqual(DEFAULT_SPEND_POLICY)
		expect(normalizeSpendPolicy({ maxGenerationsPerTurn: 'lots', maxUsdPerTurn: 'free' })).toEqual(DEFAULT_SPEND_POLICY)
		expect(normalizeSpendPolicy({ maxGenerationsPerTurn: 500, maxUsdPerTurn: -3 })).toEqual({ maxGenerationsPerTurn: 50, maxUsdPerTurn: 0 })
		expect(normalizeSpendPolicy({ maxGenerationsPerTurn: 2, maxUsdPerTurn: null })).toEqual({ maxGenerationsPerTurn: 2, maxUsdPerTurn: null })
	})

	it('stops at the count, and says where to change it', () => {
		const d = spendDecision({ maxGenerationsPerTurn: 2, maxUsdPerTurn: 1 }, { count: 2, usd: 0 }, 0.01)
		expect(d.ok).toBe(false)
		if (!d.ok) expect(d.reason).toMatch(/2 generations per turn.*Audio providers/)
		expect(spendDecision({ maxGenerationsPerTurn: 1, maxUsdPerTurn: 1 }, { count: 0, usd: 0 }, 0.01).ok).toBe(true)
		expect(spendDecision({ maxGenerationsPerTurn: 0, maxUsdPerTurn: 1 }, { count: 0, usd: 0 }, 0).ok).toBe(false)
	})

	it('stops at the dollars, counting what is already spent', () => {
		const policy = { maxGenerationsPerTurn: 5, maxUsdPerTurn: 0.5 }
		expect(spendDecision(policy, { count: 1, usd: 0.3 }, 0.15).ok).toBe(true)
		const over = spendDecision(policy, { count: 1, usd: 0.3 }, 0.25)
		expect(over.ok).toBe(false)
		if (!over.ok) expect(over.reason).toMatch(/\$0\.55.*\$0\.50/)
	})

	it('cannot price a credit-billed request, so only the count guards it', () => {
		expect(spendDecision({ maxGenerationsPerTurn: 3, maxUsdPerTurn: 0 }, { count: 0, usd: 0 }, null).ok).toBe(true)
	})

	it('has no dollar cap when it is null', () => {
		expect(spendDecision({ maxGenerationsPerTurn: 3, maxUsdPerTurn: null }, { count: 0, usd: 99 }, 99).ok).toBe(true)
	})
})

describe('formatCost', () => {
	it('shows the money, a floor under a cent, or the provider’s own words', () => {
		expect(formatCost({ costUsd: 0.042 })).toBe('$0.04')
		expect(formatCost({ costUsd: 0.001 })).toBe('under a cent')
		expect(formatCost({ costUsd: null, costNote: '120 credits' })).toBe('120 credits')
		expect(formatCost({ costUsd: null })).toBe('cost not reported')
	})
})
