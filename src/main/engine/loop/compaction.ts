import type { ModelMessage } from 'ai'

/**
 * Keeping a long conversation small, by clearing rather than summarising.
 *
 * What fills a context in FrameFlow is old tool results: a timeline read of a
 * few hundred clips, a transcript, and above all the pictures render_frame
 * returns. The model has acted on them already. So the newest results stay in
 * full, older big ones are replaced by a one-line stub that names the tool and
 * says to call it again if the result is needed, and only the last few pictures
 * are kept. The calls themselves, the assistant's words and every small result
 * stay, so the thread still reads as what happened.
 *
 * Pure: messages in, messages out, nothing mutated. The same function trims what
 * the next turn is sent and what is saved to disk.
 */

export interface CompactOptions {
	/** The newest this many tool results are always kept whole. Every step re-sends them all, so each one kept is paid for again on every later step. */
	keepResults: number
	/** Of those, pictures are kept only in the newest this many results that have one. */
	keepImages: number
	/** An older result is cleared once it is longer than this many characters. */
	stubOver: number
}

export const DEFAULT_COMPACT: CompactOptions = { keepResults: 5, keepImages: 2, stubOver: 1000 }

/** What the file is saved as: no pictures at all, the same limits otherwise. */
export const STORAGE_COMPACT: CompactOptions = { ...DEFAULT_COMPACT, keepImages: 0 }

type Part = { type: string; [key: string]: unknown }

const IMAGE_PART = (part: Part) =>
	part.type === 'image-data' || part.type === 'image-url' || part.type === 'image' ||
	(part.type === 'file' && /^image\//.test(String((part as any).mediaType ?? (part as any).mimeType ?? '')))

const contentParts = (output: any): Part[] => (output?.type === 'content' && Array.isArray(output.value) ? output.value : [])

const hasImage = (output: any): boolean => contentParts(output).some(IMAGE_PART)

/** Characters of text the model reads in a result, not counting picture data. */
export function resultSize(output: any): number {
	if (!output) return 0
	switch (output.type) {
		case 'text': case 'error-text': return String(output.value ?? '').length
		case 'json': case 'error-json': return JSON.stringify(output.value ?? null).length
		case 'content': return contentParts(output).reduce((sum, p) => sum + (p.type === 'text' ? String(p.text ?? '').length : 0), 0)
		default: return 0
	}
}

const stub = (tool: string, why: string) =>
	({ type: 'text', value: `[${tool}: ${why} cleared to save space. Call ${tool} again if you need it.]` }) as const

export function compactMessages(messages: ModelMessage[], options: CompactOptions = DEFAULT_COMPACT): ModelMessage[] {
	// Every tool result, oldest first, so "newest" is by position and survives interleaving.
	const results: { message: number; part: number; output: any; tool: string }[] = []
	messages.forEach((message, m) => {
		if (message.role !== 'tool') return
		message.content.forEach((part, p) => {
			if ((part as Part).type === 'tool-result') results.push({ message: m, part: p, output: (part as any).output, tool: String((part as any).toolName ?? 'the tool') })
		})
	})
	if (!results.length) return messages

	const replacements = new Map<string, any>()
	const key = (m: number, p: number) => `${m}:${p}`
	const oldCount = Math.max(0, results.length - options.keepResults)

	results.forEach((r, i) => {
		if (i < oldCount && (hasImage(r.output) || resultSize(r.output) > options.stubOver)) {
			replacements.set(key(r.message, r.part), stub(r.tool, hasImage(r.output) ? 'an older result with a picture' : 'an older result'))
		}
	})

	// Pictures among the kept results: only the newest few stay.
	const withImages = results.filter((_, i) => i >= oldCount).filter((r) => hasImage(r.output))
	withImages.slice(0, Math.max(0, withImages.length - options.keepImages)).forEach((r) => {
		const parts = contentParts(r.output).filter((p) => !IMAGE_PART(p))
		const text = parts.length ? parts : [{ type: 'text', text: `[${r.tool}: picture cleared to save space. Call ${r.tool} again to see it.]` }]
		replacements.set(key(r.message, r.part), { type: 'content', value: text })
	})

	if (!replacements.size) return messages
	return messages.map((message, m) => {
		if (message.role !== 'tool') return message
		const content = message.content.map((part, p) => {
			const replacement = replacements.get(key(m, p))
			return replacement ? { ...(part as object), output: replacement } : part
		})
		return { ...message, content } as ModelMessage
	})
}

/**
 * The newest messages that fit in `maxChars`, starting at a user message, so a
 * tool result is never left without the call that asked for it.
 */
export function trimHistory(messages: ModelMessage[], maxChars: number): ModelMessage[] {
	const size = (m: ModelMessage) => JSON.stringify(m).length
	let total = messages.reduce((sum, m) => sum + size(m), 0)
	let start = 0
	while (total > maxChars && start < messages.length - 1) {
		total -= size(messages[start])
		start++
		while (start < messages.length - 1 && messages[start].role !== 'user') {
			total -= size(messages[start])
			start++
		}
	}
	return start ? messages.slice(start) : messages
}
