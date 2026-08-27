import { describe, expect, it } from 'vitest'
import { parseRange } from './media-protocol'

const SIZE = 1000

describe('parseRange', () => {
	it('serves the whole file when there is no Range header', () => {
		expect(parseRange(null, SIZE)).toBeNull()
	})

	it('reads a closed range inclusively on both ends', () => {
		// bytes=0-499 is 500 bytes, not 499 — the off-by-one that makes a player
		// stall waiting for a byte that never arrives.
		expect(parseRange('bytes=0-499', SIZE)).toEqual({ start: 0, end: 499 })
		expect(parseRange('bytes=500-999', SIZE)).toEqual({ start: 500, end: 999 })
	})

	it('reads an open-ended range to the last byte', () => {
		// This is the request a <video> opens with.
		expect(parseRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 })
		expect(parseRange('bytes=900-', SIZE)).toEqual({ start: 900, end: 999 })
	})

	it('reads a suffix range as the last N bytes', () => {
		// How a player finds the moov atom in a non-faststart MP4.
		expect(parseRange('bytes=-500', SIZE)).toEqual({ start: 500, end: 999 })
	})

	it('clamps a suffix longer than the file to the whole file', () => {
		expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 })
	})

	it('clamps an end past the last byte', () => {
		expect(parseRange('bytes=0-5000', SIZE)).toEqual({ start: 0, end: 999 })
	})

	it('tolerates surrounding whitespace', () => {
		expect(parseRange('  bytes=0-99  ', SIZE)).toEqual({ start: 0, end: 99 })
	})

	it('ignores a malformed header rather than failing the request', () => {
		for (const header of ['bytes=abc-def', 'items=0-99', 'bytes=', 'bytes=-', '0-99']) {
			expect(parseRange(header, SIZE)).toBeNull()
		}
	})

	it('ignores a multi-range request instead of answering it wrongly', () => {
		// Answering only the first range would be a silent lie about the body.
		expect(parseRange('bytes=0-99,200-299', SIZE)).toBeNull()
	})

	it('reports 416 cases as unsatisfiable', () => {
		expect(parseRange('bytes=1000-', SIZE)).toBe('unsatisfiable')
		expect(parseRange('bytes=2000-3000', SIZE)).toBe('unsatisfiable')
		expect(parseRange('bytes=-0', SIZE)).toBe('unsatisfiable')
		expect(parseRange('bytes=500-499', SIZE)).toBe('unsatisfiable')
	})

	it('treats every range over an empty file as unsatisfiable', () => {
		expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
		expect(parseRange('bytes=0-99', 0)).toBe('unsatisfiable')
	})

	it('serves the single byte of a one-byte file', () => {
		expect(parseRange('bytes=0-', 1)).toEqual({ start: 0, end: 0 })
	})
})
