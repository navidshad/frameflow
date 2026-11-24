import { describe, expect, it } from 'vitest'
import { describeLine, formatUsd, spendParts, summarizeSpend } from './spend'
import type { UsageRecord } from './types'

const usage = { promptTokens: 10, candidatesTokens: 5, totalTokens: 15 }
const gemini = (cost: number): UsageRecord => ({ usage, cost })
const eleven = (credits?: number, cost = 0): UsageRecord => ({ usage, cost, ...(credits !== undefined ? { credits } : {}), source: 'audio:elevenlabs' })
const claude: UsageRecord = { usage, cost: 0, plan: true, source: 'engine:claude-code' }

describe('a project’s spend, per provider', () => {
	it('keeps dollars, credits and plan turns apart, never adding credits into dollars', () => {
		const s = summarizeSpend([gemini(0.04), gemini(0.0044), eleven(5), eleven(60), claude, claude, { usage, cost: 0.001, source: 'search' }])
		expect(s.usd).toBeCloseTo(0.0454, 6)
		expect(s.credits).toBe(65)
		expect(s.planTurns).toBe(2)
		expect(spendParts(s)).toEqual(['$0.0454', '65 credits', 'Claude on plan'])
		expect(s.lines.map(describeLine)).toEqual([
			'Gemini API: $0.0444 for 2 calls',
			'ElevenLabs: 65 credits for 2 generations',
			'Claude Code: 2 turns on your Claude plan, not billed here',
			'Web search (Gemini): $0.0010 for 1 call'
		])
	})

	it('reads an older ElevenLabs record by its source, and leaves its dollar guess out of the dollars', () => {
		const s = summarizeSpend([gemini(0.01), eleven(undefined, 0.0044), eleven(7)])
		expect(s.usd).toBeCloseTo(0.01, 6)
		expect(s.credits).toBe(7)
		expect(describeLine(s.lines[1])).toBe('ElevenLabs: 7 credits for 1 generation, and 1 made before credits were counted')
		const old = summarizeSpend([eleven(undefined, 0.0044)])
		expect(describeLine(old.lines[0])).toBe('ElevenLabs: 1 generation, made before credits were counted')
	})

	it('shows only the meters that were used', () => {
		expect(spendParts(summarizeSpend([claude]))).toEqual(['Claude on plan'])
		expect(spendParts(summarizeSpend([eleven(1)]))).toEqual(['1 credit'])
		// Uncounted older ones are left to the breakdown.
		expect(spendParts(summarizeSpend([eleven(undefined, 0.01)]))).toEqual([])
		expect(spendParts(summarizeSpend(undefined))).toEqual([])
		expect(spendParts(summarizeSpend([gemini(0)]))).toEqual([])
	})

	it('writes small dollar amounts with four places and larger ones with two', () => {
		expect(formatUsd(0.0882)).toBe('$0.0882')
		expect(formatUsd(12.5)).toBe('$12.50')
	})
})
