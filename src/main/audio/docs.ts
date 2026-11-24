/**
 * A provider's documentation page, fetched at most once a day and kept on disk,
 * so an agent researching models reads the vendor's own words without FrameFlow
 * asking for the page on every call. A failed fetch keeps the copy it had.
 * Network and disk are injected for tests.
 */

export const DOCS_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface SavedDoc { url: string; fetchedAt: number; text: string }

export interface DocsCacheDeps {
	fetch: typeof fetch
	load(url: string): SavedDoc | null
	save(doc: SavedDoc): void
	now?: () => number
}

export function createDocsCache(deps: DocsCacheDeps) {
	const now = deps.now ?? Date.now
	const memory = new Map<string, SavedDoc>()

	return {
		async get(url: string): Promise<SavedDoc | null> {
			let known = memory.get(url) ?? null
			if (!known) {
				try { known = deps.load(url) } catch { known = null }
				if (known) memory.set(url, known)
			}
			if (known && now() - known.fetchedAt < DOCS_MAX_AGE_MS) return known
			try {
				const res = await deps.fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'text/markdown,text/plain,*/*' } })
				if (!res.ok) throw new Error(`${url} answered ${res.status}`)
				const text = await res.text()
				if (!text.trim()) throw new Error(`${url} was empty`)
				const doc: SavedDoc = { url, fetchedAt: now(), text }
				memory.set(url, doc)
				try { deps.save(doc) } catch { /* kept in memory still */ }
				return doc
			} catch (error) {
				console.warn('[audio] could not read the docs:', (error as Error).message)
				return known
			}
		}
	}
}
