/**
 * Pure helpers for the yt-dlp auto-update path. Deliberately import-free so
 * they unit-test without Electron.
 */

// Errors that look fatal but are NOT staleness — a newer binary won't help,
// so they must never trigger an update+retry cycle. Checked first: a message
// mentioning "Unsupported URL" alongside a 403 is still an unsupported URL.
const NOT_STALE_PATTERNS: RegExp[] = [
	/unsupported url/i, // site not supported by yt-dlp at all
	/video unavailable/i, // removed / private / region-locked video
	/ENOENT/ // binary missing entirely — that's the install flow, not update
]

// The classic symptoms of an outdated yt-dlp: YouTube rotates its streaming
// protocol and old binaries get 403s, extractor failures, nsig-challenge
// failures, or bot checks.
const STALE_PATTERNS: RegExp[] = [
	/http error 403/i,
	/\bforbidden\b/i,
	/unable to extract/i,
	/\bnsig\b/i,
	/sign in to confirm/i
]

/**
 * True when an error message from a yt-dlp run indicates the binary is likely
 * stale (blocked by the site) and a self-update + retry is worth attempting.
 */
export function isStaleYtDlpError(message: string | null | undefined): boolean {
	if (!message) return false
	const text = String(message)
	if (NOT_STALE_PATTERNS.some((re) => re.test(text))) return false
	return STALE_PATTERNS.some((re) => re.test(text))
}

/** Parses a "2025.08.11"-style yt-dlp version tag into numeric segments. */
function parseVersionTag(tag: string | null | undefined): number[] | null {
	if (!tag) return null
	const cleaned = String(tag).trim().replace(/^v/i, '')
	if (!/^\d+(\.\d+)*$/.test(cleaned)) return null
	return cleaned.split('.').map((n) => parseInt(n, 10))
}

/**
 * True when `latest` is strictly newer than `local`. Segment-wise numeric
 * compare (NOT lexicographic: "2025.10.x" > "2025.9.x"); missing trailing
 * segments count as 0. Unparseable input on either side → false, so garbage
 * never triggers a download.
 */
export function isNewerYtDlpVersion(
	latest: string | null | undefined,
	local: string | null | undefined
): boolean {
	const a = parseVersionTag(latest)
	const b = parseVersionTag(local)
	if (!a || !b) return false
	const len = Math.max(a.length, b.length)
	for (let i = 0; i < len; i++) {
		const x = a[i] ?? 0
		const y = b[i] ?? 0
		if (x !== y) return x > y
	}
	return false
}
