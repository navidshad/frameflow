/**
 * Web search and page reading for agents that have no search of their own,
 * the decidable parts.
 *
 * Search is Gemini's own Google Search tool ("grounding"): the model searches
 * Google, answers, and lists the pages it used. FrameFlow does not drive a
 * browser through google.com: automated searches meet consent pages and
 * CAPTCHAs, and the page's layout is not a contract. A page an agent wants to
 * read is fetched and turned into plain text here.
 *
 * Everything that comes back is web content: data for the agent to weigh, never
 * instructions. The tools say so in what they return.
 */

export const PAGE_MAX_CHARS = 15_000
export const QUERY_MAX_CHARS = 400

/** What a search found: an answer in words, and the pages it came from. */
export interface SearchResult {
	answer: string
	sources: { title: string; url: string }[]
	/** What Google was asked, as the model phrased it. */
	queries: string[]
}

/** Gemini's reply with Google Search on → the answer and its sources. */
export function parseGrounded(body: unknown): SearchResult {
	const candidate = (body as any)?.candidates?.[0]
	const parts: unknown[] = candidate?.content?.parts ?? []
	const answer = parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('').trim()
	const meta = candidate?.groundingMetadata ?? {}
	const seen = new Set<string>()
	const sources: SearchResult['sources'] = []
	for (const chunk of meta.groundingChunks ?? []) {
		const url = chunk?.web?.uri
		if (typeof url !== 'string' || seen.has(url)) continue
		seen.add(url)
		sources.push({ title: typeof chunk.web.title === 'string' ? chunk.web.title : url, url })
	}
	const queries = (meta.webSearchQueries ?? []).filter((q: unknown): q is string => typeof q === 'string')
	return { answer, sources, queries }
}

/**
 * Whether an agent may have FrameFlow fetch this address: http(s) to a public
 * host only. Not this machine, not the local network: FrameFlow's own MCP
 * server and the person's router are on those.
 */
export function publicUrlProblem(raw: string): string | null {
	let url: URL
	try { url = new URL(raw) } catch { return 'That is not a web address.' }
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only http and https pages can be read.'
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.includes(':')) {
		return 'Pages on this computer or the local network cannot be read.'
	}
	const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])]
		if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
			return 'Pages on this computer or the local network cannot be read.'
		}
	}
	if (host.includes(':') && (host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd') || host === '::')) {
		return 'Pages on this computer or the local network cannot be read.'
	}
	return null
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

/** `&amp;`, `&#8212;`, `&#x2014;` → the characters they stand for; unknown names are left as they are. */
function decodeEntities(text: string): string {
	return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === '#') {
			const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
		}
		return ENTITIES[e.toLowerCase()] ?? m
	})
}

/** A page → its title and readable text: no scripts, styles or markup, blocks on their own lines. */
export function htmlToText(html: string): { title: string; text: string } {
	const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim())
	const text = decodeEntities(html
		.replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, ' ')
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/pre|\/table)\s*\/?>/gi, '\n')
		.replace(/<li[^>]*>/gi, '\n- ')
		.replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n${'#'.repeat(Number(n))} `)
		.replace(/<t[dh][^>]*>/gi, ' | ')
		.replace(/<[^>]+>/g, ' '))
		.split('\n').map((l) => l.replace(/[ \t\f\v\r]+/g, ' ').trim()).filter(Boolean).join('\n')
	return { title, text }
}

/** A long page cut to what an agent can read, saying so. */
export function clipPage(text: string, max = PAGE_MAX_CHARS): { text: string; cut: boolean } {
	if (text.length <= max) return { text, cut: false }
	return { text: `${text.slice(0, max)}\n…`, cut: true }
}
