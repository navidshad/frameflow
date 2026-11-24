import type { AudioCapability } from './audioProviders'

/**
 * The part of a provider's own documentation that matters for one kind of
 * sound, for an agent choosing a model.
 *
 * ElevenLabs publishes its models page as markdown (one section per model,
 * plus a selection guide, the deprecated models with their removal dates, and
 * the character limits). The page is long and mostly about other things
 * (speech recognition, voice agents), so it is cut into sections by heading and
 * only these are kept: ones that mention a model id the provider lists today
 * for this kind, ones whose heading names the kind, and the guide sections.
 * Matching is by today's ids, never by names written here, so a new model's
 * section is picked up the day it appears.
 */

export const DOCS_MAX_CHARS = 12_000

/** Words a heading uses for each kind. About the kind, not about any model. */
const KIND_WORDS: Record<AudioCapability, RegExp> = {
	speech: /text to speech|\btts\b/i,
	sfx: /sound effect|\bsfx\b/i,
	music: /\bmusic\b/i
}
/** Sections any choice needs: how to choose, what is retiring, how much text fits. */
const GUIDE = /selection guide|deprecat|character limit/i

export interface DocSection { heading: string; text: string }

/** Markdown → sections at each heading, each with the path of headings above it. */
export function splitSections(markdown: string): DocSection[] {
	const out: DocSection[] = []
	const path: string[] = []
	let lines: string[] = []
	let heading = ''
	const flush = () => { if (heading || lines.some((l) => l.trim())) out.push({ heading, text: lines.join('\n').trim() }) }
	for (const line of markdown.split('\n')) {
		const m = /^(#{1,6})\s+(.*)$/.exec(line)
		if (!m) { lines.push(line); continue }
		flush()
		const level = m[1].length
		// "[Eleven v4](/docs/…#eleven-v4)" reads as "Eleven v4".
		const title = m[2].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim()
		path.length = level - 1
		path[level - 1] = title
		heading = path.filter(Boolean).join(' › ')
		lines = []
	}
	flush()
	return out
}

/** Rows of a markdown table that mention none of the ids are dropped, so a big table keeps only its own kind. */
function keepRows(text: string, ids: string[]): string {
	return text.split('\n').filter((line) => {
		if (!line.trim().startsWith('|')) return true
		if (/^\|\s*-/.test(line.trim()) || /model id/i.test(line)) return true
		return ids.some((id) => line.includes(id))
	}).join('\n')
}

/**
 * The sections of the page an agent choosing a `capability` model should read,
 * within `max` characters. `ids` and `names` are today's models of that kind,
 * as the provider lists them ("eleven_v4", "Eleven v4").
 */
export function docsFor(markdown: string, capability: AudioCapability, ids: string[], max = DOCS_MAX_CHARS, names: string[] = []): string {
	const named = names.map((n) => n.toLowerCase()).filter((n) => n.length >= 4)
	const mentions = (s: DocSection) => ids.some((id) => s.text.includes(id) || s.heading.includes(id)) ||
		named.some((n) => s.heading.toLowerCase().split(' › ').some((h) => h === n || h.endsWith(` ${n}`) || n.endsWith(` ${h}`)))
	const scored = splitSections(markdown)
		.map((s) => ({ s, score: (mentions(s) ? 2 : 0) + (KIND_WORDS[capability].test(s.heading) ? 2 : 0) + (GUIDE.test(s.heading) ? 1 : 0) }))
		.filter((x) => x.score > 0)
	// The best first, then cut at the budget; the result keeps the page's order.
	const chosen = new Set<DocSection>()
	let used = 0
	for (const { s } of [...scored].sort((a, b) => b.score - a.score)) {
		const size = s.heading.length + keepRows(s.text, ids).length + 8
		if (used + size > max) continue
		chosen.add(s)
		used += size
	}
	return scored.filter((x) => chosen.has(x.s))
		.map(({ s }) => `## ${s.heading}\n${keepRows(s.text, ids)}`)
		.join('\n\n')
}
