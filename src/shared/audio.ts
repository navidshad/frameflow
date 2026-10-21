/**
 * Audio, as the editor reasons about it: what a track is FOR (its role), and
 * what a source sounds like (its waveform and loudness).
 *
 * Everything here is pure, so the main process (which measures a file), the
 * renderer (which draws it) and the MCP tools (which report it) agree. Nothing
 * here touches ffmpeg or the DOM.
 */

// ===== Roles =====

/**
 * What an audio track is for. A role is a promise about the content, and it
 * carries what follows from it: whether the track ducks under speech, and where
 * it should sit in the mix relative to the voice.
 *
 * `undefined` on a track means "nothing said" and behaves exactly as before
 * roles existed: it counts as speech for ducking, and has no level target.
 */
export type TrackRole = 'voice' | 'music' | 'sfx'

export interface RoleSpec {
	id: TrackRole
	label: string
	/** One line for the menu. */
	description: string
	/** A music bed pulls itself down while someone is talking. */
	ducks: boolean
	/**
	 * Where this role should sit, in LU relative to the voice. The mix targets
	 * these when it auto-levels: sound effects are heard without competing with a
	 * word, a bed stays out of the way.
	 */
	offsetLU: number
}

export const TRACK_ROLES: readonly RoleSpec[] = [
	{ id: 'voice', label: 'Voice', description: 'Speech. The level everything else is measured against.', ducks: false, offsetLU: 0 },
	{ id: 'music', label: 'Music', description: 'A bed. It ducks under speech on every other track.', ducks: true, offsetLU: -12 },
	{ id: 'sfx', label: 'SFX', description: 'Sound effects. Heard without competing with a word.', ducks: false, offsetLU: -10 }
]

export const isTrackRole = (value: unknown): value is TrackRole =>
	value === 'voice' || value === 'music' || value === 'sfx'

export const roleSpec = (role: TrackRole | undefined): RoleSpec | undefined =>
	TRACK_ROLES.find((r) => r.id === role)

/** The delivery loudness the export normalises to when Loudness is on. */
export const MASTER_LUFS = -14

// ===== Level maths =====

export const gainToDb = (gain: number): number => (gain > 0 ? 20 * Math.log10(gain) : -Infinity)
export const dbToGain = (db: number): number => 10 ** (db / 20)

// ===== Analysis =====

/** How many peak buckets a second of source is reduced to. */
export const PEAK_RATE = 50

/**
 * What one pass over a source learns about how it sounds. Peaks are integers
 * 0..100 (percent of full scale), one per 1/PEAK_RATE second of SOURCE time, so
 * the JSON stays small and a trim is a slice, not a re-measure.
 */
export interface AudioAnalysis {
	v: 1
	hasAudio: boolean
	durationSec: number
	peakRate: number
	peaks: number[]
	/** Integrated loudness of the whole source, LUFS. Null when it could not be measured. */
	lufs: number | null
	/** Highest true peak, dBTP. */
	truePeakDb: number | null
	/** Loudness range, LU. */
	lra: number | null
}

export const NO_AUDIO: AudioAnalysis = {
	v: 1, hasAudio: false, durationSec: 0, peakRate: PEAK_RATE, peaks: [], lufs: null, truePeakDb: null, lra: null
}

/**
 * Reduce 16-bit PCM to peak buckets: the loudest sample in each, as 0..100.
 * `samplesPerBucket` is the source sample rate divided by PEAK_RATE.
 */
export function bucketPeaks(samples: ArrayLike<number>, samplesPerBucket: number): number[] {
	const per = Math.max(1, Math.floor(samplesPerBucket))
	const out: number[] = []
	for (let i = 0; i < samples.length; i += per) {
		let max = 0
		const end = Math.min(i + per, samples.length)
		for (let j = i; j < end; j++) {
			const v = Math.abs(samples[j])
			if (v > max) max = v
		}
		out.push(Math.min(100, Math.round((max / 32768) * 100)))
	}
	return out
}

/**
 * Read the summary ffmpeg's `ebur128` filter prints at the end of a run.
 * Per-frame lines also contain `I:`; only text after "Summary:" is the verdict.
 */
export function parseLoudness(stderr: string): { lufs: number | null; truePeakDb: number | null; lra: number | null } {
	const at = stderr.lastIndexOf('Summary:')
	const text = at >= 0 ? stderr.slice(at) : ''
	const num = (re: RegExp): number | null => {
		const m = text.match(re)
		if (!m) return null
		const v = parseFloat(m[1])
		return Number.isFinite(v) ? v : null
	}
	return {
		lufs: num(/I:\s+(-?[\d.]+)\s+LUFS/),
		lra: num(/LRA:\s+(-?[\d.]+)\s+LU(?!FS)/),
		truePeakDb: num(/Peak:\s+(-?[\d.]+)\s+dBFS/)
	}
}

/**
 * The part of a source's waveform a clip actually plays, resampled to `buckets`
 * values for a clip drawn that many bars wide. `in`/`out` are SOURCE seconds,
 * so speed needs no handling here: a faster clip plays the same source range
 * in fewer pixels.
 */
export function peaksForRange(a: Pick<AudioAnalysis, 'peaks' | 'peakRate'>, inSec: number, outSec: number, buckets: number): number[] {
	const n = Math.max(0, Math.floor(buckets))
	if (n === 0 || !a.peaks.length || outSec <= inSec) return new Array(n).fill(0)
	const rate = a.peakRate
	const out: number[] = new Array(n)
	const span = outSec - inSec
	for (let i = 0; i < n; i++) {
		const from = Math.floor((inSec + (i / n) * span) * rate)
		const to = Math.max(from + 1, Math.ceil((inSec + ((i + 1) / n) * span) * rate))
		let max = 0
		for (let j = from; j < to && j < a.peaks.length; j++) {
			if (j >= 0 && a.peaks[j] > max) max = a.peaks[j]
		}
		out[i] = max
	}
	return out
}

/**
 * A waveform as one SVG path of vertical bars, centred on the middle of a
 * `height`-tall box. `gain` scales the bars (a clip's own gain), clamped to the
 * box so a boosted clip clips visibly rather than overflowing.
 */
export function waveformPath(values: number[], height: number, step = 3, gain = 1): string {
	const mid = height / 2
	let d = ''
	for (let i = 0; i < values.length; i++) {
		const half = Math.min(mid, Math.max(1, (values[i] / 100) * gain * mid))
		const x = i * step + 1
		d += `M${x} ${(mid - half).toFixed(1)}V${(mid + half).toFixed(1)}`
	}
	return d
}

/** "−15.1 LUFS", or an em dash when it was not measured. */
export function formatLufs(lufs: number | null | undefined): string {
	return lufs === null || lufs === undefined || !Number.isFinite(lufs) ? '—' : `${lufs.toFixed(1).replace('-', '−')} LUFS`
}
