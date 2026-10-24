import { describe, expect, it } from 'vitest'
import { testGeminiKey } from './geminiKey'

const reply = (status: number, body = '{}') => (async () => new Response(body, { status })) as unknown as typeof fetch

describe('testGeminiKey', () => {
	it('sends the key as a header, never in the URL', async () => {
		let seen: { url: string; headers: any } | undefined
		const f = (async (url: string, init: any) => { seen = { url, headers: init.headers }; return new Response('{}') }) as unknown as typeof fetch
		expect(await testGeminiKey(' abc ', f)).toEqual({ ok: true })
		expect(seen!.headers['x-goog-api-key']).toBe('abc')
		expect(seen!.url).not.toContain('abc')
	})
	it('fails cleanly on a rejected key', async () => {
		const r = await testGeminiKey('fake', reply(400, '{"error":{"message":"API key not valid."}}'))
		expect(r.ok).toBe(false)
		expect(r.error).toMatch(/does not accept/)
	})
	it('fails cleanly offline and on an empty key', async () => {
		const offline = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as unknown as typeof fetch
		expect((await testGeminiKey('k', offline)).error).toMatch(/Could not reach Google/)
		expect((await testGeminiKey('  ')).ok).toBe(false)
	})
})
