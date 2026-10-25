import crypto from 'crypto'

/**
 * Content-addressed storage for the big strings inside timeline snapshots.
 *
 * A snapshot is mostly motion page HTML (working + passed copies, ~90 KB each),
 * and most of it is identical from one revision or undo step to the next. Storing
 * every snapshot verbatim made a 28-layer project's revisions file 437 MB that held
 * only 5 MB of distinct text. Here each string at or above BLOB_MIN_CHARS is
 * replaced by a short reference to its SHA-256, and the text is kept once.
 *
 * A reference is a string that starts with BLOB_PREFIX. Any string that already
 * starts with that prefix is stored as a blob too, whatever its length, so a
 * reference can never be confused with real content on the way back.
 */

export const BLOB_MIN_CHARS = 2048
export const BLOB_PREFIX = '\u0000ffblob:'

export function hashText(text: string): string {
	return crypto.createHash('sha256').update(text).digest('hex')
}

const isRef = (value: string) => value.startsWith(BLOB_PREFIX)

/**
 * Returns a copy of `value` with every large string swapped for a reference.
 * `put` is called once per distinct string met in this call (store it if new).
 */
export function dehydrate<T>(value: T, put: (hash: string, text: string) => void): T {
	const seen = new Set<string>()
	const walk = (v: unknown): unknown => {
		if (typeof v === 'string') {
			if (v.length < BLOB_MIN_CHARS && !isRef(v)) return v
			const hash = hashText(v)
			if (!seen.has(hash)) {
				seen.add(hash)
				put(hash, v)
			}
			return BLOB_PREFIX + hash
		}
		if (Array.isArray(v)) return v.map(walk)
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {}
			for (const [k, child] of Object.entries(v)) out[k] = walk(child)
			return out
		}
		return v
	}
	return walk(value) as T
}

/** Thrown when a reference points at text that is no longer stored. */
export class MissingBlobError extends Error {
	constructor(readonly hash: string) {
		super(`Stored text ${hash.slice(0, 12)}… is missing`)
	}
}

/**
 * Puts the text back. `get` returns undefined for a missing blob, which throws
 * MissingBlobError: a half-restored timeline is worse than a clear failure.
 * Identical references resolve to the same string instance, so a hydrated
 * snapshot costs its distinct text once in memory too.
 */
export function hydrate<T>(value: T, get: (hash: string) => string | undefined): T {
	const cache = new Map<string, string>()
	const walk = (v: unknown): unknown => {
		if (typeof v === 'string') {
			if (!isRef(v)) return v
			const hash = v.slice(BLOB_PREFIX.length)
			let text = cache.get(hash)
			if (text === undefined) {
				text = get(hash)
				if (text === undefined) throw new MissingBlobError(hash)
				cache.set(hash, text)
			}
			return text
		}
		if (Array.isArray(v)) return v.map(walk)
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {}
			for (const [k, child] of Object.entries(v)) out[k] = walk(child)
			return out
		}
		return v
	}
	return walk(value) as T
}

/** Adds every blob hash referenced inside `value` to `into`. */
export function collectRefs(value: unknown, into: Set<string> = new Set()): Set<string> {
	const walk = (v: unknown) => {
		if (typeof v === 'string') {
			if (isRef(v)) into.add(v.slice(BLOB_PREFIX.length))
			return
		}
		if (Array.isArray(v)) v.forEach(walk)
		else if (v && typeof v === 'object') for (const child of Object.values(v)) walk(child)
	}
	walk(value)
	return into
}
