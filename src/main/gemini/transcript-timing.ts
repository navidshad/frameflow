/**
 * Transcript timing: keep segment times on the speech, not on the model's guess.
 *
 * A general-purpose model asked for timestamps writes them as text, and over
 * long audio they drift: a 9-minute vlog came back squeezed into 6 minutes,
 * and even 60-second windows were off by up to 12 s. What fixes it:
 *
 *  - measure where speech starts and stops from the audio itself (loudness
 *    frames → pauses), with a threshold set from the file's own levels;
 *  - cut long audio into windows in the middle of a pause, so no word is split
 *    and each window's times restart from a known point;
 *  - with a word-timestamp engine, build segments from the words;
 *  - nudge each segment start onto a nearby speech onset, never further than a
 *    bounded window (so a bad guess cannot jump to a different sentence);
 *  - check the result against the pauses and flag what does not fit: phrase
 *    starts with no onset near them (drift), text over silence (invented), and
 *    a line that repeats its neighbour (seam echo or loop).
 *
 * Pure and dependency-free so all of it can be tested with fixtures.
 */

import type { AudioChunk } from './transcript-chunks'
import type { TranscriptTiming } from '../../shared/types'

export interface Pause { start: number; end: number }
export interface TimedWord { start: number; end: number; text: string }
export interface TimedItem { start: number; end: number; text: string; words?: TimedWord[] }

/** Loudness frame length used by measureLoudness in ffmpeg/index.ts. */
export const LOUDNESS_FRAME_SEC = 0.05
/** Shorter dips are breaths between syllables, not pauses. */
export const MIN_PAUSE_SEC = 0.2
/** A start this close to an onset counts as on the speech. */
export const ALIGNED_SEC = 0.3
/** A phrase start further than this from any onset is drift. */
export const DRIFT_SEC = 1.0
/** A gap this long before a segment means it should begin at an onset. */
export const PHRASE_GAP_SEC = 0.3

const percentile = (sorted: number[], p: number) =>
	sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))] : NaN

/**
 * Silence threshold from the file's own loudness: a third of the way from the
 * noise floor (10th percentile) to typical speech (median). A fixed -35 dB
 * misses pauses in a noisy room and finds them inside quiet speech.
 */
export function adaptiveThresholdDb(levelsDb: number[]): number {
	const finite = levelsDb.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
	if (finite.length < 20) return -40
	const floor = percentile(finite, 0.1)
	const speech = percentile(finite, 0.5)
	// A flat file (all music, all silence) has no gap to split; fall back.
	if (speech - floor < 6) return Math.min(-40, floor - 1)
	return floor + (speech - floor) / 3
}

/** Half-width of the rolling window that sets the local threshold. */
export const LOCAL_WINDOW_SEC = 3

/**
 * Per-frame silence threshold from the loudness around it (±3 s): a third of
 * the way from the local floor to the local loud level (90th percentile).
 * Outdoor footage drifts by 10 dB or more as traffic and wind come and go; a
 * single threshold for the file finds no pauses at all in the noisy parts.
 * Where the window is flat (no contrast to split), fall back to the file's
 * own threshold.
 */
export function localThresholdsDb(levelsDb: number[], frameSec = LOUDNESS_FRAME_SEC): number[] {
	const global = adaptiveThresholdDb(levelsDb)
	const half = Math.max(1, Math.round(LOCAL_WINDOW_SEC / frameSec))
	const stride = Math.max(1, Math.round(0.5 / frameSec))
	const out = new Array<number>(levelsDb.length)
	for (let center = 0; center < levelsDb.length; center += stride) {
		const window: number[] = []
		for (let i = Math.max(0, center - half); i < Math.min(levelsDb.length, center + half); i++) {
			if (Number.isFinite(levelsDb[i])) window.push(levelsDb[i])
		}
		window.sort((a, b) => a - b)
		let threshold = global
		if (window.length >= half / 2) {
			const floor = percentile(window, 0.1)
			const loud = percentile(window, 0.9)
			if (loud - floor >= 8) threshold = floor + (loud - floor) / 3
		}
		for (let i = center; i < Math.min(levelsDb.length, center + stride); i++) out[i] = threshold
	}
	return out
}

/**
 * Runs of quiet frames that last at least minPauseSec. Quiet is judged
 * against the local threshold unless a fixed thresholdDb is given.
 */
export function findPauses(
	levelsDb: number[],
	options: { frameSec?: number; thresholdDb?: number; minPauseSec?: number } = {}
): Pause[] {
	const frameSec = options.frameSec ?? LOUDNESS_FRAME_SEC
	const thresholds = options.thresholdDb !== undefined
		? levelsDb.map(() => options.thresholdDb!)
		: localThresholdsDb(levelsDb, frameSec)
	const minPause = options.minPauseSec ?? MIN_PAUSE_SEC
	const pauses: Pause[] = []
	let runStart = -1
	const close = (endFrame: number) => {
		if (runStart < 0) return
		const start = runStart * frameSec
		const end = endFrame * frameSec
		if (end - start >= minPause - 1e-9) pauses.push({ start: round3(start), end: round3(end) })
		runStart = -1
	}
	for (let i = 0; i < levelsDb.length; i++) {
		// -inf (digital silence) is below any threshold.
		const quiet = !(levelsDb[i] > thresholds[i])
		if (quiet && runStart < 0) runStart = i
		else if (!quiet) close(i)
	}
	close(levelsDb.length)
	return pauses
}

/** Where speech resumes: the end of every pause that is not the end of the file. */
export function speechOnsets(pauses: Pause[], durationSec = Infinity): number[] {
	return pauses.map((p) => p.end).filter((t) => t < durationSec - 0.05)
}

/**
 * Windows over [0, duration) cut in the middle of the longest pause found
 * between minSec and maxSec into the window. A window with no pause in that
 * range is cut hard at maxSec — rare in speech, and still correct, just with a
 * word possibly split at the seam (the stitcher drops the echo).
 */
export function planWindowsAtPauses(
	durationSec: number,
	pauses: Pause[],
	options: { targetSec: number; maxSec: number }
): AudioChunk[] {
	if (!(durationSec > 0)) return []
	const { targetSec, maxSec } = options
	if (durationSec <= maxSec) return [{ index: 0, start: 0, end: durationSec }]
	const chunks: AudioChunk[] = []
	let start = 0
	while (durationSec - start > maxSec) {
		const lo = start + targetSec * 0.75
		const hi = start + maxSec
		let best: Pause | undefined
		for (const p of pauses) {
			const mid = (p.start + p.end) / 2
			if (mid <= lo || mid >= hi) continue
			// Prefer the longest pause; break ties toward the target length.
			if (!best || p.end - p.start > best.end - best.start + 1e-6 ||
				(Math.abs(p.end - p.start - (best.end - best.start)) < 1e-6 &&
					Math.abs(mid - start - targetSec) < Math.abs((best.start + best.end) / 2 - start - targetSec))) {
				best = p
			}
		}
		const end = best ? round3((best.start + best.end) / 2) : hi
		chunks.push({ index: chunks.length, start, end })
		start = end
	}
	chunks.push({ index: chunks.length, start, end: durationSec })
	return chunks
}

/** Sentence-final marks, Latin and Arabic-script (؟ is the Persian/Arabic question mark). */
const SENTENCE_END = /[.!?؟…。！？۔]["'”»)]*$/

/**
 * Words → caption-sized segments. Break after a sentence-final mark, at a
 * pause between words, or when a segment gets too long to read.
 */
export function groupWordsIntoSegments(
	words: TimedWord[],
	options: { maxGapSec?: number; maxSec?: number; maxWords?: number } = {}
): TimedItem[] {
	const maxGap = options.maxGapSec ?? 0.6
	const maxSec = options.maxSec ?? 12
	const maxWords = options.maxWords ?? 40
	const segments: TimedItem[] = []
	let current: TimedWord[] = []
	const flush = () => {
		if (!current.length) return
		segments.push({
			start: current[0].start,
			end: Math.max(current[current.length - 1].end, current[0].start),
			text: current.map((w) => w.text).join(' '),
			words: current
		})
		current = []
	}
	for (const word of words) {
		if (!word.text?.trim()) continue
		const previous = current[current.length - 1]
		if (previous) {
			const gap = word.start - previous.end
			const tooLong = word.end - current[0].start > maxSec || current.length >= maxWords
			if (gap >= maxGap || tooLong) flush()
		}
		current.push(word)
		if (SENTENCE_END.test(word.text.trim())) flush()
	}
	flush()
	return segments
}

/** Is t inside a pause? Returns that pause. Pauses must be sorted. */
function pauseAt(pauses: Pause[], t: number): Pause | undefined {
	let lo = 0, hi = pauses.length - 1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		if (pauses[mid].end <= t) lo = mid + 1
		else if (pauses[mid].start > t) hi = mid - 1
		else return pauses[mid]
	}
	return undefined
}

/** Nearest value in a sorted list, or undefined when the list is empty. */
function nearest(sorted: number[], t: number): number | undefined {
	if (!sorted.length) return undefined
	let lo = 0, hi = sorted.length - 1
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (sorted[mid] < t) lo = mid + 1
		else hi = mid
	}
	const after = sorted[lo]
	const before = lo > 0 ? sorted[lo - 1] : undefined
	if (before === undefined) return after
	return Math.abs(before - t) <= Math.abs(after - t) ? before : after
}

/**
 * Move each segment start onto the nearest speech onset within windowSec.
 * A start inside a pause moves forward to where the pause ends (speech cannot
 * start in silence). Starts never move past their segment's end or before
 * the previous segment's start, so order is kept.
 */
export function snapStartsToOnsets(
	items: TimedItem[],
	pauses: Pause[],
	options: { windowSec: number; durationSec?: number }
): { items: TimedItem[]; snapped: number } {
	const sortedPauses = [...pauses].sort((a, b) => a.start - b.start)
	const onsets = speechOnsets(sortedPauses, options.durationSec)
	let snapped = 0
	let previousStart = -Infinity
	const out = items.map((item) => {
		let start = item.start
		const inPause = pauseAt(sortedPauses, start)
		if (inPause && inPause.end - start <= options.windowSec) {
			start = inPause.end
		} else {
			const near = nearest(onsets, start)
			if (near !== undefined && Math.abs(near - start) <= options.windowSec) start = near
		}
		// Keep the segment non-empty and in order.
		if (start >= item.end - 0.05) start = item.start
		if (start < previousStart) start = Math.max(item.start, previousStart)
		if (Math.abs(start - item.start) > 1e-6) snapped++
		previousStart = start
		return start === item.start ? item : { ...item, start: round3(start) }
	})
	return { items: out, snapped }
}

const normalizeText = (text: string) =>
	(text || '').normalize('NFKC').replace(/[‌‍]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase()

/** True when one line is the other, or wholly contained in it (seam echo). */
export function isEcho(a: string, b: string): boolean {
	const x = normalizeText(a), y = normalizeText(b)
	if (!x || !y) return false
	if (x === y) return true
	const [short, long] = x.length <= y.length ? [x, y] : [y, x]
	return short.length >= 8 && long.includes(short)
}

/**
 * Join per-window results onto the source timeline: re-base, drop anything
 * the model put outside its window, and drop a line at a seam that echoes the
 * line across it.
 */
export function stitchWindows(windows: { chunk: AudioChunk; items: TimedItem[] }[]): TimedItem[] {
	const out: TimedItem[] = []
	for (const { chunk, items } of [...windows].sort((a, b) => a.chunk.start - b.chunk.start)) {
		const span = chunk.end - chunk.start
		const rebased = items
			.filter((it) => it.end > it.start && it.start <= span + 0.5)
			.map((it) => ({
				...it,
				start: round3(chunk.start + it.start),
				end: round3(chunk.start + Math.min(it.end, span)),
				words: it.words?.map((w) => ({ ...w, start: round3(chunk.start + w.start), end: round3(chunk.start + Math.min(w.end, span)) }))
			}))
		const seam = chunk.start
		for (const item of rebased) {
			const previous = out[out.length - 1]
			// Only within a few seconds of a seam: elsewhere a repeated line is
			// real speech (or a loop the health check reports), not an echo.
			if (previous && seam > 0 && item.start - seam < 3 && seam - previous.end < 3 &&
				isEcho(previous.text, item.text)) continue
			out.push(item)
		}
	}
	return out
}

/** Seconds of [start, end) that fall inside pauses. Pauses must be sorted. */
function silentSeconds(pauses: Pause[], start: number, end: number): number {
	let total = 0
	for (const p of pauses) {
		if (p.end <= start) continue
		if (p.start >= end) break
		total += Math.min(end, p.end) - Math.max(start, p.start)
	}
	return total
}

const isMarker = (text: string) => /^\s*[\[(].*[\])]\s*$/.test(text || '')

/** Sound this long with no transcript over it is worth reporting. */
export const UNTRANSCRIBED_MIN_SEC = 5

/**
 * Stretches of sound that no segment covers. Sound separated by pauses
 * shorter than a second counts as one stretch. A transcript whose times are
 * squeezed leaves exactly this behind: text bunched early, then speech with
 * nothing over it.
 */
export function untranscribedStretches(
	items: TimedItem[],
	pauses: Pause[],
	durationSec: number,
	minSec = UNTRANSCRIBED_MIN_SEC
): Pause[] {
	const sortedPauses = [...pauses].sort((a, b) => a.start - b.start)
	// Sound = the complement of pauses longer than a second.
	const sound: Pause[] = []
	let cursor = 0
	for (const p of sortedPauses) {
		if (p.end - p.start < 1) continue
		if (p.start > cursor) sound.push({ start: cursor, end: p.start })
		cursor = Math.max(cursor, p.end)
	}
	if (durationSec > cursor) sound.push({ start: cursor, end: durationSec })

	const covered = [...items].filter((it) => it.text?.trim()).sort((a, b) => a.start - b.start)
	const out: Pause[] = []
	for (const run of sound) {
		let from = run.start
		for (const it of covered) {
			if (it.end + 0.5 <= from) continue
			if (it.start - 0.5 >= run.end) break
			if (it.start - 0.5 - from >= minSec) out.push({ start: round3(from), end: round3(it.start - 0.5) })
			from = Math.max(from, it.end + 0.5)
		}
		if (run.end - from >= minSec) out.push({ start: round3(from), end: round3(run.end) })
	}
	return out
}

/** A model-written start further than this from where its text should fall is drift. */
export const PACE_DISAGREE_SEC = 4

/**
 * Where each segment would start if the window's speech ran at an even pace:
 * spread the window's text over its measured sound by character count. Too
 * rough to set times with (music or B-roll in a window throws it off), but a
 * model-written time that lands far from it is worth flagging — that is what
 * a squeezed window looks like.
 */
export function paceEstimates(items: TimedItem[], pauses: Pause[], windows: AudioChunk[]): (number | undefined)[] {
	const sortedPauses = [...pauses].sort((a, b) => a.start - b.start)
	const estimates: (number | undefined)[] = items.map(() => undefined)
	for (const w of windows) {
		const sound: Pause[] = []
		let cursor = w.start
		for (const p of sortedPauses) {
			if (p.end <= w.start || p.start >= w.end) continue
			if (p.start > cursor) sound.push({ start: cursor, end: p.start })
			cursor = Math.max(cursor, p.end)
		}
		if (w.end > cursor) sound.push({ start: cursor, end: w.end })
		const total = sound.reduce((n, r) => n + r.end - r.start, 0)
		const members = items.map((it, i) => ({ it, i })).filter(({ it }) => it.start >= w.start - 0.5 && it.start < w.end)
		const lengths = members.map(({ it }) => Math.max(1, it.text.replace(/\s+/g, '').length))
		const chars = lengths.reduce((n, l) => n + l, 0)
		if (!total || !chars) continue
		let done = 0
		members.forEach(({ i }, k) => {
			let target = (done / chars) * total
			let at = sound[sound.length - 1].end
			for (const r of sound) {
				if (target < r.end - r.start) { at = r.start + target; break }
				target -= r.end - r.start
			}
			estimates[i] = at
			done += lengths[k]
		})
	}
	return estimates
}

/**
 * Score segment times against the audio. Pass the times as the engine gave
 * them, BEFORE snapping — snapped starts sit on onsets by construction and
 * would always look aligned.
 *
 * Two signals: segments that follow a clear gap should start at a speech
 * onset, and sound should not go long without text over it. Either failing
 * widely means the times do not follow the speech.
 */
export function assessTiming(
	items: TimedItem[],
	pauses: Pause[],
	options: {
		durationSec?: number
		engine: TranscriptTiming['engine']
		language?: string
		snapped?: number
		/** The windows the engine ran over; enables the pace check for model-written times. */
		windows?: AudioChunk[]
	}
): TranscriptTiming {
	const sortedPauses = [...pauses].sort((a, b) => a.start - b.start)
	const onsets = speechOnsets(sortedPauses, options.durationSec)
	const spoken = items.filter((it) => it.text?.trim() && !isMarker(it.text))
	const offsets: number[] = []
	const driftAtSec: number[] = []
	const silentTextAtSec: number[] = []
	const repeatedAtSec: number[] = []

	for (let i = 0; i < spoken.length; i++) {
		const item = spoken[i]
		const previous = spoken[i - 1]
		const followsGap = !previous || item.start - previous.end >= PHRASE_GAP_SEC
		if (followsGap && onsets.length && item.start > 0.5) {
			const near = nearest(onsets, item.start)!
			const offset = Math.abs(near - item.start)
			offsets.push(offset)
			if (offset > DRIFT_SEC) driftAtSec.push(round3(item.start))
		}
		const span = item.end - item.start
		if (span >= 0.8 && silentSeconds(sortedPauses, item.start, item.end) / span >= 0.8) {
			silentTextAtSec.push(round3(item.start))
		}
		if (previous && isEcho(previous.text, item.text)) repeatedAtSec.push(round3(item.start))
	}

	// Model-written times only: measured word times do not need a pace check,
	// and an uneven speaker would make it cry wolf.
	let paceChecked = 0
	let paceOff = 0
	if (options.engine === 'segments' && options.windows?.length && pauses.length) {
		const estimates = paceEstimates(spoken, sortedPauses, options.windows)
		estimates.forEach((estimate, i) => {
			if (estimate === undefined) return
			paceChecked++
			if (Math.abs(estimate - spoken[i].start) > PACE_DISAGREE_SEC) {
				paceOff++
				if (!driftAtSec.includes(round3(spoken[i].start))) driftAtSec.push(round3(spoken[i].start))
			}
		})
		driftAtSec.sort((a, b) => a - b)
	}

	const duration = options.durationSec ?? (spoken.length ? Math.max(...spoken.map((it) => it.end)) : 0)
	const untranscribed = pauses.length ? untranscribedStretches(spoken, sortedPauses, duration) : []
	const untranscribedSec = untranscribed.reduce((n, r) => n + r.end - r.start, 0)
	const spokenSec = spoken.reduce((n, it) => n + Math.max(0, it.end - it.start), 0)

	const sorted = [...offsets].sort((a, b) => a - b)
	const aligned = offsets.filter((o) => o <= ALIGNED_SEC).length
	const alignedRatio = offsets.length ? aligned / offsets.length : 1
	const medianOnsetOffsetSec = offsets.length ? round3(percentile(sorted, 0.5)) : 0
	// Too few phrase starts to judge says nothing either way.
	const judged = offsets.length >= 8
	const offOnsets = judged && (alignedRatio < 0.5 || medianOnsetOffsetSec > 0.6 ||
		driftAtSec.length - paceOff > offsets.length * 0.25)
	const offPace = paceChecked >= 8 && paceOff > paceChecked * 0.15
	const gapsInText = spokenSec > 60 && untranscribedSec > 0.1 * (spokenSec + untranscribedSec)

	return {
		engine: options.engine,
		language: options.language,
		phraseStartsChecked: offsets.length,
		alignedRatio: round3(alignedRatio),
		medianOnsetOffsetSec,
		snapped: options.snapped ?? 0,
		drift: offOnsets || offPace || gapsInText,
		driftAtSec: driftAtSec.slice(0, 50),
		silentTextAtSec: silentTextAtSec.slice(0, 50),
		repeatedAtSec: repeatedAtSec.slice(0, 50),
		untranscribedSec: round3(untranscribedSec),
		untranscribedAtSec: untranscribed.slice(0, 50).map((r) => r.start)
	}
}

/** "0.300s" / "1.5s" / 1.5 → seconds. Interactions API offsets are strings with an s suffix. */
export function parseOffset(value: unknown): number {
	if (typeof value === 'number') return value
	if (typeof value !== 'string') return NaN
	const m = value.trim().match(/^(-?[\d.]+)s?$/)
	return m ? Number(m[1]) : NaN
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000
}
