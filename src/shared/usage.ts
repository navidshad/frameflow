import type { Usage } from './types'

/**
 * What a cached prompt token costs next to a fresh one. Google publishes the
 * cached input price of its Flash models as a tenth of the standard input price
 * (Gemini 3 Flash Preview $0.05 against $0.50 per 1M; Gemini 3.6 Flash $0.075
 * against $0.75; 3.5 Flash-Lite $0.03 against $0.30). A loop re-sends its whole
 * conversation on every step, and the provider serves the repeated front of it
 * from cache, so leaving this out makes a long turn look several times dearer
 * than it was.
 */
export const CACHED_INPUT_RATIO = 0.1

/** The prompt tokens to bill at the full rate: the cached ones count at their fraction. */
export function billablePromptTokens(usage: Pick<Usage, 'promptTokens' | 'cachedTokens'>): number {
	const cached = Math.min(Math.max(0, usage.cachedTokens ?? 0), usage.promptTokens)
	return usage.promptTokens - cached * (1 - CACHED_INPUT_RATIO)
}
