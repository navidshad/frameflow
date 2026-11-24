import { clipPage, htmlToText, parseGrounded, publicUrlProblem, QUERY_MAX_CHARS, type SearchResult } from '../../shared/webText'
import type { Usage } from '../../shared/types'

/**
 * Search the web with Gemini's own Google Search tool, and read one page.
 *
 * For agents with no search of their own: FrameFlow's in-app loop on the Gemini
 * API. (Claude Code uses its own WebSearch and WebFetch; outside agents have
 * theirs.) The search is one `generateContent` call with `google_search` on,
 * from the Gemini API docs: the model searches Google, answers, and lists its
 * sources in `groundingMetadata`. Network injected, so both are tested with a
 * fake server.
 */

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'
const SEARCH_TIMEOUT_MS = 60_000
const PAGE_TIMEOUT_MS = 20_000
const PAGE_MAX_BYTES = 3 * 1024 * 1024

export interface SearchDeps {
	fetch: typeof fetch
	key: string
	model: string
	signal?: AbortSignal
}

/** What the search model is asked: answer from what it finds, exactly, and say what it could not find. */
export function searchPrompt(query: string): string {
	return [
		'Search the web and answer this, for a video editor choosing tools and settings:',
		query,
		'',
		'Answer from what you find, briefly. Give model ids, parameter names, limits and prices exactly as the sources write them, ' +
		'with the date of the source when it has one. Prefer the vendor\'s own documentation. Say when sources disagree, and say ' +
		'plainly when you found nothing.'
	].join('\n')
}

export async function geminiWebSearch(query: string, deps: SearchDeps): Promise<SearchResult & { usage?: Usage }> {
	const q = query.trim().slice(0, QUERY_MAX_CHARS)
	if (q.length < 3) throw new Error('Say what to search for.')
	const signal = deps.signal ?? AbortSignal.timeout(SEARCH_TIMEOUT_MS)
	const res = await deps.fetch(`${GEMINI_BASE}/models/${encodeURIComponent(deps.model)}:generateContent`, {
		method: 'POST', signal,
		headers: { 'x-goog-api-key': deps.key, 'content-type': 'application/json' },
		body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: searchPrompt(q) }] }], tools: [{ google_search: {} }] })
	})
	const body = await res.json().catch(() => null) as any
	if (!res.ok) {
		const said = body?.error?.message ? `: ${body.error.message}` : ''
		if (res.status === 429) throw new Error(`Gemini is rate limiting searches, or its quota is used up${said}.`)
		if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key/i.test(said))) throw new Error(`Gemini did not accept the API key${said}.`)
		throw new Error(`The search failed (${res.status})${said}.`)
	}
	const found = parseGrounded(body)
	const meta = body?.usageMetadata
	const usage: Usage | undefined = meta ? {
		promptTokens: meta.promptTokenCount ?? 0, candidatesTokens: meta.candidatesTokenCount ?? 0,
		thinkingTokens: meta.thoughtsTokenCount ?? 0, totalTokens: meta.totalTokenCount ?? 0
	} : undefined
	return { ...found, ...(usage ? { usage } : {}) }
}

export interface PageRead { url: string; title: string; text: string; cut: boolean }

/** One public page as plain text. Refuses this machine and the local network, and anything that is not a page. */
export async function readWebPage(raw: string, deps: { fetch: typeof fetch; signal?: AbortSignal }): Promise<PageRead> {
	const problem = publicUrlProblem(raw)
	if (problem) throw new Error(problem)
	const res = await deps.fetch(raw, {
		redirect: 'follow', signal: deps.signal ?? AbortSignal.timeout(PAGE_TIMEOUT_MS),
		headers: { accept: 'text/html,text/plain,text/markdown;q=0.9,*/*;q=0.1', 'user-agent': 'FrameFlow (page reader)' }
	})
	// A redirect may land somewhere it should not have gone.
	const landed = res.url || raw
	const after = publicUrlProblem(landed)
	if (after) throw new Error(after)
	if (!res.ok) throw new Error(`The page answered ${res.status}.`)
	const type = res.headers.get('content-type') ?? ''
	if (type && !/text\/|html|markdown|json|xml/i.test(type)) throw new Error(`That is not a page (${type.split(';')[0]}).`)
	const buffer = Buffer.from(await res.arrayBuffer())
	const raw8 = buffer.subarray(0, PAGE_MAX_BYTES).toString('utf-8')
	const { title, text } = /html/i.test(type) || /<html|<body|<p[\s>]/i.test(raw8.slice(0, 2000)) ? htmlToText(raw8) : { title: '', text: raw8 }
	const clipped = clipPage(text)
	return { url: landed, title, text: clipped.text, cut: clipped.cut }
}
