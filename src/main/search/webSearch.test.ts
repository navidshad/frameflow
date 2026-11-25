import { describe, expect, it } from 'vitest'
import { geminiWebSearch, readWebPage } from './webSearch'

function fakeFetch(reply: (url: string, init: RequestInit) => Response) {
	const seen: { url: string; init: RequestInit }[] = []
	const f = (async (url: string, init: RequestInit = {}) => { seen.push({ url, init }); return reply(url, init) }) as unknown as typeof fetch
	return { f, seen }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('searching with Gemini’s Google Search', () => {
	it('asks the model with google_search on, by header key, and returns the answer, sources and usage', async () => {
		const { f, seen } = fakeFetch(() => json({
			candidates: [{ content: { parts: [{ text: 'Use steady_v2.' }] }, groundingMetadata: { webSearchQueries: ['q'], groundingChunks: [{ web: { uri: 'https://x/1', title: 'x' } }] } }],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 35 }
		}))
		const out = await geminiWebSearch('  which model for narration?  ', { fetch: f, key: 'AIza', model: 'gemini-3-flash-preview' })
		expect(seen[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent')
		expect((seen[0].init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza')
		const body = JSON.parse(String(seen[0].init.body))
		expect(body.tools).toEqual([{ google_search: {} }])
		expect(body.contents[0].parts[0].text).toContain('which model for narration?')
		expect(out).toMatchObject({ answer: 'Use steady_v2.', sources: [{ url: 'https://x/1', title: 'x' }], queries: ['q'] })
		expect(out.usage).toEqual({ promptTokens: 10, candidatesTokens: 20, thinkingTokens: 5, totalTokens: 35 })
	})

	it('says what went wrong in words, and never sends an empty question', async () => {
		const rate = fakeFetch(() => json({ error: { message: 'Quota exceeded' } }, 429))
		await expect(geminiWebSearch('a question', { fetch: rate.f, key: 'k', model: 'm' })).rejects.toThrow(/rate limiting.*Quota exceeded/)
		const key = fakeFetch(() => json({ error: { message: 'API key not valid.' } }, 400))
		await expect(geminiWebSearch('a question', { fetch: key.f, key: 'bad', model: 'm' })).rejects.toThrow(/did not accept the API key/)
		const none = fakeFetch(() => json({}))
		await expect(geminiWebSearch(' ', { fetch: none.f, key: 'k', model: 'm' })).rejects.toThrow(/what to search/)
		expect(none.seen).toHaveLength(0)
	})
})

describe('reading a page', () => {
	const page = (body: string, type = 'text/html; charset=utf-8', url = 'https://vendor.example/docs') => {
		const res = new Response(body, { status: 200, headers: { 'content-type': type } })
		Object.defineProperty(res, 'url', { value: url })
		return res
	}

	it('returns a public page as text, and markdown as it is', async () => {
		const html = fakeFetch(() => page('<html><title>Docs</title><body><p>Hello</p></body></html>'))
		expect(await readWebPage('https://vendor.example/docs', { fetch: html.f })).toEqual({ url: 'https://vendor.example/docs', title: 'Docs', text: 'Hello', cut: false })
		const md = fakeFetch(() => page('# Models\n\n- one', 'text/markdown'))
		expect((await readWebPage('https://vendor.example/models.md', { fetch: md.f })).text).toBe('# Models\n\n- one')
	})

	it('never asks this computer or the local network, even when a redirect leads there', async () => {
		const never = fakeFetch(() => page('x'))
		await expect(readWebPage('http://127.0.0.1:47615/mcp', { fetch: never.f })).rejects.toThrow(/local network/)
		expect(never.seen).toHaveLength(0)
		const redirected = fakeFetch(() => page('secret', 'text/html', 'http://192.168.1.1/admin'))
		await expect(readWebPage('https://short.example/x', { fetch: redirected.f })).rejects.toThrow(/local network/)
	})

	it('refuses what is not a page', async () => {
		const video = fakeFetch(() => page('....', 'video/mp4'))
		await expect(readWebPage('https://vendor.example/clip.mp4', { fetch: video.f })).rejects.toThrow(/not a page \(video\/mp4\)/)
	})
})
