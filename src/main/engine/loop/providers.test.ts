import { describe, expect, it } from 'vitest'
import { addUsage, usageFrom } from './providers'

describe('usage', () => {
	it('bills thinking apart from the answer, which the SDK counts together', () => {
		expect(usageFrom({ inputTokens: 1000, outputTokens: 300, totalTokens: 1300, outputTokenDetails: { reasoningTokens: 250 } } as any))
			.toEqual({ promptTokens: 1000, candidatesTokens: 50, thinkingTokens: 250, totalTokens: 1300, cachedTokens: 0 })
	})

	it('copes with a provider that reports nothing', () => {
		expect(usageFrom(undefined)).toEqual({ promptTokens: 0, candidatesTokens: 0, thinkingTokens: 0, totalTokens: 0, cachedTokens: 0 })
		expect(usageFrom({ inputTokens: 10, outputTokens: 5 } as any)).toEqual({ promptTokens: 10, candidatesTokens: 5, thinkingTokens: 0, totalTokens: 15, cachedTokens: 0 })
	})

	it('never reports more thinking than output', () => {
		expect(usageFrom({ inputTokens: 1, outputTokens: 5, outputTokenDetails: { reasoningTokens: 9 } } as any).candidatesTokens).toBe(0)
	})

	it('reports the prompt tokens the provider served from its cache', () => {
		expect(usageFrom({ inputTokens: 1000, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 700 } } as any).cachedTokens).toBe(700)
		// Never more than the prompt it is part of.
		expect(usageFrom({ inputTokens: 100, outputTokens: 1, inputTokenDetails: { cacheReadTokens: 900 } } as any).cachedTokens).toBe(100)
	})

	it('adds up', () => {
		const a = { promptTokens: 1, candidatesTokens: 2, thinkingTokens: 3, totalTokens: 6, cachedTokens: 1 }
		expect(addUsage(a, a)).toEqual({ promptTokens: 2, candidatesTokens: 4, thinkingTokens: 6, totalTokens: 12, cachedTokens: 2 })
	})
})
