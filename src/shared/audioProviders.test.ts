import { describe, expect, it } from 'vitest'
import {
	DEFAULT_SPEND_POLICY, formatCost, isProviderId, LIMITS, normalizeSpendPolicy, PROVIDERS, providerInfo, requestProblem,
	spendDecision, type GenerateRequest
} from './audioProviders'

const speech = (over: Partial<GenerateRequest> = {}): GenerateRequest =>
	({ provider: 'elevenlabs', capability: 'speech', prompt: 'Welcome to the show.', ...over })

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
		expect(requestProblem(speech({ prompt: 'x'.repeat(LIMITS.speechChars.max + 1) }))).toMatch(/Split it/)
		expect(requestProblem({ provider: 'elevenlabs', capability: 'sfx', prompt: 'hi' })).toMatch(/Describe the sound/)
	})

	it('holds a sound effect and music to the lengths the providers take', () => {
		expect(requestProblem({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door slamming', durationSec: 60 })).toMatch(/0\.5 to 30 seconds/)
		expect(requestProblem({ provider: 'elevenlabs', capability: 'music', prompt: 'calm piano', durationSec: 1 })).toMatch(/3 to 120 seconds/)
		expect(requestProblem({ provider: 'elevenlabs', capability: 'sfx', prompt: 'a door slamming', durationSec: Number.NaN })).toMatch(/seconds/)
	})

	it('knows when it has not heard of a provider or a kind', () => {
		expect(requestProblem(speech({ provider: 'suno' as never }))).toMatch(/Unknown provider/)
		expect(requestProblem(speech({ capability: 'jingle' as never }))).toMatch(/Unknown kind/)
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
