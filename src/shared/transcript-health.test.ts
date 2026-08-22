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

	it('flags a transcript that stops long before the file does', () => {
		// The real failure: 117 items covering 15 min of a 43 min recording.
		const health = analyzeTranscriptHealth(
			pieces(['a', 'b', 'c']), { durationSec: 2604 }
		)
		expect(health.truncated).toBe(true)
		expect(health.coverageRatio).toBeLessThan(0.01)
		expect(health.lastSpeechEndSec).toBe(6)
		// It is NOT a loop — this is the case that used to pass every check.
		expect(health.looped).toBe(false)
		expect(health.distinctRatio).toBe(1)
	})

	it('flags a hole in the MIDDLE, which every other measure reads as healthy', () => {
		// One failed transcription window inside a long recording. Coverage looks
		// fine (speech reaches the end), nothing repeats, distinctRatio is 1 —
		// this check is the only thing that can see it.
		const health = analyzeTranscriptHealth([
			{ in: 0, out: 300, text: 'first stretch' },
			{ in: 900, out: 1200, text: 'second stretch' }
		], { durationSec: 1200 })

		expect(health.hasHole).toBe(true)
		expect(health.largestGapSec).toBe(600)
		expect(health.gapAtSec).toBe(300)
		expect(health.truncated).toBe(false)
		expect(health.looped).toBe(false)
		expect(health.distinctRatio).toBe(1)
	})

	it('does not flag ordinary pauses between speech', () => {
		const health = analyzeTranscriptHealth([
			{ in: 0, out: 60, text: 'a' },
			{ in: 75, out: 140, text: 'b' },
			{ in: 150, out: 600, text: 'c' }
		], { durationSec: 600 })
		expect(health.hasHole).toBe(false)
		expect(health.largestGapSec).toBe(15)
	})

	it('does not flag a recording that merely ends on silence', () => {
		const health = analyzeTranscriptHealth(
			[{ in: 0, out: 580, text: 'a long spoken stretch' }, { in: 580, out: 600, text: '[Silence]' }],
			{ durationSec: 600 }
		)
		expect(health.truncated).toBe(false)
		expect(health.coverageRatio).toBeCloseTo(580 / 600, 3)
	})

	it('does not flag audio with no speech at all', () => {
		// Music or ambience: nothing was transcribed because there was nothing to say.
		const health = analyzeTranscriptHealth(
			pieces(['[Silence]', '[Silence]']), { durationSec: 3600 }
		)
		expect(health.spokenSegments).toBe(0)
		expect(health.truncated).toBe(false)
	})

	it('reports no coverage verdict when the duration is unknown', () => {
		const health = analyzeTranscriptHealth(pieces(['a', 'b']))
		expect(health.coverageRatio).toBeUndefined()
		expect(health.truncated).toBe(false)
	})

	it('handles an empty or text-free asset', () => {
		expect(analyzeTranscriptHealth([]).looped).toBe(false)
		expect(analyzeTranscriptHealth(pieces([undefined, undefined])).spokenSegments).toBe(0)
		expect(analyzeTranscriptHealth(pieces([undefined, undefined])).distinctRatio).toBe(1)
	})
})
