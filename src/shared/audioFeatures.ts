/**
 * What a sound is made of, in numbers an agent can reason from without hearing.
 *
 * Two halves, both pure (no ffmpeg, no files) so they are testable on synthetic
 * signals:
 *
 *  1. FeatureExtractor: fed mono PCM in chunks, it keeps one row of features per
 *     hop: level, how the energy splits into low / mid / high, where its centre
 *     of mass sits (the "brightness"), and the spectral flux that marks onsets.
 *  2. summarizeFeatures: reduces those rows to the small report the
 *     `inspect_audio` tool returns: an energy curve, quiet spans, tonal balance,
 *     tempo, and a section map.
 *
 * Everything here is a measurement with a stated method, not a verdict. The
 * `hints` are rules over those measurements and say so; the spectrogram next to
 * them is the ground truth.
 */

/** The rate the audio is decoded to before it reaches the extractor. */
export const INSPECT_RATE = 22050
export const FFT_SIZE = 2048
export const HOP = 256

const BIN_HZ = INSPECT_RATE / FFT_SIZE
const LOW_END_HZ = 250
const MID_END_HZ = 2000
const TOP_HZ = 11000
const FLUX_TOP_HZ = 8000

/** The least autocorrelation that counts as a steady pulse. */
export const TEMPO_MIN_CONFIDENCE = 0.25

/** Longest stretch tempo is measured over; a longer file is sampled where it is busiest. */
export const TEMPO_WINDOW_SEC = 120

// ===== FFT =====

const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array; rev: Uint32Array }>()

function tablesFor(n: number) {
	let t = twiddles.get(n)
	if (t) return t
	const cos = new Float64Array(n / 2)
	const sin = new Float64Array(n / 2)
	for (let i = 0; i < n / 2; i++) {
		cos[i] = Math.cos((2 * Math.PI * i) / n)
		sin[i] = -Math.sin((2 * Math.PI * i) / n)
	}
	const bits = Math.log2(n)
	const rev = new Uint32Array(n)
	for (let i = 0; i < n; i++) {
		let r = 0
		for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b)
		rev[i] = r
	}
	t = { cos, sin, rev }
	twiddles.set(n, t)
	return t
}

/** In-place radix-2 FFT. `re.length` must be a power of two. */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
	const n = re.length
	const { cos, sin, rev } = tablesFor(n)
	for (let i = 0; i < n; i++) {
		const j = rev[i]
		if (j > i) {
			const tr = re[i]; re[i] = re[j]; re[j] = tr
			const ti = im[i]; im[i] = im[j]; im[j] = ti
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const half = size >> 1
		const step = n / size
		for (let start = 0; start < n; start += size) {
			for (let k = 0, w = 0; k < half; k++, w += step) {
				const a = start + k
				const b = a + half
				const xr = re[b] * cos[w] - im[b] * sin[w]
				const xi = re[b] * sin[w] + im[b] * cos[w]
				re[b] = re[a] - xr; im[b] = im[a] - xi
				re[a] += xr; im[a] += xi
			}
		}
	}
}

// ===== Extraction =====

/** One value per hop, `fps` hops a second. Times are relative to the start of what was fed in. */
export interface FrameFeatures {
	fps: number
	durationSec: number
	/** RMS level of each window, dBFS. */
	rmsDb: number[]
	/** Power in 20–250 Hz, 250–2000 Hz and 2000 Hz up. Absolute, so a loud frame outweighs a quiet one. */
	low: number[]
	mid: number[]
	high: number[]
	/** Spectral centre of mass in Hz (0 for a silent frame). */
	centroid: number[]
	/** How much new energy appeared since the previous frame: the onset signal. */
	flux: number[]
}

export class FeatureExtractor {
	private readonly buf = new Float32Array(FFT_SIZE)
	private n = 0
	private total = 0
	private readonly re = new Float64Array(FFT_SIZE)
	private readonly im = new Float64Array(FFT_SIZE)
	private readonly window = new Float64Array(FFT_SIZE)
	private readonly prev = new Float64Array(FFT_SIZE / 2 + 1)
	private readonly out: FrameFeatures
	private readonly bins = {
		lowStart: Math.ceil(20 / BIN_HZ), lowEnd: Math.floor(LOW_END_HZ / BIN_HZ),
		midEnd: Math.floor(MID_END_HZ / BIN_HZ), top: Math.floor(TOP_HZ / BIN_HZ), flux: Math.floor(FLUX_TOP_HZ / BIN_HZ)
	}

	constructor(private readonly hop = HOP) {
		for (let i = 0; i < FFT_SIZE; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))
		this.out = { fps: INSPECT_RATE / hop, durationSec: 0, rmsDb: [], low: [], mid: [], high: [], centroid: [], flux: [] }
	}

	/** Feed 16-bit PCM samples (or anything on that scale). */
	push(samples: ArrayLike<number>): void {
		for (let i = 0; i < samples.length; i++) {
			this.buf[this.n++] = samples[i] / 32768
			this.total++
			if (this.n === FFT_SIZE) {
				this.frame()
				this.buf.copyWithin(0, this.hop, FFT_SIZE)
				this.n = FFT_SIZE - this.hop
			}
		}
	}

	finish(): FrameFeatures {
		this.out.durationSec = this.total / INSPECT_RATE
		return this.out
	}

	private frame(): void {
		const { buf, re, im, window, prev, bins, out } = this
		let sumSq = 0
		for (let i = 0; i < FFT_SIZE; i++) {
			const s = buf[i]
			sumSq += s * s
			re[i] = s * window[i]
			im[i] = 0
		}
		out.rmsDb.push(20 * Math.log10(Math.max(Math.sqrt(sumSq / FFT_SIZE), 1e-6)))
		fftInPlace(re, im)

		let low = 0, mid = 0, high = 0, weighted = 0, power = 0, flux = 0
		const norm = FFT_SIZE / 4 // a full-scale sine reads about 1 after this
		for (let k = 1; k <= FFT_SIZE / 2; k++) {
			const p = re[k] * re[k] + im[k] * im[k]
			const logMag = Math.log1p((1000 * Math.sqrt(p)) / norm)
			if (k <= bins.flux) {
				const d = logMag - prev[k]
				if (d > 0) flux += d
			}
			prev[k] = logMag
			if (k < bins.lowStart || k > bins.top) continue
			if (k <= bins.lowEnd) low += p
			else if (k <= bins.midEnd) mid += p
			else high += p
			weighted += k * BIN_HZ * p
			power += p
		}
		const scale = 1 / (norm * norm)
		out.low.push(low * scale)
		out.mid.push(mid * scale)
		out.high.push(high * scale)
		out.centroid.push(power > 0 ? weighted / power : 0)
		out.flux.push(flux)
	}
}

// ===== Summary =====

export interface QuietSpan { startSec: number; endSec: number }

export interface AudioSection {
	startSec: number
	endSec: number
	/** Against the rest of the file: quiet, medium or loud. */
	level: 'quiet' | 'medium' | 'loud'
	meanDb: number
	centroidHz: number
	lowPct: number
	highPct: number
	/** Short words for how it sounds: "bass-heavy, bright". */
	character: string
}

export interface AudioSummary {
	durationSec: number
	/** Level through the file, dBFS, `stepSec` apart, starting at `fromSec`. */
	energy: { stepSec: number; db: number[] }
	dynamics: { loudDb: number; typicalDb: number; quietDb: number; rangeDb: number }
	quiet: { thresholdDb: number; totalSec: number; sharePct: number; spans: QuietSpan[]; spansTotal: number }
	balance: { lowPct: number; midPct: number; highPct: number; centroidHz: number; tone: 'dark' | 'balanced' | 'bright' }
	tempo: { bpm: number; confidence: number; measuredSec: number } | null
	sections: AudioSection[]
	hints: string[]
}

export interface SummaryOptions {
	/** Added to every time, so a trimmed range reads in the source's own seconds. */
	offsetSec?: number
}

const db10 = (power: number) => 10 * Math.log10(Math.max(power, 1e-12))
const round = (v: number, places = 1) => { const m = 10 ** places; return Math.round(v * m) / m }

function percentile(sorted: number[], p: number): number {
	if (!sorted.length) return -120
	const at = (sorted.length - 1) * p
	const lo = Math.floor(at), hi = Math.ceil(at)
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/** Mean power of a run of dB values, back in dB. */
function meanDb(values: number[], from: number, to: number): number {
	if (to <= from) return -120
	let sum = 0
	for (let i = from; i < to; i++) sum += 10 ** (values[i] / 10)
	return db10(sum / (to - from))
}

/** Frames where the level is under `thresholdDb` for at least `minFrames`, gaps of a blink bridged. */
export function quietSpans(rmsDb: number[], thresholdDb: number, minFrames: number, bridgeFrames: number): Array<[number, number]> {
	const raw: Array<[number, number]> = []
	let start = -1
	for (let i = 0; i <= rmsDb.length; i++) {
		const quiet = i < rmsDb.length && rmsDb[i] < thresholdDb
		if (quiet && start < 0) start = i
		if (!quiet && start >= 0) { raw.push([start, i]); start = -1 }
	}
	const merged: Array<[number, number]> = []
	for (const span of raw) {
		const last = merged[merged.length - 1]
		if (last && span[0] - last[1] <= bridgeFrames) last[1] = span[1]
		else merged.push([span[0], span[1]])
	}
	return merged.filter(([a, b]) => b - a >= minFrames)
}

/**
 * Tempo from the onset signal: autocorrelation over 60–200 BPM, nudged toward
 * the 90–160 where most music lives so a half or double does not win by a hair.
 * `confidence` is the normalised autocorrelation at the winning lag: near 0 for
 * noise or speech, 0.3+ for a steady pulse.
 */
export function estimateTempo(flux: number[], fps: number): { bpm: number; confidence: number } | null {
	const n = flux.length
	if (n < fps * 8) return null
	// Onset strength: flux minus its own local mean, kept only where it rises above it.
	const half = Math.max(1, Math.round(fps * 0.25))
	const env = new Float64Array(n)
	let run = 0
	const prefix = new Float64Array(n + 1)
	for (let i = 0; i < n; i++) { run += flux[i]; prefix[i + 1] = run }
	for (let i = 0; i < n; i++) {
		const a = Math.max(0, i - half), b = Math.min(n, i + half + 1)
		env[i] = Math.max(0, flux[i] - (prefix[b] - prefix[a]) / (b - a))
	}
	let energy = 0
	for (let i = 0; i < n; i++) energy += env[i] * env[i]
	if (energy <= 0) return null

	const lagMin = Math.max(2, Math.floor((fps * 60) / 200))
	const lagMax = Math.min(n - 2, Math.ceil((fps * 60) / 60))
	if (lagMax <= lagMin) return null
	const ac = new Float64Array(lagMax + 2)
	for (let lag = Math.max(1, lagMin - 1); lag <= lagMax + 1 && lag < n; lag++) {
		let sum = 0
		for (let i = 0; i + lag < n; i++) sum += env[i] * env[i + lag]
		ac[lag] = (sum / (n - lag)) / (energy / n)
	}
	let best = -1, bestScore = 0
	for (let lag = lagMin; lag <= lagMax; lag++) {
		if (ac[lag] < ac[lag - 1] || ac[lag] < ac[lag + 1]) continue // a peak, not a slope
		const bpm = (fps * 60) / lag
		const score = ac[lag] * Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
		if (score > bestScore) { best = lag; bestScore = score }
	}
	if (best < 0) return null
	// Parabolic refinement between neighbouring lags.
	const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1]
	const denom = y0 - 2 * y1 + y2
	const lag = denom < 0 ? best + (0.5 * (y0 - y2)) / denom : best
	return { bpm: round((fps * 60) / lag, 1), confidence: round(Math.max(0, Math.min(1, ac[best])), 2) }
}

/** The busiest `windowSec` of the flux and level tracks, or all of them when shorter. */
function busiestWindow(f: FrameFeatures, windowSec: number): { from: number; to: number } {
	const size = Math.round(windowSec * f.fps)
	const n = f.flux.length
	if (n <= size) return { from: 0, to: n }
	const step = Math.round(30 * f.fps)
	let best = 0, bestSum = -1
	for (let from = 0; from + size <= n; from += step) {
		let sum = 0
		for (let i = from; i < from + size; i++) sum += f.flux[i]
		if (sum > bestSum) { best = from; bestSum = sum }
	}
	return { from: best, to: best + size }
}

/** Digital silence reads -120 dB; reported levels stop at this so a range is not "104 dB". */
const DISPLAY_FLOOR_DB = -90

/** Under this a block is silence for the section map: its tone means nothing, and its level is floored. */
const BLOCK_FLOOR_DB = -60
const AUDIBLE_DB = -55

export interface Block { db: number; centroid: number; lowShare: number; highShare: number }

/** One-second blocks: the grain the section map reads at. */
export function blocksOf(f: FrameFeatures): Block[] {
	const count = Math.max(1, Math.floor(f.durationSec))
	const out: Block[] = []
	for (let b = 0; b < count; b++) {
		const from = Math.min(f.rmsDb.length - 1, Math.floor(b * f.fps))
		const to = Math.max(from + 1, Math.min(f.rmsDb.length, Math.floor((b + 1) * f.fps)))
		let low = 0, mid = 0, high = 0, weighted = 0, power = 0
		for (let i = from; i < to; i++) {
			low += f.low[i]; mid += f.mid[i]; high += f.high[i]
			const p = f.low[i] + f.mid[i] + f.high[i]
			weighted += f.centroid[i] * p
			power += p
		}
		out.push({
			db: Math.max(BLOCK_FLOOR_DB, meanDb(f.rmsDb, from, to)),
			centroid: power > 0 ? weighted / power : 0,
			lowShare: power > 0 ? low / power : 0,
			highShare: power > 0 ? high / power : 0
		})
	}
	return out
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** How different the `w` blocks after `i` are from the `w` before it: a distance, ~1 for a clear change. */
export function novelty(blocks: Block[], i: number, w: number): number {
	const left = blocks.slice(i - w, i), right = blocks.slice(i, i + w)
	const dDb = (mean(right.map((b) => b.db)) - mean(left.map((b) => b.db))) / 6
	// Tone is only compared between stretches that have a sound to describe: the
	// "brightness" of silence is noise, and a pause between sentences is not a new section.
	const heardL = left.filter((b) => b.db > AUDIBLE_DB), heardR = right.filter((b) => b.db > AUDIBLE_DB)
	if (!heardL.length || !heardR.length) return Math.abs(dDb)
	const dCentroid = Math.log2(Math.max(mean(heardR.map((b) => b.centroid)), 50) / Math.max(mean(heardL.map((b) => b.centroid)), 50)) / 0.6
	const dLow = (mean(heardR.map((b) => b.lowShare)) - mean(heardL.map((b) => b.lowShare))) / 0.2
	const dHigh = (mean(heardR.map((b) => b.highShare)) - mean(heardL.map((b) => b.highShare))) / 0.2
	return Math.sqrt(dDb * dDb + dCentroid * dCentroid + dLow * dLow + dHigh * dHigh)
}

/**
 * A boundary is a change at least this big AND several times the file's usual
 * wobble: a steady track shows a quiet breakdown, a talk only its big shifts.
 */
const SECTION_MIN_SCORE = 1
const SECTION_OVER_MEDIAN = 4
const MAX_SECTIONS = 9

/** Where the sound changes character: boundaries at the sharpest changes, kept apart so one drop is one boundary. */
export function sectionBoundaries(blocks: Block[]): number[] {
	const count = blocks.length
	if (count < 8) return []
	const w = Math.max(2, Math.min(6, Math.round(count / 30)))
	const scores: number[] = new Array(count).fill(0)
	for (let i = w; i <= count - w; i++) scores[i] = novelty(blocks, i, w)
	const seen = scores.slice(w, count - w + 1).sort((a, b) => a - b)
	const threshold = Math.max(SECTION_MIN_SCORE, SECTION_OVER_MEDIAN * (seen[Math.floor(seen.length / 2)] ?? 0))
	const candidates: number[] = []
	for (let i = w; i <= count - w; i++) {
		if (scores[i] < threshold) continue
		let isPeak = true
		for (let j = Math.max(w, i - w); j <= Math.min(count - w, i + w); j++) if (scores[j] > scores[i]) { isPeak = false; break }
		if (isPeak) candidates.push(i)
	}
	candidates.sort((a, b) => scores[b] - scores[a])
	const gap = Math.max(w * 2, 6)
	const chosen: number[] = []
	for (const c of candidates) {
		if (chosen.length >= MAX_SECTIONS - 1) break
		if (chosen.every((x) => Math.abs(x - c) >= gap)) chosen.push(c)
	}
	return chosen.sort((a, b) => a - b)
}

function describeTone(centroidHz: number, lowPct: number, highPct: number): string {
	const words: string[] = []
	if (lowPct >= 50) words.push('bass-heavy')
	if (centroidHz >= 2500 || highPct >= 35) words.push('bright')
	else if (centroidHz <= 500) words.push('dark')
	if (!words.length) words.push('mid-focused')
	return words.join(', ')
}

export function summarizeFeatures(f: FrameFeatures, opts: SummaryOptions = {}): AudioSummary {
	const offset = opts.offsetSec ?? 0
	const t = (sec: number) => round(sec + offset, 2)
	const n = f.rmsDb.length
	const sorted = [...f.rmsDb].sort((a, b) => a - b)
	const loud = percentile(sorted, 0.95)
	const quietDb = percentile(sorted, 0.1)
	const typical = meanDb(f.rmsDb, 0, n)

	// Energy curve: up to 48 points, never finer than half a second.
	const points = Math.max(1, Math.min(48, Math.ceil(f.durationSec / 0.5)))
	const per = n / points
	const energy: number[] = []
	for (let p = 0; p < points; p++) energy.push(Math.round(meanDb(f.rmsDb, Math.floor(p * per), Math.max(Math.floor(p * per) + 1, Math.floor((p + 1) * per)))))

	// Quiet spans: well under the loud part of this file, and never above -35 dBFS.
	const threshold = Math.round(Math.max(-70, Math.min(-35, loud - 30)))
	const spans = quietSpans(f.rmsDb, threshold, Math.round(0.4 * f.fps), Math.round(0.1 * f.fps))
	const quietFrames = spans.reduce((sum, [a, b]) => sum + (b - a), 0)
	const longest = [...spans].sort((a, b) => b[1] - b[0] - (a[1] - a[0])).slice(0, 15).sort((a, b) => a[0] - b[0])

	let low = 0, mid = 0, high = 0, weighted = 0, power = 0
	for (let i = 0; i < n; i++) {
		low += f.low[i]; mid += f.mid[i]; high += f.high[i]
		const p = f.low[i] + f.mid[i] + f.high[i]
		weighted += f.centroid[i] * p
		power += p
	}
	const lowPct = power > 0 ? Math.round((low / power) * 100) : 0
	const highPct = power > 0 ? Math.round((high / power) * 100) : 0
	const midPct = power > 0 ? Math.max(0, 100 - lowPct - highPct) : 0
	const centroidHz = power > 0 ? Math.round(weighted / power) : 0

	// Tempo reads the busiest stretch, so a long file costs no more.
	const win = busiestWindow(f, TEMPO_WINDOW_SEC)
	// A coarse hop (a very long file read quickly) cannot resolve a beat.
	const tempoRaw = f.fps >= 40 ? estimateTempo(f.flux.slice(win.from, win.to), f.fps) : null
	// Below this the "pulse" is the sound's own roughness (speech reads 0.2): not a tempo.
	const tempo = tempoRaw && tempoRaw.confidence >= TEMPO_MIN_CONFIDENCE
		? { ...tempoRaw, measuredSec: round((win.to - win.from) / f.fps, 0) }
		: null

	// Sections.
	const blocks = blocksOf(f)
	const cuts = sectionBoundaries(blocks)
	const edges = [0, ...cuts, blocks.length]
	const median = percentile(blocks.map((b) => b.db).sort((a, b) => a - b), 0.5)
	const sections: AudioSection[] = []
	for (let s = 0; s < edges.length - 1; s++) {
		const part = blocks.slice(edges[s], edges[s + 1])
		const db = meanDb(part.map((b) => b.db), 0, part.length)
		const lowShare = mean(part.map((b) => b.lowShare)), highShare = mean(part.map((b) => b.highShare))
		const centroid = mean(part.map((b) => b.centroid))
		sections.push({
			startSec: t(edges[s]),
			// The last section runs to the true end, not the last whole second.
			endSec: t(s === edges.length - 2 ? f.durationSec : edges[s + 1]),
			level: db > median + 3 ? 'loud' : db < median - 6 ? 'quiet' : 'medium',
			meanDb: Math.round(db),
			centroidHz: Math.round(centroid),
			lowPct: Math.round(lowShare * 100),
			highPct: Math.round(highShare * 100),
			character: describeTone(centroid, lowShare * 100, highShare * 100)
		})
	}

	const sharePct = n ? Math.round((quietFrames / n) * 100) : 0
	const tone = centroidHz >= 2500 ? 'bright' : centroidHz <= 700 ? 'dark' : 'balanced'
	const hints: string[] = []
	if (loud < -50) hints.push('Very quiet throughout: close to silence, or a recording with almost no level.')
	else if (sharePct >= 60) hints.push(`Under ${threshold} dBFS for ${sharePct}% of the time: mostly silence with short sounds in it.`)
	if (tempo) {
		hints.push(`A steady pulse near ${tempo.bpm} BPM (confidence ${tempo.confidence}): rhythmic music, likely drums or a sequenced beat. Cut on the beat; a bar is ${round((4 * 60) / tempo.bpm, 2)} s.`)
	} else if (f.fps >= 40) {
		// No pulse. Speech lives in the voice band (a body at 250 Hz–2 kHz, little deep bass, little hiss).
		if (midPct >= 60 && lowPct < 30 && highPct < 25) {
			hints.push(`No steady beat and ${midPct}% of the energy in the voice range (250 Hz–2 kHz)${sharePct >= 4 ? `, with ${spans.length} pause${spans.length === 1 ? '' : 's'}` : ''}: most likely speech. The transcript says what is said.`)
		} else {
			hints.push('No steady pulse found: ambience, effects, or music without a regular beat. Read the spectrogram.')
		}
	}
	if (lowPct >= 55) hints.push(`${lowPct}% of the energy is under 250 Hz: bass-heavy (kick and bass, or rumble).`)
	if (highPct >= 40) hints.push(`${highPct}% of the energy is above 2 kHz: bright, hissy or full of cymbals.`)
	if (sections.length > 1) hints.push(`${sections.length} parts that differ in level or tone: see sections for where each starts.`)

	return {
		durationSec: round(f.durationSec, 2),
		energy: { stepSec: round(f.durationSec / points, 2), db: energy },
		dynamics: { loudDb: round(loud, 1), typicalDb: round(Math.max(typical, DISPLAY_FLOOR_DB), 1), quietDb: round(Math.max(quietDb, DISPLAY_FLOOR_DB), 1), rangeDb: round(loud - Math.max(quietDb, DISPLAY_FLOOR_DB), 1) },
		quiet: {
			thresholdDb: threshold,
			totalSec: round(quietFrames / f.fps, 1),
			sharePct,
			spans: longest.map(([a, b]) => ({ startSec: t(a / f.fps), endSec: t(b / f.fps) })),
			spansTotal: spans.length
		},
		balance: { lowPct, midPct, highPct, centroidHz, tone },
		tempo,
		sections,
		hints
	}
}

// ===== What the tool hands back =====

export interface AudioInspection {
	hasAudio: boolean
	/** The part of the source that was read, in source seconds. */
	fromSec: number
	toSec: number
	loudness: { lufs: number | null; lra: number | null; truePeakDb: number | null }
	summary?: AudioSummary
	/** Base64 PNG, time axis in seconds from `fromSec`. */
	spectrogram?: string
	/** Shortcuts taken, in words (a long file's coarser tempo, a picture that could not be drawn). */
	notes: string[]
}
