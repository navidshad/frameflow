/**
 * The `media://` custom protocol: absolute filesystem path <-> URL.
 *
 * Every image, video and audio element in the renderer loads local media
 * through this scheme, and main serves it from `registerMediaProtocol`.
 *
 * Why a helper instead of the string concatenation this replaces: the old form
 * pasted a raw path straight after `media://`, which is not a valid URL. It
 * broke on any path containing a character URL parsing treats specially — a
 * space, `#`, `?`, `%` — and it broke on Windows entirely, because a drive
 * letter (`media://C:\Users\...`) is not parseable as a host. Electron 33
 * tightened non-special-scheme URL handling, so `C:\...` no longer survives the
 * round trip at all.
 *
 * The form emitted here is `media://local/<percent-encoded POSIX path>`:
 * a fixed authority so the first path segment is never eaten as a hostname,
 * and per-segment encoding so the payload is opaque to the URL parser.
 */

const PREFIX = 'media://local'

/** Leading `/X:` — a Windows drive letter after POSIX normalisation. */
const DRIVE = /^\/[A-Za-z]:(?:\/|$)/

/**
 * Absolute filesystem path -> `media://` URL. Passing a URL through returns it
 * unchanged, so call sites that may hold either can call this unconditionally.
 */
export function toMediaUrl(absPath: string): string {
	if (!absPath) return ''
	if (absPath.startsWith('media://')) return absPath

	// Windows separators to POSIX. A UNC path (\\server\share) becomes
	// //server/share and keeps its doubled root.
	const posix = absPath.replace(/\\/g, '/')
	// A drive-letter path (C:/...) has no root slash; give it one so the result
	// is always an absolute URL pathname.
	const rooted = posix.startsWith('/') ? posix : `/${posix}`

	// Encode per segment: `/` stays structural, everything else is escaped.
	return PREFIX + rooted.split('/').map(encodeURIComponent).join('/')
}

/**
 * `media://` URL -> absolute filesystem path, restoring Windows separators when
 * the path itself says it is one (drive letter or UNC root) — the renderer has
 * no `process.platform` to consult, and the result has to compare equal to the
 * path main handed out in the first place.
 *
 * A bare path passes through unchanged, so this is safe on values that may or
 * may not have been converted.
 */
export function fromMediaUrl(url: string): string {
	if (!url) return ''
	if (!url.startsWith('media://')) return url

	// Take the pathname off the URL rather than slicing the string, so query and
	// fragment (which a filename cannot legitimately produce, but a malformed
	// caller can) are dropped rather than folded into the path.
	let pathname: string
	try {
		pathname = new URL(url).pathname
	} catch {
		pathname = url.slice(PREFIX.length)
	}

	const decoded = pathname.split('/').map(decodeSegment).join('/')

	if (decoded.startsWith('//')) return decoded.replace(/\//g, '\\')   // UNC
	if (DRIVE.test(decoded)) return decoded.slice(1).replace(/\//g, '\\')
	return decoded
}

/** Tolerate a segment that was never encoded rather than throwing on a stray `%`. */
function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment)
	} catch {
		return segment
	}
}
