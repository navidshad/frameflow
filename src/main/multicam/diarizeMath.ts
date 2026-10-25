import { fft } from './correlate'

/**
 * The arithmetic of "who is speaking when". Pure: samples and numbers in,
 * numbers out, so it is tested without ffmpeg (see diarize.ts for the I/O).
 *
 * Every frame of the group clock (50 ms) gets a small description of the
 * voice in it:
 *
 *  - CLOSENESS: each microphone's level above its OWN noise floor, compared
 *    across microphones at the same instant. A voice near one microphone
 *    stands further above that room tone than it does on the others, whoever
 *    is louder in absolute terms (the failure of "loudest microphone": mics
 *    differ in gain, so each is judged against its own floor, then the
 *    microphones against each other).
 *  - PITCH (f0) and TIMBRE (cepstral coefficients, mean-normalised per
 *    microphone so the mic's own colour cancels).
 *
 * The frames are clustered into N voices with a Gaussian mixture, the labels
 * are smoothed over time by a hidden Markov model (a person does not change
 * 20 times a second), and each turn keeps the model's own confidence.
 *
 * What this can and cannot do: closeness separates people who sit at
 * DIFFERENT microphones, reliably. Two people at ONE microphone are told apart
 * by pitch and timbre only; that works when the voices differ (a man and a
 * woman, a deep and a high voice) and degrades towards a guess when they do
 * not. The confidence says which.
 */

export const FRAME_SEC = 0.05
export const RATE = 8000
/** Cepstral coefficients kept (c1..c12; c0 is level, already used). */
export const N_CEP = 12
const MEL_BANDS = 22
const SPEC_WINDOW = 256
const F0_RATE = 4000
const F0_WINDOW = 256
const F0_MIN = 70
const F0_MAX = 420

// ===== Small helpers =====

export function percentile(values: ArrayLike<number>, p: number): number {
	const xs: number[] = []
	for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) xs.push(values[i])
	if (!xs.length) return NaN
	xs.sort((a, b) => a - b)
	return xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]
}

/** Deterministic random numbers, so the same footage gives the same speakers every run. */
export function rng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** RBJ biquad, applied in place twice over (4th order). Same filter as sync.ts uses, at RATE. */
export function biquad(x: Float32Array, kind: 'high' | 'low', freq: number): void {
	const w = (2 * Math.PI * freq) / RATE
	const cos = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2)
	const b0 = kind === 'low' ? (1 - cos) / 2 : (1 + cos) / 2
	const b1 = kind === 'low' ? 1 - cos : -(1 + cos)
	const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha
	for (let pass = 0; pass < 2; pass++) {
		let x1 = 0, x2 = 0, y1 = 0, y2 = 0
		for (let i = 0; i < x.length; i++) {
			const x0 = x[i]
			const y0 = (b0 * x0 + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2) / a0
			x2 = x1; x1 = x0; y2 = y1; y1 = y0
			x[i] = y0
		}
	}
}

// ===== Per-frame features of one microphone =====

/** One microphone sampled on the group's frame grid. NaN where it was not recording or not measured. */
export interface MicTrack {
	/** Level of the frame, dBFS (voice band). */
	level: Float32Array
	/** Pitch in Hz; NaN when the frame is unvoiced or too quiet to measure. */
	f0: Float32Array
	/** Cepstral coefficients, frames × N_CEP; NaN where not measured. */
	cep: Float32Array
}

export function newMicTrack(frames: number): MicTrack {
	return {
		level: new Float32Array(frames).fill(NaN),
		f0: new Float32Array(frames).fill(NaN),
		cep: new Float32Array(frames * N_CEP).fill(NaN)
	}
}

const HANN = Float64Array.from({ length: SPEC_WINDOW }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SPEC_WINDOW - 1)))

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700)
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1)

/** Triangular mel filters over the FFT's positive bins. */
const MEL = (() => {
	const lo = hz2mel(120), hi = hz2mel(3800)
	const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) => mel2hz(lo + ((hi - lo) * i) / (MEL_BANDS + 1)))
	const bin = (f: number) => (f * SPEC_WINDOW) / RATE
	return Array.from({ length: MEL_BANDS }, (_, b) => {
		const [l, c, r] = [bin(edges[b]), bin(edges[b + 1]), bin(edges[b + 2])]
		const taps: Array<[number, number]> = []
		for (let k = Math.ceil(l); k <= Math.floor(r); k++) {
			const w = k <= c ? (k - l) / (c - l || 1) : (r - k) / (r - c || 1)
			if (w > 0) taps.push([k, w])
		}
		return taps
	})
})()

const DCT = Array.from({ length: N_CEP }, (_, i) =>
	Float64Array.from({ length: MEL_BANDS }, (_, b) => Math.cos((Math.PI * (i + 1) * (b + 0.5)) / MEL_BANDS)))

const reBuf = new Float64Array(SPEC_WINDOW)
const imBuf = new Float64Array(SPEC_WINDOW)
const logMel = new Float64Array(MEL_BANDS)

/** Cepstrum of the SPEC_WINDOW samples of `x` centred on `centre`, written to out[at..at+N_CEP). */
export function cepstrumAt(x: Float32Array, centre: number, out: Float32Array, at: number): void {
	const from = centre - SPEC_WINDOW / 2
	for (let i = 0; i < SPEC_WINDOW; i++) {
		const v = x[from + i] ?? 0
		reBuf[i] = v * HANN[i]
		imBuf[i] = 0
	}
	fft(reBuf, imBuf)
	for (let b = 0; b < MEL_BANDS; b++) {
		let e = 0
		for (const [k, w] of MEL[b]) e += w * (reBuf[k] * reBuf[k] + imBuf[k] * imBuf[k])
		logMel[b] = Math.log(e + 1e-9)
	}
	for (let i = 0; i < N_CEP; i++) {
		let s = 0
		const row = DCT[i]
		for (let b = 0; b < MEL_BANDS; b++) s += row[b] * logMel[b]
		out[at + i] = s
	}
}

/** RMS of x[from, to) in dBFS. */
export function levelDb(x: Float32Array, from: number, to: number): number {
	const a = Math.max(0, from), b = Math.min(x.length, to)
	if (b <= a) return NaN
	let e = 0
	for (let i = a; i < b; i++) e += x[i] * x[i]
	return 10 * Math.log10(e / (b - a) + 1e-12)
}

/**
 * Pitch of the frame centred on `centre` of a signal at F0_RATE, by normalised
 * autocorrelation. NaN when there is no clear periodicity (unvoiced, noise).
 */
export function pitchAt(x: Float32Array, centre: number): number {
	const lagMin = Math.floor(F0_RATE / F0_MAX), lagMax = Math.ceil(F0_RATE / F0_MIN)
	const from = centre - F0_WINDOW / 2
	if (from < 0 || from + F0_WINDOW + lagMax >= x.length) return NaN
	let e0 = 0
	for (let i = 0; i < F0_WINDOW; i++) e0 += x[from + i] * x[from + i]
	if (e0 < 1e-9) return NaN
	const r = new Float64Array(lagMax + 2)
	let best = 0
	for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
		let c = 0, e1 = 0
		for (let i = 0; i < F0_WINDOW; i++) {
			c += x[from + i] * x[from + i + lag]
			e1 += x[from + i + lag] * x[from + i + lag]
		}
		r[lag] = c / Math.sqrt(e0 * e1 + 1e-12)
		if (lag >= lagMin && lag <= lagMax && r[lag] > best) best = r[lag]
	}
	if (best < 0.5) return NaN
	// The FIRST strong peak, not the highest: a voice repeats at 2x and 3x its
	// period too, and the highest of those is often a multiple.
	for (let lag = lagMin; lag <= lagMax; lag++) {
		if (r[lag] >= 0.88 * best && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
			const a = r[lag - 1], b = r[lag], c = r[lag + 1]
			const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0
			return F0_RATE / (lag + shift)
		}
	}
	return NaN
}

// ===== The frame table =====

export interface FrameTable {
	frames: number
	/** Group seconds of frame 0. */
	startSec: number
	/** Feature names, for explanation. */
	dims: string[]
	/** Which dims belong to which group (for weighting). */
	groups: Array<'close' | 'pitch' | 'timbre'>
	/** Frames that hold speech, ascending. */
	active: Int32Array
	/** active.length × dims.length, NaN where a dim is not available for that frame. */
	x: Float32Array
	/** Per camera: its margin above its own noise floor at every frame (NaN when not recording). */
	margin: Float32Array[]
	floors: number[]
}

export interface TableOptions {
	/** How far above its floor a microphone must be for a frame to count as speech. */
	speechDb?: number
}

/**
 * Assemble the features from every camera's microphone track. `tracks[c]` is
 * camera c's microphone. A camera not recording at a frame has NaN there.
 */
export function buildFrameTable(tracks: MicTrack[], startSec: number, opts: TableOptions = {}): FrameTable {
	const frames = tracks[0].level.length
	const speechDb = opts.speechDb ?? 8
	const floors = tracks.map((t) => percentile(t.level, 0.1))
	const margin = tracks.map((t, c) => Float32Array.from(t.level, (l) => (Number.isFinite(l) ? Math.max(-5, l - floors[c]) : NaN)))

	// Speech: any microphone clearly above its own room tone. Close small gaps and drop blips.
	const speech = new Uint8Array(frames)
	for (let f = 0; f < frames; f++) {
		for (const m of margin) if (m[f] >= speechDb) { speech[f] = 1; break }
	}
	closeGaps(speech, Math.round(0.25 / FRAME_SEC))
	dropBlips(speech, Math.round(0.15 / FRAME_SEC))

	const active: number[] = []
	for (let f = 0; f < frames; f++) if (speech[f]) active.push(f)

	// Cepstral mean normalisation per microphone, over the frames where THAT
	// microphone hears speech: removes the microphone's own colour.
	const cepMean = tracks.map((t, c) => {
		const sum = new Float64Array(N_CEP)
		let n = 0
		for (const f of active) {
			if (!(margin[c][f] >= speechDb) || Number.isNaN(t.cep[f * N_CEP])) continue
			for (let i = 0; i < N_CEP; i++) sum[i] += t.cep[f * N_CEP + i]
			n++
		}
		return Array.from(sum, (s) => (n ? s / n : 0))
	})

	const dims: string[] = []
	const groups: FrameTable['groups'] = []
	for (let c = 1; c < tracks.length; c++) { dims.push(`close${c}`); groups.push('close') }
	dims.push('f0'); groups.push('pitch')
	tracks.forEach((_, c) => {
		for (let i = 0; i < N_CEP; i++) { dims.push(`cep${c}.${i + 1}`); groups.push('timbre') }
	})

	const D = dims.length
	const x = new Float32Array(active.length * D).fill(NaN)
	active.forEach((f, row) => {
		let at = row * D
		for (let c = 1; c < tracks.length; c++) {
			const d = margin[c][f] - margin[0][f]
			x[at++] = Number.isFinite(d) ? Math.max(-30, Math.min(30, d)) : NaN
		}
		// Pitch from the microphone that hears the voice best at this frame.
		let best = -1, bestMargin = -Infinity
		tracks.forEach((t, c) => { if (Number.isFinite(t.f0[f]) && margin[c][f] > bestMargin) { best = c; bestMargin = margin[c][f] } })
		x[at++] = best >= 0 ? Math.log2(tracks[best].f0[f]) : NaN
		tracks.forEach((t, c) => {
			// A microphone that does not hear this frame says nothing about the voice.
			const heard = margin[c][f] >= speechDb - 2
			for (let i = 0; i < N_CEP; i++) {
				const v = t.cep[f * N_CEP + i]
				x[at++] = heard && Number.isFinite(v) ? v - cepMean[c][i] : NaN
			}
		})
	})
	return { frames, startSec, dims, groups, active: Int32Array.from(active), x, margin, floors }
}

function closeGaps(a: Uint8Array, maxGap: number): void {
	let last = -1
	for (let i = 0; i < a.length; i++) {
		if (!a[i]) continue
		if (last >= 0 && i - last - 1 > 0 && i - last - 1 <= maxGap) a.fill(1, last + 1, i)
		last = i
	}
}

function dropBlips(a: Uint8Array, minRun: number): void {
	for (let i = 0; i < a.length;) {
		if (!a[i]) { i++; continue }
		let j = i
		while (j < a.length && a[j]) j++
		if (j - i < minRun) a.fill(0, i, j)
		i = j
	}
}

// ===== Voices are long-term; phonemes are not =====

/**
 * Replace every frame's features by their mean over the speech within
 * ±halfSec. One 50 ms frame says mostly WHAT is being said (the phoneme);
 * a few seconds of it say WHO is saying it, because the phonetic variation
 * averages out and the voice (the long-term spectrum, the distance to each
 * microphone) stays. On the real two-men-one-microphone case this is the
 * difference between 74 % (frames, even with labels) and ~90 % (windows,
 * without any). Boundaries blur by about halfSec; see refine().
 */
export function windowFeatures(table: FrameTable, halfSec: number): FrameTable {
	const n = table.active.length, D = table.dims.length
	const sum = new Float64Array((n + 1) * D)
	const cnt = new Int32Array((n + 1) * D)
	for (let r = 0; r < n; r++) {
		for (let d = 0; d < D; d++) {
			const v = table.x[r * D + d]
			sum[(r + 1) * D + d] = sum[r * D + d] + (v === v ? v : 0)
			cnt[(r + 1) * D + d] = cnt[r * D + d] + (v === v ? 1 : 0)
		}
	}
	const reach = Math.round(halfSec / FRAME_SEC)
	const x = new Float32Array(n * D)
	let lo = 0, hi = 0
	for (let r = 0; r < n; r++) {
		const f = table.active[r]
		while (table.active[lo] < f - reach) lo++
		while (hi < n && table.active[hi] <= f + reach) hi++
		for (let d = 0; d < D; d++) {
			const c = cnt[hi * D + d] - cnt[lo * D + d]
			x[r * D + d] = c >= 3 ? (sum[hi * D + d] - sum[lo * D + d]) / c : NaN
		}
	}
	return { ...table, x }
}

// ===== Gaussian mixture over the frames =====

export interface Gmm {
	k: number
	weights: Float64Array
	/** k × D */
	means: Float64Array
	vars: Float64Array
	D: number
}

/** Per-dim weight in the likelihood: many correlated cepstral dims must not drown the few strong ones. */
export interface DimWeights { close: number; pitch: number; timbre: number }
export const DEFAULT_WEIGHTS: DimWeights = { close: 2, pitch: 1, timbre: 0.5 }

const LOG_2PI = Math.log(2 * Math.PI)

function dimWeights(table: Pick<FrameTable, 'groups'>, w: DimWeights): Float64Array {
	return Float64Array.from(table.groups, (g) => w[g])
}

/** Per-frame, per-component log density (weighted by dim). Rows are `rows` of x. */
export function logDensities(gmm: Gmm, x: Float32Array, rowCount: number, dw: Float64Array): Float64Array {
	const { k, D } = gmm
	const out = new Float64Array(rowCount * k)
	for (let r = 0; r < rowCount; r++) {
		for (let j = 0; j < k; j++) {
			let s = 0
			for (let d = 0; d < D; d++) {
				const v = x[r * D + d]
				if (v !== v) continue
				const mu = gmm.means[j * D + d], va = gmm.vars[j * D + d]
				s -= dw[d] * 0.5 * (LOG_2PI + Math.log(va) + ((v - mu) * (v - mu)) / va)
			}
			out[r * k + j] = s
		}
	}
	return out
}

/** The best of several starts: EM only finds a local optimum, and which one depends on where it began. */
export function fitGmm(
	table: FrameTable, k: number,
	opts: { seed?: number; iterations?: number; weights?: DimWeights; maxRows?: number; starts?: number } = {}
): { gmm: Gmm; logLik: number } {
	let best: { gmm: Gmm; logLik: number } | null = null
	for (let s = 0; s < (opts.starts ?? 5); s++) {
		const fit = fitGmmOnce(table, k, { ...opts, seed: (opts.seed ?? 7) + s * 101 })
		if (!best || fit.logLik > best.logLik) best = fit
	}
	return best!
}

function fitGmmOnce(
	table: FrameTable, k: number,
	opts: { seed?: number; iterations?: number; weights?: DimWeights; maxRows?: number } = {}
): { gmm: Gmm; logLik: number } {
	const D = table.dims.length
	const dw = dimWeights(table, opts.weights ?? DEFAULT_WEIGHTS)
	const total = table.active.length
	const stride = Math.max(1, Math.ceil(total / (opts.maxRows ?? 12000)))
	const rows: number[] = []
	for (let r = 0; r < total; r += stride) rows.push(r)
	const n = rows.length
	const X = new Float32Array(n * D)
	rows.forEach((r, i) => X.set(table.x.subarray(r * D, (r + 1) * D), i * D))

	// Scale per dim, for choosing starting points only.
	const mean = new Float64Array(D), sd = new Float64Array(D)
	for (let d = 0; d < D; d++) {
		let s = 0, c = 0
		for (let i = 0; i < n; i++) { const v = X[i * D + d]; if (v === v) { s += v; c++ } }
		mean[d] = c ? s / c : 0
		let q = 0
		for (let i = 0; i < n; i++) { const v = X[i * D + d]; if (v === v) q += (v - mean[d]) ** 2 }
		sd[d] = Math.sqrt(q / Math.max(1, c)) || 1
	}
	const dist = (i: number, centre: Float64Array) => {
		let s = 0, c = 0
		for (let d = 0; d < D; d++) {
			const v = X[i * D + d]
			if (v !== v || centre[d] !== centre[d]) continue
			s += dw[d] * ((v - centre[d]) / sd[d]) ** 2
			c++
		}
		return c ? s / c : 0
	}
	const rand = rng(opts.seed ?? 7)
	const centres: Float64Array[] = []
	const first = Math.floor(rand() * n)
	centres.push(Float64Array.from({ length: D }, (_, d) => X[first * D + d]))
	while (centres.length < k) {
		// k-means++: the next centre is drawn in proportion to its distance from the nearest one.
		const w = new Float64Array(n)
		let sum = 0
		for (let i = 0; i < n; i++) {
			let m = Infinity
			for (const c of centres) m = Math.min(m, dist(i, c))
			w[i] = m
			sum += m
		}
		let pick = rand() * sum, chosen = n - 1
		for (let i = 0; i < n; i++) { pick -= w[i]; if (pick <= 0) { chosen = i; break } }
		centres.push(Float64Array.from({ length: D }, (_, d) => X[chosen * D + d]))
	}
	// A few rounds of plain k-means for starting means and variances.
	const assign = new Int32Array(n)
	for (let round = 0; round < 8; round++) {
		for (let i = 0; i < n; i++) {
			let b = 0, bd = Infinity
			centres.forEach((c, j) => { const dd = dist(i, c); if (dd < bd) { bd = dd; b = j } })
			assign[i] = b
		}
		centres.forEach((c, j) => {
			for (let d = 0; d < D; d++) {
				let s = 0, cnt = 0
				for (let i = 0; i < n; i++) if (assign[i] === j) { const v = X[i * D + d]; if (v === v) { s += v; cnt++ } }
				if (cnt) c[d] = s / cnt
			}
		})
	}
	const gmm: Gmm = { k, D, weights: new Float64Array(k).fill(1 / k), means: new Float64Array(k * D), vars: new Float64Array(k * D) }
	for (let j = 0; j < k; j++) for (let d = 0; d < D; d++) { gmm.means[j * D + d] = centres[j][d] === centres[j][d] ? centres[j][d] : mean[d]; gmm.vars[j * D + d] = sd[d] * sd[d] }

	const floorVar = Float64Array.from(sd, (s) => (0.02 * s) ** 2 + 1e-6)
	let logLik = -Infinity
	const resp = new Float64Array(n * k)
	for (let it = 0; it < (opts.iterations ?? 30); it++) {
		const ld = logDensities(gmm, X, n, dw)
		let ll = 0
		for (let i = 0; i < n; i++) {
			let m = -Infinity
			for (let j = 0; j < k; j++) m = Math.max(m, ld[i * k + j] + Math.log(gmm.weights[j]))
			let s = 0
			for (let j = 0; j < k; j++) { resp[i * k + j] = Math.exp(ld[i * k + j] + Math.log(gmm.weights[j]) - m); s += resp[i * k + j] }
			for (let j = 0; j < k; j++) resp[i * k + j] /= s
			ll += m + Math.log(s)
		}
		for (let j = 0; j < k; j++) {
			let nj = 0
			for (let i = 0; i < n; i++) nj += resp[i * k + j]
			gmm.weights[j] = Math.max(1e-4, nj / n)
			for (let d = 0; d < D; d++) {
				let s = 0, c = 0
				for (let i = 0; i < n; i++) { const v = X[i * D + d]; if (v === v) { s += resp[i * k + j] * v; c += resp[i * k + j] } }
				if (c < 1e-6) continue
				const mu = s / c
				let q = 0
				for (let i = 0; i < n; i++) { const v = X[i * D + d]; if (v === v) q += resp[i * k + j] * (v - mu) ** 2 }
				gmm.means[j * D + d] = mu
				gmm.vars[j * D + d] = Math.max(floorVar[d], q / c)
			}
		}
		if (Math.abs(ll - logLik) < 1e-4 * Math.abs(ll)) { logLik = ll; break }
		logLik = ll
	}
	return { gmm, logLik: logLik / n }
}

// ===== Smoothing over time =====

export interface Smoothed {
	/** Posterior of every component at every ACTIVE frame: active.length × k. */
	posterior: Float32Array
	/** Most probable component per active frame. */
	label: Int32Array
}

/** Tempered log-likelihood of every active frame under every component (+ the log prior). */
export function emissions(table: FrameTable, gmm: Gmm, opts: { weights?: DimWeights; temper?: number } = {}): Float64Array {
	const n = table.active.length, k = gmm.k
	const ld = logDensities(gmm, table.x, n, dimWeights(table, opts.weights ?? DEFAULT_WEIGHTS))
	const temper = opts.temper ?? 0.12
	for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) ld[i * k + j] = ld[i * k + j] * temper + Math.log(gmm.weights[j])
	return ld
}

/**
 * Forward-backward over the active frames of an HMM whose states are the
 * mixture's components. Staying is cheap; switching costs `switchNats`, a
 * third as much across a pause (turns change in pauses). `logEmit` is already
 * tempered: neighbouring 50 ms frames of one voice are not independent
 * evidence, and untempered the model would be certain of everything.
 */
export function smoothEmissions(
	active: Int32Array, k: number, logEmit: Float64Array, opts: { switchNats?: number } = {}
): Smoothed {
	const n = active.length
	const emit = new Float64Array(n * k)
	for (let i = 0; i < n; i++) {
		let m = -Infinity
		for (let j = 0; j < k; j++) m = Math.max(m, logEmit[i * k + j])
		for (let j = 0; j < k; j++) emit[i * k + j] = Math.exp(logEmit[i * k + j] - m)
	}
	const switchNats = opts.switchNats ?? 5
	const pSwitch = (gap: number) => Math.min(0.5, Math.exp(-(gap > 1 ? switchNats / 3 : switchNats)))
	const alpha = new Float64Array(n * k), beta = new Float64Array(n * k)
	const norm = (v: Float64Array, off: number) => { let s = 0; for (let j = 0; j < k; j++) s += v[off + j]; s = s || 1; for (let j = 0; j < k; j++) v[off + j] /= s }
	for (let j = 0; j < k; j++) alpha[j] = emit[j]
	norm(alpha, 0)
	for (let i = 1; i < n; i++) {
		const p = pSwitch(active[i] - active[i - 1])
		for (let j = 0; j < k; j++) alpha[i * k + j] = emit[i * k + j] * (alpha[(i - 1) * k + j] * (1 - p) + (1 - alpha[(i - 1) * k + j]) * (p / Math.max(1, k - 1)))
		norm(alpha, i * k)
	}
	for (let j = 0; j < k; j++) beta[(n - 1) * k + j] = 1
	for (let i = n - 2; i >= 0; i--) {
		const p = pSwitch(active[i + 1] - active[i])
		let total = 0
		for (let j = 0; j < k; j++) total += emit[(i + 1) * k + j] * beta[(i + 1) * k + j]
		for (let j = 0; j < k; j++) {
			const stay = emit[(i + 1) * k + j] * beta[(i + 1) * k + j] * (1 - p)
			const move = (total - emit[(i + 1) * k + j] * beta[(i + 1) * k + j]) * (p / Math.max(1, k - 1))
			beta[i * k + j] = stay + move
		}
		norm(beta, i * k)
	}
	const posterior = new Float32Array(n * k)
	const label = new Int32Array(n)
	for (let i = 0; i < n; i++) {
		let s = 0
		for (let j = 0; j < k; j++) s += alpha[i * k + j] * beta[i * k + j]
		let best = 0
		for (let j = 0; j < k; j++) {
			posterior[i * k + j] = (alpha[i * k + j] * beta[i * k + j]) / (s || 1)
			if (posterior[i * k + j] > posterior[i * k + best]) best = j
		}
		label[i] = best
	}
	return { posterior, label }
}

/**
 * Sharpen the boundaries. The mixture was fitted on features averaged over
 * seconds, which finds the voices but smears every change of speaker by about
 * that long. Here each voice becomes one Gaussian estimated from the frames the
 * first pass was sure of (posterior ≥ minPosterior), but on SHORT-window
 * features, and the smoothing runs again on those: the first pass says who the
 * voices are, the second says exactly where they change.
 */
export function gmmFromLabels(fine: FrameTable, sm: Smoothed, k: number, minPosterior = 0.9, _weights?: DimWeights): Gmm {
	const n = fine.active.length, D = fine.dims.length
	const gmm: Gmm = { k, D, weights: new Float64Array(k), means: new Float64Array(k * D), vars: new Float64Array(k * D) }
	const sd = new Float64Array(D)
	for (let d = 0; d < D; d++) {
		let s = 0, c = 0, q = 0
		for (let r = 0; r < n; r++) { const v = fine.x[r * D + d]; if (v === v) { s += v; c++ } }
		const m = c ? s / c : 0
		for (let r = 0; r < n; r++) { const v = fine.x[r * D + d]; if (v === v) q += (v - m) ** 2 }
		sd[d] = Math.sqrt(q / Math.max(1, c)) || 1
	}
	for (let j = 0; j < k; j++) {
		let rows = 0
		for (let r = 0; r < n; r++) if (sm.label[r] === j && sm.posterior[r * k + j] >= minPosterior) rows++
		gmm.weights[j] = Math.max(1e-4, rows / Math.max(1, n))
		for (let d = 0; d < D; d++) {
			let s = 0, c = 0
			for (let r = 0; r < n; r++) {
				if (sm.label[r] !== j || sm.posterior[r * k + j] < minPosterior) continue
				const v = fine.x[r * D + d]; if (v === v) { s += v; c++ }
			}
			const mu = c ? s / c : 0
			let q = 0
			for (let r = 0; r < n; r++) {
				if (sm.label[r] !== j || sm.posterior[r * k + j] < minPosterior) continue
				const v = fine.x[r * D + d]; if (v === v) q += (v - mu) ** 2
			}
			gmm.means[j * D + d] = mu
			gmm.vars[j * D + d] = Math.max((0.05 * sd[d]) ** 2 + 1e-6, c ? q / c : sd[d] * sd[d])
		}
	}
	return gmm
}

// ===== Turns =====

export interface RawTurn {
	/** Group seconds. */
	start: number
	end: number
	/** Component index, or -1 when the model is not sure. */
	speaker: number
	confidence: number
}

export interface TurnOptions {
	/** Same speaker, pause shorter than this: one turn. */
	mergeGapSec?: number
	/** A turn below this much speech is an interjection, folded in unless it is clear. */
	minTurnSec?: number
	/** Below this the turn is "unsure". */
	minConfidence?: number
}

/** Runs of one component over the active frames, with the model's confidence in each. */
export function buildTurns(table: FrameTable, sm: Smoothed, k: number, opts: TurnOptions = {}): RawTurn[] {
	const mergeGap = opts.mergeGapSec ?? 1.0
	const minTurn = opts.minTurnSec ?? 0.6
	const minConf = opts.minConfidence ?? 0.6
	const n = table.active.length
	const frameStart = (i: number) => table.startSec + table.active[i] * FRAME_SEC
	type Run = { a: number; b: number; speaker: number; conf: number; speech: number }
	const runs: Run[] = []
	for (let i = 0; i < n;) {
		let j = i
		let conf = 0
		while (j + 1 < n && sm.label[j + 1] === sm.label[i] && table.active[j + 1] - table.active[j] <= mergeGap / FRAME_SEC) j++
		for (let q = i; q <= j; q++) conf += sm.posterior[q * k + sm.label[i]]
		runs.push({ a: i, b: j, speaker: sm.label[i], conf: conf / (j - i + 1), speech: (j - i + 1) * FRAME_SEC })
		i = j + 1
	}
	// Interjections: a short run between two runs of the same other speaker is folded into them
	// unless the model is clear about it.
	const out: Run[] = []
	for (let r = 0; r < runs.length; r++) {
		const run = runs[r]
		const prev = out[out.length - 1], next = runs[r + 1]
		if (run.speech < minTurn && run.conf < 0.85 && prev && next && prev.speaker === next.speaker && prev.speaker !== run.speaker) {
			prev.b = run.b
			prev.speech += run.speech
			continue
		}
		if (prev && prev.speaker === run.speaker && frameStart(run.a) - (frameStart(prev.b) + FRAME_SEC) <= mergeGap) {
			const total = prev.speech + run.speech
			prev.conf = (prev.conf * prev.speech + run.conf * run.speech) / total
			prev.b = run.b
			prev.speech = total
			continue
		}
		out.push({ ...run })
	}
	return out.map((r) => ({
		start: frameStart(r.a),
		end: frameStart(r.b) + FRAME_SEC,
		speaker: r.conf >= minConf ? r.speaker : -1,
		confidence: Math.round(r.conf * 100) / 100
	}))
}

// ===== Describing a voice =====

/** Median of a list ignoring NaN. */
export function median(values: ArrayLike<number>): number {
	return percentile(values, 0.5)
}

/**
 * How well two components differ on the evidence that exists, as the
 * Bhattacharyya distance between their (weighted) diagonal Gaussians. Below
 * about 1 the two voices are not reliably separable.
 */
export function separation(gmm: Gmm, table: Pick<FrameTable, 'groups'>, a: number, b: number, w: DimWeights = DEFAULT_WEIGHTS): number {
	const dw = dimWeights(table, w)
	let s = 0
	for (let d = 0; d < gmm.D; d++) {
		const va = gmm.vars[a * gmm.D + d], vb = gmm.vars[b * gmm.D + d]
		const dm = gmm.means[a * gmm.D + d] - gmm.means[b * gmm.D + d]
		s += dw[d] * (0.25 * (dm * dm) / (va + vb) + 0.5 * Math.log((va + vb) / (2 * Math.sqrt(va * vb))))
	}
	return s
}
