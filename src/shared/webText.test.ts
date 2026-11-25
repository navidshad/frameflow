import { describe, expect, it } from 'vitest'
import { clipPage, htmlToText, parseGrounded, publicUrlProblem } from './webText'

/** Shaped like a real Gemini reply with Google Search on (gemini-3-flash-preview, 2026-11-24). */
const GROUNDED = {
	candidates: [{
		content: { role: 'model', parts: [{ text: 'For long narration the vendor recommends ' }, { text: '`steady_v2`.' }] },
		groundingMetadata: {
			webSearchQueries: ['best model long narration', 'model character limits'],
			groundingChunks: [
				{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA', title: 'vendor.example' } },
				{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB', title: 'blog.example' } },
				{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA', title: 'vendor.example' } },
				{ retrievedContext: { uri: 'gs://not-web' } }
			]
		}
	}],
	usageMetadata: { promptTokenCount: 154, candidatesTokenCount: 371, thoughtsTokenCount: 853, totalTokenCount: 1378 }
}

describe('a search answer', () => {
	it('is the answer text, the pages it came from once each, and what was searched', () => {
		expect(parseGrounded(GROUNDED)).toEqual({
			answer: 'For long narration the vendor recommends `steady_v2`.',
			sources: [
				{ title: 'vendor.example', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA' },
				{ title: 'blog.example', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB' }
			],
			queries: ['best model long narration', 'model character limits']
		})
	})

	it('is empty, not broken, when the reply has nothing', () => {
		expect(parseGrounded({})).toEqual({ answer: '', sources: [], queries: [] })
		expect(parseGrounded(null)).toEqual({ answer: '', sources: [], queries: [] })
	})
})

describe('which pages may be read', () => {
	it.each([
		['https://elevenlabs.io/docs/overview/models', null],
		['http://example.com/page', null],
		['file:///etc/passwd', /Only http/],
		['ftp://example.com', /Only http/],
		['http://localhost:47615/mcp', /local network/],
		['http://127.0.0.1:47615/mcp', /local network/],
		['http://192.168.1.1/', /local network/],
		['http://10.0.0.8/', /local network/],
		['http://172.20.0.1/', /local network/],
		['http://169.254.169.254/latest/meta-data', /local network/],
		['http://[::1]:8080/', /local network/],
		['http://router/', /local network/],
		['http://printer.local/', /local network/],
		['not a url', /not a web address/]
	])('%s', (url, problem) => {
		const got = publicUrlProblem(url)
		if (problem === null) expect(got).toBeNull()
		else expect(got).toMatch(problem as RegExp)
	})
})

describe('a page as text', () => {
	it('keeps the words and the title, drops scripts, styles and markup', () => {
		const { title, text } = htmlToText(`<html><head><title>Models &amp; limits</title><style>p{color:red}</style></head>
			<body><script>steal()</script><h2>Voice Four</h2><p>Reads&nbsp;100,000 characters.</p>
			<ul><li>Fast</li><li>Natural &#8212; really</li></ul><table><tr><td>a</td><td>b</td></tr></table><!-- hidden --></body></html>`)
		expect(title).toBe('Models & limits')
		expect(text).toBe('## Voice Four\nReads 100,000 characters.\n- Fast\n- Natural — really\n| a | b')
		expect(text).not.toContain('steal')
		expect(text).not.toContain('color')
	})

	it('is cut to what an agent can read, and says so', () => {
		expect(clipPage('short')).toEqual({ text: 'short', cut: false })
		const long = clipPage('x'.repeat(100), 10)
		expect(long.cut).toBe(true)
		expect(long.text).toBe('xxxxxxxxxx\n…')
	})
})
