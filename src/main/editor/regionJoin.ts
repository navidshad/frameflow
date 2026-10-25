import path from 'path'
import type { TimelineItem } from '@shared/types'
import { itemEnd } from '@shared/timeline'

/**
 * Exact-length joins for the region path (segment-then-concat).
 *
 * Each region used to render with `-t <seconds to 3 decimals>` into an h264 +
 * AAC mp4, and `concat -c copy` placed every file after the previous one by
 * that file's own reported duration. Two things made that length wrong at
 * every seam: the video rounded to whole frames and the audio to whole AAC
 * packets (1024 samples, plus the encoder's priming), and the next file started
 * after the LONGER of the two. A 9:26 vlog with 57 regions came out 0.15 s long,
 * with its content up to 0.22 s late by the end; a 60 s test with 37 regions
 * came out 60.43 s.
 *
 * So the length is decided here, once, on two fixed grids:
 *
 * - Video: region i covers frames [round(start·fps), round(end·fps)) of the
 *   timeline. The counts telescope, so they sum to round(total·fps) exactly,
 *   and no region's picture is ever more than half a frame from where the
 *   timeline puts it.
 * - Audio: the same on the 48 kHz sample grid. It is PCM in the intermediates
 *   and encoded to AAC once, after the join, so there is one priming delay for
 *   the whole file rather than one per region.
 *
 * The concat lists then state each file's duration instead of letting the
 * demuxer read it back, and video and audio are joined from two separate lists,
 * so neither stream's rounding can push the other along.
 */

export const AUDIO_RATE = 48_000

export interface RegionSpan {
	/** Video frames this region contributes. 0 for a sliver under half a frame. */
	frames: number
	/** Audio samples this region contributes. */
	samples: number
	/** Seconds the video list declares for this file (frame grid, µs exact). */
	videoSec: string
	/** Seconds the audio list declares for this file (sample grid, µs exact). */
	audioSec: string
}

const micros = (seconds: number) => Math.round(seconds * 1e6)

/**
 * Where every region falls on the frame and sample grids.
 *
 * Declared durations are differences of ROUNDED cumulative times, so whatever
 * each one rounds to, they still add up to the grid time of the end: the error
 * never accumulates past a microsecond.
 */
export function regionSpans(durations: number[], fps: number): RegionSpan[] {
	const spans: RegionSpan[] = []
	let start = 0
	for (const duration of durations) {
		const end = start + duration
		const f0 = Math.round(start * fps)
		const f1 = Math.round(end * fps)
		const s0 = Math.round(start * AUDIO_RATE)
		const s1 = Math.round(end * AUDIO_RATE)
		spans.push({
			frames: f1 - f0,
			samples: s1 - s0,
			videoSec: ((micros(f1 / fps) - micros(f0 / fps)) / 1e6).toFixed(6),
			audioSec: ((micros(s1 / AUDIO_RATE) - micros(s0 / AUDIO_RATE)) / 1e6).toFixed(6)
		})
		start = end
	}
	return spans
}

/**
 * Filters that pin a region's finished picture and mix to exactly its span.
 *
 * Video: renumber the frames 0, 1, 2… (a source that seeked onto a late frame
 * otherwise opens on a gap), hold the last frame for two more in case the
 * graph came up one short, then cut at the count. Audio: pad with silence and
 * cut at the sample count. Returns the new output labels.
 */
export function exactTailFilters(
	graph: { video: string; audio: string },
	span: Pick<RegionSpan, 'frames' | 'samples'>
): { filters: string[]; video: string; audio: string } {
	// A sub-half-frame sliver adds no picture to the join, but ffmpeg still
	// needs a frame to write; the video list leaves the file out.
	const frames = Math.max(1, span.frames)
	const samples = Math.max(1, span.samples)
	return {
		filters: [
			`${graph.video}setpts=N/FRAME_RATE/TB,tpad=stop_mode=clone:stop=2,trim=end_frame=${frames}[vexact]`,
			`${graph.audio}apad=whole_len=${samples},atrim=end_sample=${samples}[aexact]`
		],
		video: '[vexact]',
		audio: '[aexact]'
	}
}

/** The region file: whatever the export's video encoder is, with PCM audio. */
export const regionAudioOpts = (): string[] =>
	['-c:a', 'pcm_s16le', '-ar', String(AUDIO_RATE), '-ac', '2']

/** The two concat-demuxer lists, each file with its declared duration. */
export function concatLists(files: string[], spans: RegionSpan[]): { video: string; audio: string } {
	if (files.length !== spans.length) throw new Error('Every region file needs its span.')
	const entry = (file: string, seconds: string) =>
		`file '${path.basename(file).replace(/'/g, "'\\''")}'\nduration ${seconds}`
	return {
		// A sliver with no frames of its own is left out of the picture; its
		// sound is still in the audio list.
		video: files.flatMap((f, i) => (spans[i].frames > 0 ? [entry(f, spans[i].videoSec)] : [])).join('\n'),
		audio: files.map((f, i) => entry(f, spans[i].audioSec)).join('\n')
	}
}

/** Totals, for the check after the join. */
export function spanTotals(spans: RegionSpan[], fps: number): { frames: number; samples: number; seconds: number } {
	const frames = spans.reduce((sum, s) => sum + s.frames, 0)
	const samples = spans.reduce((sum, s) => sum + s.samples, 0)
	return { frames, samples, seconds: frames / fps }
}

/**
 * The item with its start and end on the frame grid, or null when it is
 * shorter than half a frame and so covers no frame at all.
 *
 * Every NLE keeps its timeline in whole frames; this document keeps seconds,
 * and an agent placing a layer "at 10.53 s" puts its edges between frames. The
 * export plans on the snapped copy, so each region boundary is a frame and the
 * input seek lands ON a source frame instead of discarding it. The document is
 * untouched. An item already on the grid comes back as itself, so a motion
 * layer's cache key does not change for nothing.
 */
export function snapItemToFrames(item: TimelineItem, fps: number): TimelineItem | null {
	const start = item.timelineStart
	const end = itemEnd(item)
	const snappedStart = Math.round(start * fps) / fps
	const snappedEnd = Math.round(end * fps) / fps
	if (Math.abs(snappedStart - start) < 1e-9 && Math.abs(snappedEnd - end) < 1e-9) return item
	if (snappedEnd - snappedStart <= 1e-9) return null
	const speed = item.speed || 1
	// The trim moves with the start, so the content under the snapped start is
	// the content that was there; a clip already at the head of its source
	// cannot start earlier, and keeps its first frame.
	const sourceIn = Math.max(0, item.in + (snappedStart - start) * speed)
	const duration = snappedEnd - snappedStart
	return { ...item, timelineStart: snappedStart, in: sourceIn, out: sourceIn + duration * speed, duration }
}
