import fs from 'fs'

/**
 * Reads a JSON file shaped `{ ..., "<key>": [ {...}, {...} ], ... }` without
 * ever holding the whole thing in memory: each element of the named top-level
 * arrays is handed to `onItem` as its own JSON text, one at a time, and the
 * rest of the top-level object is returned with those arrays left empty.
 *
 * This is what lets an old 437 MB revisions file open: JSON.parse on it needs
 * ~2.5 GB, while one revision at a time needs a few tens of MB.
 *
 * It scans bytes, which is safe for UTF-8: every structural character is ASCII,
 * and no byte of a multi-byte character falls in the ASCII range.
 */

export class JsonStreamError extends Error {}

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_OBJ = 0x7b
const CLOSE_OBJ = 0x7d
const OPEN_ARR = 0x5b
const CLOSE_ARR = 0x5d
const COMMA = 0x2c

export interface StreamOptions {
	/** An element bigger than this aborts the read (it would not fit in memory anyway). */
	maxItemBytes?: number
	/** The non-array part of the top-level object must stay under this. */
	maxRestBytes?: number
	highWaterMark?: number
}

export async function streamTopLevelArrays(
	filePath: string,
	keys: readonly string[],
	onItem: (key: string, json: string) => void | Promise<void>,
	options: StreamOptions = {}
): Promise<Record<string, unknown>> {
	const maxItemBytes = options.maxItemBytes ?? 512 * 1024 * 1024
	const maxRestBytes = options.maxRestBytes ?? 16 * 1024 * 1024
	const wanted = new Set(keys)

	let depth = 0
	let inString = false
	let escape = false
	// Text of the last string closed at depth 1 (a key, or a small value).
	let keyBytes: number[] = []
	let lastKey: string | null = null
	let arrayKey: string | null = null // inside one of the wanted arrays
	let itemParts: Buffer[] | null = null // collecting one element
	let itemBytes = 0
	const rest: Buffer[] = []
	let restBytes = 0
	let sawRoot = false

	const pushRest = (buf: Buffer) => {
		restBytes += buf.length
		if (restBytes > maxRestBytes) throw new JsonStreamError('Top-level fields are too large')
		rest.push(buf)
	}

	const stream = fs.createReadStream(filePath, { highWaterMark: options.highWaterMark ?? 1024 * 1024 })
	for await (const raw of stream) {
		const chunk = raw as Buffer
		let i = 0
		// Where the bytes being copied out of this chunk start: either the
		// current element, or the next run of top-level text.
		let runStart = 0
		const flushRun = (end: number) => {
			if (end <= runStart) return
			if (itemParts) {
				itemParts.push(chunk.subarray(runStart, end))
				itemBytes += end - runStart
				if (itemBytes > maxItemBytes) throw new JsonStreamError(`An entry in "${arrayKey}" is too large to load`)
			} else if (!arrayKey) {
				pushRest(chunk.subarray(runStart, end))
			}
			runStart = end
		}

		while (i < chunk.length) {
			if (inString) {
				if (escape) {
					escape = false
					if (depth === 1 && !arrayKey) keyBytes.push(chunk[i])
					i++
					continue
				}
				// Jump to the next quote or backslash: long HTML strings are most of the file.
				const q = chunk.indexOf(QUOTE, i)
				const b = chunk.indexOf(BACKSLASH, i)
				let next = q === -1 ? b : b === -1 ? q : Math.min(q, b)
				if (next === -1) next = chunk.length
				if (depth === 1 && !arrayKey) for (let k = i; k < next; k++) keyBytes.push(chunk[k])
				i = next
				if (i >= chunk.length) break
				if (chunk[i] === BACKSLASH) {
					escape = true
					if (depth === 1 && !arrayKey) keyBytes.push(chunk[i])
				} else {
					inString = false
					if (depth === 1 && !arrayKey) lastKey = Buffer.from(keyBytes).toString('utf8')
				}
				i++
				continue
			}

			const c = chunk[i]
			if (c === QUOTE) {
				inString = true
				if (depth === 1 && !arrayKey) keyBytes = []
				i++
				continue
			}
			if (c === OPEN_OBJ || c === OPEN_ARR) {
				if (depth === 0) {
					if (c !== OPEN_OBJ) throw new JsonStreamError('Expected a JSON object')
					sawRoot = true
				}
				if (depth === 1 && c === OPEN_ARR && !arrayKey && lastKey !== null && wanted.has(lastKey)) {
					// Entering a wanted array: keep "[" in the rest, drop its elements.
					flushRun(i + 1)
					arrayKey = lastKey
					depth++
					i++
					runStart = i
					continue
				}
				if (arrayKey && depth === 2 && !itemParts) {
					if (c !== OPEN_OBJ) throw new JsonStreamError(`Entries in "${arrayKey}" must be objects`)
					itemParts = []
					itemBytes = 0
					runStart = i
				}
				depth++
				i++
				continue
			}
			if (c === CLOSE_OBJ || c === CLOSE_ARR) {
				depth--
				if (depth < 0) throw new JsonStreamError('Unbalanced brackets')
				i++
				if (arrayKey && depth === 2 && itemParts) {
					flushRun(i)
					const json = Buffer.concat(itemParts).toString('utf8')
					itemParts = null
					itemBytes = 0
					await onItem(arrayKey, json)
					runStart = i
				} else if (arrayKey && depth === 1) {
					// The wanted array closed: put its "]" back into the rest.
					arrayKey = null
					runStart = i - 1
				}
				continue
			}
			if (c === COMMA && depth === 1) lastKey = null
			i++
		}
		flushRun(chunk.length)
	}

	if (!sawRoot || depth !== 0 || inString) throw new JsonStreamError('The file ends early (truncated or damaged)')
	let parsed: unknown
	try {
		parsed = JSON.parse(Buffer.concat(rest).toString('utf8'))
	} catch {
		throw new JsonStreamError('The file is not valid JSON')
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new JsonStreamError('Expected a JSON object')
	return parsed as Record<string, unknown>
}
