import type { SearchResult } from '../../shared/webText'
import { settingsManager } from '../settings'
import { threadManager } from '../threads'
import { GeminiAdapter } from '../gemini/adapter'
import { GEMINI_MODEL_3_FLASH_PREVIEW } from '../constants/gemini'
import { geminiWebSearch, readWebPage, type PageRead } from './webSearch'

/**
 * The app's wiring of web search: the Gemini key and model the in-app
 * assistant already uses, and the project's spend history for what a search
 * cost (its tokens; Google bills the searches themselves separately, past a
 * free allowance, on the same key).
 */

export async function searchForProject(threadId: string, query: string): Promise<SearchResult> {
	const key = settingsManager.getGeminiApiKey()
	if (!key) throw new Error('Web search needs a Gemini API key (Settings → Connections).')
	const model = settingsManager.getModelSettings().selection['editor-edit'] || GEMINI_MODEL_3_FLASH_PREVIEW
	const found = await geminiWebSearch(query, { fetch, key, model })
	if (found.usage) {
		const usage = found.usage
		await threadManager.updateThreadWith(threadId, (t) => ({
			usageHistory: [...(t.usageHistory || []), { usage, cost: GeminiAdapter.calculateCost(model, usage), timestamp: Date.now(), source: 'search' }]
		}))
	}
	return { answer: found.answer, sources: found.sources, queries: found.queries }
}

export const readPage = (url: string): Promise<PageRead> => readWebPage(url, { fetch })
