import { describe, expect, it } from 'vitest'
import { billablePromptTokens, CACHED_INPUT_RATIO } from './usage'

describe('billablePromptTokens', () => {
	it('is the prompt itself when nothing was cached', () => {
		expect(billablePromptTokens({ promptTokens: 1000 })).toBe(1000)
		expect(billablePromptTokens({ promptTokens: 1000, cachedTokens: 0 })).toBe(1000)
	})

	it('bills cached tokens at a tenth', () => {
		expect(CACHED_INPUT_RATIO).toBe(0.1)
		// 800 cached count as 80, 200 fresh count in full.
		expect(billablePromptTokens({ promptTokens: 1000, cachedTokens: 800 })).toBeCloseTo(280)
	})

	it('cannot discount more than the prompt, or by a negative number', () => {
		expect(billablePromptTokens({ promptTokens: 100, cachedTokens: 500 })).toBeCloseTo(10)
		expect(billablePromptTokens({ promptTokens: 100, cachedTokens: -5 })).toBe(100)
	})
})
