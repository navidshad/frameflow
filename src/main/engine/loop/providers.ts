import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel, LanguageModelUsage } from 'ai'
import type { LoopEngineId } from '@shared/engines'
import type { Usage } from '@shared/types'

/**
 * Where a loop engine's models come from. One entry per engine id: a new
 * provider (OpenRouter's cheaper models, say) is one more line here, a model
 * list in the engine tables, and a key in settings. The loop itself never names
 * a provider.
 */
const PROVIDERS: Record<LoopEngineId, (modelName: string, apiKey: string) => LanguageModel> = {
	'gemini-api': (modelName, apiKey) => createGoogleGenerativeAI({ apiKey })(modelName)
}

export function createLoopModel(engine: LoopEngineId, modelName: string, apiKey: string): LanguageModel {
	return PROVIDERS[engine](modelName, apiKey)
}

/**
 * The SDK counts reasoning inside the output; FrameFlow's usage record (and the
 * price table behind it) bills candidates and thinking apart.
 */
export function usageFrom(usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens' | 'totalTokens' | 'outputTokenDetails' | 'inputTokenDetails'> | undefined): Usage {
	const promptTokens = usage?.inputTokens ?? 0
	const output = usage?.outputTokens ?? 0
	const thinking = Math.min(output, usage?.outputTokenDetails?.reasoningTokens ?? 0)
	return {
		promptTokens,
		candidatesTokens: output - thinking,
		thinkingTokens: thinking,
		totalTokens: usage?.totalTokens ?? promptTokens + output,
		cachedTokens: Math.min(promptTokens, usage?.inputTokenDetails?.cacheReadTokens ?? 0)
	}
}

export const addUsage = (a: Usage, b: Usage): Usage => ({
	promptTokens: a.promptTokens + b.promptTokens,
	candidatesTokens: a.candidatesTokens + b.candidatesTokens,
	thinkingTokens: (a.thinkingTokens ?? 0) + (b.thinkingTokens ?? 0),
	totalTokens: a.totalTokens + b.totalTokens,
	cachedTokens: (a.cachedTokens ?? 0) + (b.cachedTokens ?? 0)
})
