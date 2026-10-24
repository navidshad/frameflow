import { classifyGeminiKeyResponse, type KeyTestResult } from '../../shared/setup'

/**
 * A real, tiny call with the pasted key: listing one model. It costs nothing,
 * needs no model choice, and Google refuses it for a bad key exactly as it
 * would refuse a generation.
 */
export async function testGeminiKey(key: string, fetchImpl: typeof fetch = fetch): Promise<KeyTestResult> {
	const trimmed = (key || '').trim()
	if (!trimmed) return { ok: false, error: 'Paste a key first.' }
	try {
		const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
			headers: { 'x-goog-api-key': trimmed },
			signal: AbortSignal.timeout(15000)
		})
		return classifyGeminiKeyResponse(response.status, await response.text())
	} catch (error: any) {
		return { ok: false, error: `Could not reach Google to check the key (${error?.name === 'TimeoutError' ? 'timed out' : error?.message || 'offline'}).` }
	}
}
