import { describe, it, expect, vi } from 'vitest'

vi.mock('../settings', () => ({
	settingsManager: { getGeminiApiKey: () => 'test-key', getModelSettings: () => ({ pricing: {} }) }
}))
vi.mock('../ffmpeg', () => ({ sanitizeFilename: (s: string) => s }))

import { GeminiAdapter } from './adapter'

function adapterWithMock() {
	const adapter = new GeminiAdapter('test-key')
	const generateContent = vi.fn().mockResolvedValue({
		candidates: [{ content: { parts: [{ text: 'ok' }] } }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
	})
	;(adapter as any).client = { models: { generateContent } }
	return { adapter, generateContent }
}

describe('GeminiAdapter.generateText request shape', () => {
	it('puts the system instruction under config, where the SDK reads it', async () => {
		const { adapter, generateContent } = adapterWithMock()
		const { text } = await adapter.generateText('gemini-test', 'hello', 'be terse')

		expect(text).toBe('ok')
		const request = generateContent.mock.calls[0][0]
		expect(request.config).toEqual({ systemInstruction: 'be terse' })
		expect(request).not.toHaveProperty('systemInstruction')
		expect(request.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }])
	})

	it('sends no config when there is no system instruction', async () => {
		const { adapter, generateContent } = adapterWithMock()
		await adapter.generateText('gemini-test', 'hello')

		const request = generateContent.mock.calls[0][0]
		expect(request).not.toHaveProperty('config')
		expect(request).not.toHaveProperty('systemInstruction')
	})
})
