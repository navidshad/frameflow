import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute, normalize } from 'node:path'
import { Readable } from 'node:stream'
import { fromMediaUrl } from '@shared/media-url'

/**
 * Serves the `media://` scheme that every local image, video and audio element
 * in the renderer loads from. See `@shared/media-url` for the URL shape.
 *
 * This replaces `protocol.registerFileProtocol`, deprecated since Electron 25
 * and unusable on Windows since Electron 33 (Chromium's non-special-scheme URL
 * rules stopped accepting a drive letter where a host belongs).
 *
 * The part that is NOT free after the migration is byte ranges.
 * `registerFileProtocol` handed the file to Chromium and ranges came with it;
 * `protocol.handle` hands back a `Response`, so 206 is ours to build. Without
 * it `video.seekable.end()` reports 0 and every seek in the timeline editor
 * snaps back to the start — the whole editing surface depends on this.
 */
export function registerMediaProtocol(): void {
	protocol.handle('media', async (request) => {
		let filePath: string
		try {
			filePath = normalize(fromMediaUrl(request.url))
		} catch {
			return new Response(null, { status: 400 })
		}

		// The renderer never loads remote content, so this is depth rather than a
		// boundary — but a relative path can only arrive from a malformed caller,
		// and resolving it against the main process's cwd is never what was meant.
		if (!filePath || !isAbsolute(filePath)) {
			return new Response(null, { status: 400 })
		}

		let size: number
		try {
			const stats = await stat(filePath)
			if (!stats.isFile()) return new Response(null, { status: 404 })
			size = stats.size
		} catch {
			return new Response(null, { status: 404 })
		}

		const contentType = mimeTypeFor(filePath)
		const isHead = request.method === 'HEAD'
		const range = parseRange(request.headers.get('range'), size)

		if (range === 'unsatisfiable') {
			return new Response(null, {
				status: 416,
				headers: { 'content-range': `bytes */${size}` }
			})
		}

		if (!range) {
			return new Response(isHead ? null : bodyFor(filePath), {
				status: 200,
				headers: {
					'content-type': contentType,
					'content-length': String(size),
					'accept-ranges': 'bytes'
				}
			})
		}

		const { start, end } = range
		return new Response(isHead ? null : bodyFor(filePath, start, end), {
			status: 206,
			headers: {
				'content-type': contentType,
				'content-length': String(end - start + 1),
				'content-range': `bytes ${start}-${end}/${size}`,
				'accept-ranges': 'bytes'
			}
		})
	})
}

function bodyFor(filePath: string, start?: number, end?: number): ReadableStream {
	const stream = createReadStream(filePath, start === undefined ? {} : { start, end })
	return Readable.toWeb(stream) as ReadableStream
}

type Range = { start: number; end: number }

/**
 * A single `bytes=` range, inclusive on both ends. Returns null when the header
 * is absent or unparseable (serve the whole file — the spec says ignore a
 * malformed Range), and 'unsatisfiable' when it is well-formed but out of
 * bounds (416). Multi-range requests are deliberately treated as absent:
 * media elements do not send them, and multipart/byteranges is not worth
 * building for a case that never arrives.
 *
 * Exported for tests: this is the piece the editor's seeking depends on.
 */
export function parseRange(header: string | null, size: number): Range | 'unsatisfiable' | null {
	if (!header) return null

	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (!match) return null

	const [, rawStart, rawEnd] = match
	if (rawStart === '' && rawEnd === '') return null

	let start: number
	let end: number

	if (rawStart === '') {
		// Suffix form (`bytes=-500`): the last N bytes. A zero-length suffix is
		// the one case the spec calls unsatisfiable outright.
		const suffix = Number(rawEnd)
		if (suffix === 0) return 'unsatisfiable'
		start = Math.max(0, size - suffix)
		end = size - 1
	} else {
		start = Number(rawStart)
		end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
	}

	// An empty file has no satisfiable range at all.
	if (size === 0 || start >= size || start > end) return 'unsatisfiable'

	return { start, end }
}

// Chromium sniffs very little on a custom scheme, so an honest content-type is
// what decides whether an element will even attempt to decode the response.
const MIME_TYPES: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.avi': 'video/x-msvideo',
	'.mkv': 'video/x-matroska',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.flac': 'audio/flac',
	'.ogg': 'audio/ogg',
	'.opus': 'audio/ogg',
	'.wma': 'audio/x-ms-wma',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.avif': 'image/avif',
	'.bmp': 'image/bmp',
	'.svg': 'image/svg+xml',
	'.srt': 'text/plain; charset=utf-8',
	'.vtt': 'text/vtt',
	'.json': 'application/json'
}

function mimeTypeFor(filePath: string): string {
	return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream'
}
