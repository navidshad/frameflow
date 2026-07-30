import { describe, expect, it } from 'vitest'
import { analyzeTranscriptHealth, LOOP_RUN_MIN } from './transcript-health'

type Piece = { in: number; out: number; text?: string }

/** Contiguous pieces from a list of lines, 2s each. */
const pieces = (lines: (string | undefined)[]): Piece[] =>
	lines.map((text, i) => ({ in: i * 2, out: i * 2 + 2, text }))

const repeat = (text: string, times: number) => new Array(times).fill(text)

describe('analyzeTranscriptHealth', () => {
	it('reports a healthy transcript', () => {
		const health = analyzeTranscriptHealth(
			pieces(['first line', 'second line', 'third line', '[Silence]', 'fourth line'])
		)
		expect(health.looped).toBe(false)
		expect(health.maxRepeatRun).toBe(1)
		expect(health.distinctRatio).toBe(1)
		expect(health.repeatedText).toBeUndefined()
		expect(health.spokenSegments).toBe(4)
	})

	it('flags a long repetition loop and names the line', () => {
		const health = analyzeTranscriptHealth(
			pieces(['intro', ...repeat('the same hallucinated sentence', 200), 'outro'])
		)
		expect(health.looped).toBe(true)
		expect(health.maxRepeatRun).toBe(200)
		expect(health.repeatedText).toBe('the same hallucinated sentence')
		expect(health.loopedSeconds).toBeCloseTo(400, 6)
		expect(health.distinctRatio).toBeLessThan(0.02)
	})

	it('does not flag a short repeated run', () => {
		// A repeated catchphrase is not a transcription failure.
		const health = analyzeTranscriptHealth(pieces(['a', ...repeat('okay', 5), 'b']))
		expect(health.looped).toBe(false)
		expect(health.maxRepeatRun).toBe(5)
	})

	it('does not flag a long run that covers very little audio', () => {
		// 20 identical lines, but only 10s total — a stutter, not a loop.
		const short = new Array(20).fill(0).map((_, i) => ({
			in: i * 0.5, out: i * 0.5 + 0.5, text: 'yeah'
		}))
		const health = analyzeTranscriptHealth(short)
		expect(health.maxRepeatRun).toBe(20)
		expect(health.loopedSeconds).toBeLessThan(60)
		expect(health.looped).toBe(false)
	})

	it('sees through interleaved silence markers', () => {
		// A loop broken up by gap-fill pieces is still one loop.
		const lines: (string | undefined)[] = []
		for (let i = 0; i < LOOP_RUN_MIN * 6; i++) {
			lines.push('looped line')
			if (i % 3 === 0) lines.push('[Silence]')
		}
		const health = analyzeTranscriptHealth(pieces(lines))
		expect(health.maxRepeatRun).toBe(LOOP_RUN_MIN * 6)
		expect(health.looped).toBe(true)
	})

	it('ignores case and whitespace differences', () => {
		const health = analyzeTranscriptHealth(
			pieces(repeat('Same  Line', 40).map((t, i) => (i % 2 ? t.toLowerCase() : t)))
		)
		expect(health.maxRepeatRun).toBe(40)
		expect(health.looped).toBe(true)
	})

	it('measures the loop span, not the sum of overlapping pieces', () => {
		// Looping transcripts emit overlapping timestamps; summing durations would
		// report far more affected audio than actually exists.
		const overlapping = new Array(30).fill(0).map((_, i) => ({
			in: i * 2, out: i * 2 + 4.3, text: 'looped'
		}))
		const health = analyzeTranscriptHealth(overlapping)
		expect(health.loopedSeconds).toBeCloseTo(62.3, 6)   // span, not 129s of summed durations
		expect(health.looped).toBe(true)
	})

	it('handles an empty or text-free asset', () => {
		expect(analyzeTranscriptHealth([]).looped).toBe(false)
		expect(analyzeTranscriptHealth(pieces([undefined, undefined])).spokenSegments).toBe(0)
		expect(analyzeTranscriptHealth(pieces([undefined, undefined])).distinctRatio).toBe(1)
	})
})
