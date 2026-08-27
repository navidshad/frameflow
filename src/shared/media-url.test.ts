import { describe, expect, it } from 'vitest'
import { fromMediaUrl, toMediaUrl } from './media-url'

/** Every path here must survive the round trip byte-for-byte. */
const roundTrips = (path: string) => expect(fromMediaUrl(toMediaUrl(path))).toBe(path)

describe('toMediaUrl', () => {
	it('encodes a POSIX path under a fixed authority', () => {
		expect(toMediaUrl('/Users/nav/clip.mp4')).toBe('media://local/Users/nav/clip.mp4')
	})

	it('roots a Windows drive path so the drive is never read as a host', () => {
		// The bug this replaces: `media://C:\Users\...` parsed `C` as the hostname.
		expect(toMediaUrl('C:\\Users\\nav\\clip.mp4')).toBe('media://local/C%3A/Users/nav/clip.mp4')
	})

	it('escapes characters the URL parser would otherwise claim', () => {
		const url = toMediaUrl('/tmp/take #2 (final?).mp4')
		expect(url).toBe('media://local/tmp/take%20%232%20(final%3F).mp4')
		// The point of the encoding: nothing after the prefix can start a
		// fragment, a query, or a second path segment.
		expect(url.slice('media://local'.length)).not.toMatch(/[ #?]/)
	})

	it('passes an existing media URL through unchanged', () => {
		const url = 'media://local/Users/nav/clip.mp4'
		expect(toMediaUrl(url)).toBe(url)
	})

	it('maps empty to empty rather than to a bare prefix', () => {
		expect(toMediaUrl('')).toBe('')
	})
})

describe('fromMediaUrl', () => {
	it('passes a bare path through, so callers holding either are safe', () => {
		expect(fromMediaUrl('/Users/nav/clip.mp4')).toBe('/Users/nav/clip.mp4')
	})

	it('drops a query and fragment instead of folding them into the path', () => {
		expect(fromMediaUrl('media://local/Users/nav/clip.mp4?t=3#x')).toBe('/Users/nav/clip.mp4')
	})

	it('does not throw on a segment that was never encoded', () => {
		expect(fromMediaUrl('media://local/tmp/100%.mp4')).toBe('/tmp/100%.mp4')
	})
})

describe('round trip', () => {
	it('preserves plain POSIX paths', () => {
		roundTrips('/Users/nav/clip.mp4')
		roundTrips('/var/folders/T/FrameFlow/media/abc/proxy/p.mp4')
	})

	it('preserves the characters that broke the old concatenation', () => {
		roundTrips('/tmp/take #2.mp4')
		roundTrips('/tmp/what is this?.mp4')
		roundTrips('/tmp/100% done.mp4')
		roundTrips('/tmp/a b  c.mp4')
		roundTrips('/tmp/Café — naïve.mp4')
		roundTrips('/tmp/a&b=c.mp4')
	})

	it('preserves Windows paths, separators included', () => {
		roundTrips('C:\\Users\\nav\\clip.mp4')
		roundTrips('D:\\Media\\take #2.mp4')
	})

	it('preserves UNC paths', () => {
		roundTrips('\\\\nas\\share\\clip.mp4')
	})
})
