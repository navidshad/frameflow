import type { Clip, TranscriptHealth } from './types'

/**
 * Detects speech-to-text repetition loops.
 *
 * Every transcription model can get stuck emitting one line over and over —
 * usually over music, crosstalk, or a long ambiguous stretch. The output looks
 * structurally valid (plausible timestamps, well-formed segments), so nothing
 * downstream notices, but the affected span becomes unreadable: the AI editor
 * sees the same sentence a thousand times and concludes nothing happens there.
 *
 * Pure and dependency-free so it can run in main and be unit-tested.
 */

/** A run this long is no longer a coincidence. Mirrors REPEAT_RUN_MIN in editor/context.ts. */
export const LOOP_RUN_MIN = 8
/** …but only call it a loop once it has eaten a meaningful chunk of the source. */
export const LOOP_MIN_SECONDS = 60

const normalize = (text: string | undefined): string =>
	(text || '').replace(/\s+/g, ' ').trim().toLowerCase()

export function analyzeTranscriptHealth(
	clips: Pick<Clip, 'in' | 'out' | 'text'>[],
	silenceText = '[Silence]'
): TranscriptHealth {
	const spoken = clips.filter((c) => {
		const text = normalize(c.text)
		return text.length > 0 && text !== normalize(silenceText)
	})

	const distinct = new Set(spoken.map((c) => normalize(c.text)))
	let maxRepeatRun = 0
	let repeatedText: string | undefined
	let loopedSeconds = 0

	// Walk consecutive runs of identical text. Runs are measured over `spoken`
	// so an interleaved [Silence] piece does not break a loop in two.
	let index = 0
	while (index < spoken.length) {
		const key = normalize(spoken[index].text)
		let end = index
		while (end + 1 < spoken.length && normalize(spoken[end + 1].text) === key) end++
		const length = end - index + 1
		if (length > maxRepeatRun) {
			maxRepeatRun = length
			repeatedText = spoken[index].text
		}
		if (length >= LOOP_RUN_MIN) {
			// Span of the run, not the sum of piece durations: looping transcripts
			// routinely emit overlapping pieces, which would inflate a naive sum.
			loopedSeconds += Math.max(0, spoken[end].out - spoken[index].in)
		}
		index = end + 1
	}

	return {
		segments: clips.length,
		spokenSegments: spoken.length,
		distinctRatio: spoken.length ? distinct.size / spoken.length : 1,
		maxRepeatRun,
		loopedSeconds,
		repeatedText: maxRepeatRun >= LOOP_RUN_MIN ? repeatedText?.slice(0, 120) : undefined,
		looped: maxRepeatRun >= LOOP_RUN_MIN && loopedSeconds >= LOOP_MIN_SECONDS,
		checkedAt: Date.now()
	}
}
