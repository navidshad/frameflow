import { describe, expect, it } from 'vitest'
import {
	CHUNK_TARGET_SEC, mergeChunkTranscripts, planChunks, rebaseChunkItems,
	secondsToTimestamp, sliceTranscriptForChunk, timestampToSeconds, type TranscriptItem
} from './transcript-chunks'

const item = (start: string, end: string, text: string): TranscriptItem => ({ start, end, text })

describe('timestamps', () => {
	it('round-trips', () => {
		for (const seconds of [0, 1.5, 59.999, 60, 919.2, 2610.3, 3661.007]) {
			expect(timestampToSeconds(secondsToTimestamp(seconds))).toBeCloseTo(seconds, 3)
		}
	})

	it('parses the formats the model emits', () => {
		expect(timestampToSeconds('00:00:05,000')).toBe(5)
		expect(timestampToSeconds('00:15:19.200')).toBeCloseTo(919.2, 3)
		expect(timestampToSeconds('1:02:03,500')).toBeCloseTo(3723.5, 3)
	})

	it('does not emit a 1000ms field when rounding carries', () => {
		expect(secondsToTimestamp(9.9999)).toBe('00:00:10,000')
	})
})

describe('planChunks', () => {
	it('keeps short audio as a single call', () => {
		expect(planChunks(321)).toEqual([{ index: 0, start: 0, end: 321 }])
		expect(planChunks(CHUNK_TARGET_SEC)).toHaveLength(1)
	})

	it('covers long audio with no gaps and no overlaps', () => {
		const chunks = planChunks(2610)
		expect(chunks.length).toBeGreaterThan(1)
		expect(chunks[0].start).toBe(0)
		expect(chunks[chunks.length - 1].end).toBe(2610)
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i].start).toBe(chunks[i - 1].end)
		}
	})

	it('absorbs a short tail rather than making a sliver chunk', () => {
		// 15:30 would otherwise leave a 30s final chunk.
		const chunks = planChunks(CHUNK_TARGET_SEC + 30)
		expect(chunks).toHaveLength(1)
		expect(chunks[0].end).toBe(CHUNK_TARGET_SEC + 30)
	})

	it('handles an unknown duration', () => {
		expect(planChunks(0)).toEqual([])
	})
})

describe('rebaseChunkItems', () => {
	it('shifts chunk-relative times onto the original timeline', () => {
		const rebased = rebaseChunkItems(
			[item('00:00:02,000', '00:00:05,000', 'hello')],
			{ index: 1, start: 900, end: 1800 }
		)
		expect(rebased).toEqual([item('00:15:02,000', '00:15:05,000', 'hello')])
	})

	it('drops items the model invented past the end of its window', () => {
		// A model that keeps numbering past the audio it was given would
		// otherwise collide with the next chunk's real content.
		const rebased = rebaseChunkItems([
			item('00:00:01,000', '00:00:03,000', 'real'),
			item('00:20:00,000', '00:20:05,000', 'hallucinated past the window')
		], { index: 0, start: 0, end: 900 })
		expect(rebased).toHaveLength(1)
		expect(rebased[0].text).toBe('real')
	})

	it('clamps an item that overruns the window edge', () => {
		const rebased = rebaseChunkItems(
			[item('00:14:58,000', '00:15:10,000', 'over the edge')],
			{ index: 0, start: 0, end: 900 }
		)
		expect(rebased[0].end).toBe('00:15:00,000')
	})
})

describe('mergeChunkTranscripts', () => {
	it('orders by time across chunks', () => {
		const merged = mergeChunkTranscripts([
			[item('00:15:00,000', '00:15:02,000', 'second half')],
			[item('00:00:01,000', '00:00:02,000', 'first half')]
		])
		expect(merged.map((i) => i.text)).toEqual(['first half', 'second half'])
	})

	it('drops a line repeated across a chunk seam', () => {
		const merged = mergeChunkTranscripts([
			[item('00:14:59,000', '00:15:00,000', 'crossing the boundary')],
			[item('00:14:59,500', '00:15:01,000', 'Crossing the  boundary')]
		])
		expect(merged).toHaveLength(1)
	})

	it('keeps a genuine repeat far apart in time', () => {
		const merged = mergeChunkTranscripts([
			[item('00:00:01,000', '00:00:02,000', 'okay')],
			[item('00:20:01,000', '00:20:02,000', 'okay')]
		])
		expect(merged).toHaveLength(2)
	})
})

describe('sliceTranscriptForChunk', () => {
	it('returns the overlapping items, re-based to chunk time', () => {
		const prior = [
			item('00:00:10,000', '00:00:12,000', 'before'),
			item('00:15:30,000', '00:15:32,000', 'inside'),
			item('00:40:00,000', '00:40:02,000', 'after')
		]
		const sliced = sliceTranscriptForChunk(prior, { index: 1, start: 900, end: 1800 })
		expect(sliced).toEqual([item('00:00:30,000', '00:00:32,000', 'inside')])
	})
})
