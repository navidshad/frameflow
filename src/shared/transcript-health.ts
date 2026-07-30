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

/**
 * Truncation: speech that stops well before the file does. The other way a
 * transcription call fails on long audio — it hits its output ceiling and
 * returns a perfectly well-formed transcript of the first few minutes, which
 * passes every other check.
 */
export const COVERAGE_MIN_RATIO = 0.8
/** Ignore a short tail — plenty of recordings end on silence. */
export const COVERAGE_MIN_GAP_SECONDS = 120

const normalize = (text: string | undefined): string =>
	(text || '').replace(/\s+/g, ' ').trim().toLowerCase()

export function analyzeTranscriptHealth(
	clips: Pick<Clip, 'in' | 'out' | 'text'>[],
	options: { durationSec?: number; silenceText?: string } = {}
): TranscriptHealth {
	const silenceText = options.silenceText ?? '[Silence]'
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

	// Coverage: where does speech stop, relative to the file?
	const durationSec = options.durationSec && options.durationSec > 0 ? options.durationSec : undefined
	const lastSpeechEnd = spoken.length ? Math.max(...spoken.map((c) => c.out)) : 0
	const coverageRatio = durationSec ? Math.min(1, lastSpeechEnd / durationSec) : undefined
	// An asset with NO speech at all (music, ambience) is not truncated — there
	// was nothing to transcribe. Truncation means it started and gave up.
	const truncated = !!durationSec && spoken.length > 0 &&
		coverageRatio! < COVERAGE_MIN_RATIO &&
		durationSec - lastSpeechEnd >= COVERAGE_MIN_GAP_SECONDS

	return {
		segments: clips.length,
		spokenSegments: spoken.length,
		distinctRatio: spoken.length ? distinct.size / spoken.length : 1,
		maxRepeatRun,
		loopedSeconds,
		repeatedText: maxRepeatRun >= LOOP_RUN_MIN ? repeatedText?.slice(0, 120) : undefined,
		looped: maxRepeatRun >= LOOP_RUN_MIN && loopedSeconds >= LOOP_MIN_SECONDS,
		lastSpeechEndSec: spoken.length ? lastSpeechEnd : undefined,
		durationSec,
		coverageRatio,
		truncated,
		checkedAt: Date.now()
	}
}
