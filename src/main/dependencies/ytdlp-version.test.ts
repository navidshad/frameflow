import { describe, expect, it } from 'vitest'
import { isNewerYtDlpVersion, isStaleYtDlpError } from './ytdlp-version'

describe('isStaleYtDlpError', () => {
	const stale = [
		// The exact symptom that motivated the feature
		'yt-dlp exited with code 1: HTTP Error 403: Forbidden',
		'ERROR: unable to download video data: HTTP Error 403: Forbidden',
		'HTTP Error 403',
		'ERROR: fragment 1 not found, server said: Forbidden',
		'ERROR: [youtube] dQw4w9WgXcQ: Unable to extract uploader id',
		'WARNING: [youtube] nsig extraction failed: Some formats may be missing',
		"ERROR: [youtube] abc123: Sign in to confirm you're not a bot.",
		// downloadVideo re-wraps messages — the signal must survive wrapping
		'yt-dlp download failed: ERROR: unable to download video data: HTTP Error 403: Forbidden',
		'Failed to fetch video formats: HTTP Error 403: Forbidden'
	]
	for (const message of stale) {
		it(`matches: ${message}`, () => {
			expect(isStaleYtDlpError(message)).toBe(true)
		})
	}

	const notStale = [
		'Unsupported URL: https://example.com/page',
		'Unsupported URL: yt-dlp does not support this website.',
		'spawn /Users/x/Library/Application Support/frameflow/bin/yt-dlp_macos ENOENT',
		'ERROR: [youtube] abc123: Video unavailable',
		'ERROR: [youtube] abc123: Private video',
		'URL is not a single video (possible playlist or channel)',
		'getaddrinfo ENOTFOUND www.youtube.com',
		'No files found in temp folder after download',
		''
	]
	for (const message of notStale) {
		it(`does not match: ${message || '(empty)'}`, () => {
			expect(isStaleYtDlpError(message)).toBe(false)
		})
	}

	it('does not match null/undefined', () => {
		expect(isStaleYtDlpError(null)).toBe(false)
		expect(isStaleYtDlpError(undefined)).toBe(false)
	})

	it('lets non-stale markers win over stale ones', () => {
		// An unavailable video stays unavailable no matter how new the binary is.
		expect(isStaleYtDlpError('ERROR: Video unavailable (HTTP Error 403: Forbidden)')).toBe(false)
		expect(isStaleYtDlpError('Unsupported URL: server said Forbidden')).toBe(false)
	})
})

describe('isNewerYtDlpVersion', () => {
	it('compares calendar-style tags numerically', () => {
		expect(isNewerYtDlpVersion('2025.08.11', '2025.06.09')).toBe(true)
		expect(isNewerYtDlpVersion('2025.06.09', '2025.08.11')).toBe(false)
		expect(isNewerYtDlpVersion('2026.01.01', '2025.12.30')).toBe(true)
	})

	it('is numeric, not lexicographic', () => {
		// Lexicographically "10" < "9" — must not fall for that.
		expect(isNewerYtDlpVersion('2025.10.01', '2025.9.30')).toBe(true)
		expect(isNewerYtDlpVersion('2025.9.30', '2025.10.01')).toBe(false)
	})

	it('returns false for equal versions', () => {
		expect(isNewerYtDlpVersion('2025.08.11', '2025.08.11')).toBe(false)
	})

	it('treats missing trailing segments as zero', () => {
		// Nightly-style four-segment tags
		expect(isNewerYtDlpVersion('2025.08.11.232920', '2025.08.11')).toBe(true)
		expect(isNewerYtDlpVersion('2025.08.11', '2025.08.11.232920')).toBe(false)
		expect(isNewerYtDlpVersion('2025.08.11.0', '2025.08.11')).toBe(false)
	})

	it('tolerates a leading v and surrounding whitespace', () => {
		expect(isNewerYtDlpVersion('v2025.08.11', '2025.06.09')).toBe(true)
		expect(isNewerYtDlpVersion('2025.08.11', ' 2025.06.09\n')).toBe(true)
	})

	it('never updates on unparseable input', () => {
		expect(isNewerYtDlpVersion('latest', '2025.06.09')).toBe(false)
		expect(isNewerYtDlpVersion('2025.08.11', 'unknown')).toBe(false)
		expect(isNewerYtDlpVersion(undefined, '2025.06.09')).toBe(false)
		expect(isNewerYtDlpVersion('2025.08.11', null)).toBe(false)
		expect(isNewerYtDlpVersion('', '')).toBe(false)
		expect(isNewerYtDlpVersion('2025..08', '2025.06.09')).toBe(false)
	})
})
