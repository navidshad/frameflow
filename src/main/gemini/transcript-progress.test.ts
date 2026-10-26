import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	describeTranscriptProgress, formatElapsed, trackTranscriptProgress, transcriptPercent,
	TRANSCRIPT_BAR_END, TRANSCRIPT_BAR_START, TRANSCRIPT_HEARTBEAT_MS, type TranscriptProgress
} from './transcript-progress'

const at = (p: Partial<TranscriptProgress>): TranscriptProgress => ({ done: 0, total: 5, active: [], ...p })

describe('transcriptPercent', () => {
	it('starts where the step left the bar and ends where the pieces begin', () => {
		expect(transcriptPercent(at({}))).toBe(TRANSCRIPT_BAR_START)
		expect(transcriptPercent(at({ done: 5 }))).toBe(TRANSCRIPT_BAR_END)
	})

	it('moves with every finished window, so a 5-part file is not stuck at 10%', () => {
		const bars = [0, 1, 2, 3, 4, 5].map((done) => transcriptPercent(at({ done })))
		expect(bars).toEqual([...bars].sort((a, b) => a - b))
		expect(new Set(bars).size).toBe(6)
	})

	it('gives a little credit for a window in flight, never as much as a finished one', () => {
		const idle = transcriptPercent(at({ done: 1 }))
		const sending = transcriptPercent(at({ done: 1, active: ['transcribing', 'transcribing'] }))
		const finished = transcriptPercent(at({ done: 3 }))
		expect(sending).toBeGreaterThan(idle)
		expect(sending).toBeLessThan(finished)
	})

	it('treats a lone window as 0 to 1 too', () => {
		expect(transcriptPercent({ done: 0, total: 1, active: ['uploading'] })).toBeGreaterThan(TRANSCRIPT_BAR_START)
		expect(transcriptPercent({ done: 1, total: 1, active: [] })).toBe(TRANSCRIPT_BAR_END)
	})

	it('does not divide by zero or overshoot', () => {
		expect(transcriptPercent({ done: 0, total: 0, active: [] })).toBe(TRANSCRIPT_BAR_START)
		expect(transcriptPercent({ done: 9, total: 5, active: ['cutting'] })).toBe(TRANSCRIPT_BAR_END)
	})
})

describe('describeTranscriptProgress', () => {
	it('says how many parts are done, what the others are doing, and how long it has been', () => {
		const { status } = describeTranscriptProgress(at({ done: 2, active: ['transcribing', 'uploading', 'transcribing'] }), 7 * 60)
		expect(status).toBe('Transcribing: 2 of 5 parts done · uploading 1, transcribing 2 · 7 min')
	})

	it('reads plainly for a file sent whole', () => {
		const { status } = describeTranscriptProgress({ done: 0, total: 1, active: ['uploading'] }, 12)
		expect(status).toBe('Transcribing: Sending the audio · uploading · 12 s')
	})

	it('names the finishing stage', () => {
		expect(describeTranscriptProgress(at({ done: 5, finishing: true }), 600).status).toBe('Joining the parts · 10 min')
	})

	it('carries the same percent the bar uses', () => {
		const p = at({ done: 3, active: ['transcribing'] })
		expect(describeTranscriptProgress(p, 0).percent).toBe(transcriptPercent(p))
	})
})

describe('formatElapsed', () => {
	it('is seconds under a minute and a half, minutes after', () => {
		expect([0, 45, 89, 90, 600, -3].map(formatElapsed)).toEqual(['0 s', '45 s', '89 s', '2 min', '10 min', '0 s'])
	})
})

describe('trackTranscriptProgress', () => {
	afterEach(() => vi.useRealTimers())

	it('writes each report at once and repeats the last one on a timer with the clock moved on', () => {
		vi.useFakeTimers()
		let clock = 0
		const lines: { status: string; progress?: number }[] = []
		const tracker = trackTranscriptProgress(
			{ updateStatus: (status, progress) => { lines.push({ status, progress }) } },
			() => clock
		)
		tracker.onProgress(at({ done: 1, active: ['transcribing'] }))
		expect(lines).toHaveLength(1)
		expect(lines[0].progress).toBeGreaterThan(TRANSCRIPT_BAR_START)

		clock = 5 * 60_000
		vi.advanceTimersByTime(TRANSCRIPT_HEARTBEAT_MS)
		expect(lines).toHaveLength(2)
		expect(lines[1].status).toContain('5 min')
		expect(lines[1].status).toContain('1 of 5 parts done')

		tracker.stop()
		vi.advanceTimersByTime(TRANSCRIPT_HEARTBEAT_MS * 4)
		expect(lines).toHaveLength(2)
	})

	it('says nothing before the first report', () => {
		vi.useFakeTimers()
		const updateStatus = vi.fn()
		const tracker = trackTranscriptProgress({ updateStatus })
		vi.advanceTimersByTime(TRANSCRIPT_HEARTBEAT_MS * 3)
		expect(updateStatus).not.toHaveBeenCalled()
		tracker.stop()
	})
})
