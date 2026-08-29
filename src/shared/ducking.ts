import type { EditorDocument, TimelineItem } from './types'
import { captionsFromTimeline, type TranscriptEntry } from './captions'

/**
 * Ducking: pulling a music bed down while someone is talking.
 *
 * The obvious filter is `sidechaincompress`, and it is the wrong one HERE. The
 * export cuts a region at every item edge, so a compressor's attack and release
 * state resets partway through a bed and the music pumps at every boundary —
 * an artefact of how this renderer segments, not of the music.
 *
 * So the duck is a volume ENVELOPE over absolute timeline time, exactly as
 * `fadeA` already does for clip fades. Deterministic, immune to where the
 * regions happen to fall, and computable in the renderer too, so the monitor
 * can honour it without running ffmpeg.
 */

export interface Interval {
	start: number
	end: number
}

export interface DuckOptions {
	/** What the bed drops to under speech. 0.25 is about -12 dB. */
	depth?: number
	/** Seconds to fall and to recover. */
	ramp?: number
	/**
	 * Speech closer together than this counts as continuous.
	 *
	 * Without it the bed lifts between every sentence, which sounds like a fault
	 * rather than an effect — and it also keeps the filter expression short,
	 * since a merged monologue is a handful of intervals instead of hundreds.
	 */
	gap?: number
}

export const DUCK_DEFAULTS: Required<DuckOptions> = { depth: 0.25, ramp: 0.4, gap: 0.6 }

const TIME_EPS = 1e-6

/** Sort, then fold anything overlapping or closer than `gap` into one span. */
export function mergeIntervals(intervals: Interval[], gap = 0): Interval[] {
	const sorted = [...intervals]
		.filter((i) => i.end - i.start > TIME_EPS)
		.sort((a, b) => a.start - b.start)
	const out: Interval[] = []
	for (const interval of sorted) {
		const last = out[out.length - 1]
		if (last && interval.start - last.end <= gap) {
			last.end = Math.max(last.end, interval.end)
		} else {
			out.push({ ...interval })
		}
	}
	return out
}

/** A music bed: the track it sits on was marked as one. */
export const isMusicItem = (
	item: TimelineItem,
	doc: Pick<EditorDocument, 'tracks'>
): boolean => doc.tracks.find((t) => t.id === item.trackId)?.role === 'music'

/**
 * When someone is talking, in timeline seconds.
 *
 * Two levels of accuracy, and it takes the better one available per asset:
 *
 *   - With a transcript, the phrase ranges — so the bed comes back up in the
 *     pauses, which is what makes ducking sound deliberate.
 *   - Without one, the item's whole extent. Coarser, but a bed under narration
 *     ducked for the length of the narration is still the right shape.
 */
export function speechIntervals(
	doc: Pick<EditorDocument, 'timeline' | 'tracks'>,
	transcripts: Record<string, TranscriptEntry[]> = {},
	options: DuckOptions = {}
): Interval[] {
	const { gap } = { ...DUCK_DEFAULTS, ...options }
	const trackById = new Map(doc.tracks.map((t) => [t.id, t]))

	const speechItems = doc.timeline.filter((item) => {
		if (item.muted || item.text) return false
		const track = trackById.get(item.trackId)
		if (!track || track.hidden || track.muted || track.role === 'music') return false
		return track.kind === 'video' || track.kind === 'audio'
	})
	if (!speechItems.length) return []

	// The transcript mapper already handles trim, retime, duplicate and mute,
	// so a cue's timeline range IS a range where words are audible.
	const cues = captionsFromTimeline({ timeline: speechItems, tracks: doc.tracks }, transcripts)
	const transcribed = new Set(
		speechItems.filter((i) => transcripts[i.sourceAssetId]?.length).map((i) => i.id)
	)

	const raw: Interval[] = cues.map((c) => ({ start: c.start, end: c.end }))
	for (const item of speechItems) {
		if (transcribed.has(item.id)) continue
		raw.push({ start: item.timelineStart, end: item.timelineStart + item.duration })
	}
	return mergeIntervals(raw, gap)
}

/**
 * The volume expression for one bed slice, in SLICE-LOCAL seconds.
 *
 * Each interval contributes a trough — 1 outside, `depth` inside, a linear ramp
 * of `ramp` seconds either side — and the troughs combine with `min`, so
 * overlapping speech never ducks twice as far.
 *
 * Returns '' when no speech reaches this slice, which keeps the filter off the
 * chain entirely rather than multiplying every sample by one.
 */
export function duckExpression(
	intervals: Interval[],
	slice: { start: number; duration: number },
	options: DuckOptions = {}
): string {
	const { depth, ramp } = { ...DUCK_DEFAULTS, ...options }
	if (!(depth < 1) || !(ramp > 0)) return ''

	const sliceEnd = slice.start + slice.duration
	// Only what actually reaches this slice, ramps included. A long bed under a
	// long interview would otherwise carry every phrase in the project.
	const relevant = intervals.filter(
		(i) => i.end + ramp > slice.start - TIME_EPS && i.start - ramp < sliceEnd + TIME_EPS
	)
	if (!relevant.length) return ''

	const fmt = (n: number) => n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
	const drop = 1 - depth

	// `t` is slice-local, so shift each interval into that frame once here
	// rather than adding an offset to every term.
	const terms = relevant.map(({ start, end }) => {
		const a = fmt(start - slice.start)
		const b = fmt(end - slice.start)
		const r = fmt(ramp)
		// 0 outside the trough, 1 fully inside, linear across the ramps.
		const inside = `max(0,min(1,min((t-${a}+${r})/${r},(${b}+${r}-t)/${r})))`
		return `(1-${fmt(drop)}*${inside})`
	})

	const combined = terms.length === 1
		? terms[0]
		: terms.reduce((acc, term) => `min(${acc},${term})`)
	return `volume='max(0,min(1,${combined}))':eval=frame`
}
