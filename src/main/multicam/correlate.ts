/**
 * The arithmetic of syncing cameras by their sound. Pure: every function here
 * takes samples and returns numbers, so it is tested without ffmpeg.
 *
 * The method is the standard one (Premiere, Resolve, Final Cut, PluralEyes,
 * Kdenlive): cross-correlate the two recordings and take the lag where they
 * agree best. Two passes:
 *
 *  1. COARSE, on a 100 Hz loudness envelope of the whole recording, so a camera
 *     that started minutes late is found as easily as one that started 1 s late.
 *  2. FINE, on short windows of the band-passed sound itself, every minute or
 *     so along the recording, searching only near the coarse answer. GCC-PHAT
 *     (the cross-spectrum whitened to unit magnitude) makes the peak sharp even
 *     when two microphones colour the room differently.
 *
 * The fine lags, plotted against time, are a straight line: its height is the
 * offset and its slope is the drift between the two clocks.
 */

// ===== FFT =====

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
	const n = re.length
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1
		for (; j & bit; bit >>= 1) j ^= bit
		j ^= bit
		if (i < j) {
			let t = re[i]; re[i] = re[j]; re[j] = t
			t = im[i]; im[i] = im[j]; im[j] = t
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const angle = ((inverse ? 2 : -2) * Math.PI) / len
		const wr = Math.cos(angle)
		const wi = Math.sin(angle)
		const half = len >> 1
		for (let i = 0; i < n; i += len) {
			let cr = 1
			let ci = 0
			for (let k = 0; k < half; k++) {
				const a = i + k
				const b = a + half
				const xr = re[b] * cr - im[b] * ci
				const xi = re[b] * ci + im[b] * cr
				re[b] = re[a] - xr
				im[b] = im[a] - xi
				re[a] += xr
				im[a] += xi
				const nr = cr * wr - ci * wi
				ci = cr * wi + ci * wr
				cr = nr
			}
		}
	}
	if (inverse) {
		for (let i = 0; i < n; i++) {
			re[i] /= n
			im[i] /= n
		}
	}
}

const nextPow2 = (n: number) => 1 << Math.ceil(Math.log2(Math.max(2, n)))

/** Zero mean, unit variance; a silent signal comes back as zeros. */
export function standardize(x: ArrayLike<number>): Float64Array {
	const n = x.length
	let mean = 0
	for (let i = 0; i < n; i++) mean += x[i]
	mean /= n || 1
	let variance = 0
	for (let i = 0; i < n; i++) variance += (x[i] - mean) ** 2
	const sd = Math.sqrt(variance / (n || 1))
	const out = new Float64Array(n)
	if (sd < 1e-12) return out
	for (let i = 0; i < n; i++) out[i] = (x[i] - mean) / sd
	return out
}

export interface LagEstimate {
	/** In samples, fractional: `b`'s content appears in `a` at index `bIndex + lag`. */
	lag: number
	/** How far the peak stands above the rest of the searched lags, in standard deviations. */
	z: number
	/** Peak over the best competing peak at least `guard` samples away: 1 means ambiguous. */
	ratio: number
}

/**
 * Cross-correlate `b` against `a` over lags in [-maxLag, maxLag] (samples) and
 * return the best. With `phat`, the cross-spectrum is whitened first.
 */
export function crossCorrelate(
	a: ArrayLike<number>,
	b: ArrayLike<number>,
	maxLag: number,
	opts: { phat?: boolean; guard?: number; minLag?: number } = {}
): LagEstimate {
	const n = nextPow2(a.length + b.length)
	const ar = new Float64Array(n), ai = new Float64Array(n)
	const br = new Float64Array(n), bi = new Float64Array(n)
	for (let i = 0; i < a.length; i++) ar[i] = a[i]
	for (let i = 0; i < b.length; i++) br[i] = b[i]
	fft(ar, ai)
	fft(br, bi)
	// A · conj(B): the correlation's spectrum.
	for (let k = 0; k < n; k++) {
		const r = ar[k] * br[k] + ai[k] * bi[k]
		const i = ai[k] * br[k] - ar[k] * bi[k]
		if (opts.phat) {
			const mag = Math.hypot(r, i) + 1e-12
			ar[k] = r / mag
			ai[k] = i / mag
		} else {
			ar[k] = r
			ai[k] = i
		}
	}
	fft(ar, ai, true)
	// Lag L lives at index L (L >= 0) or n + L (L < 0).
	const lo = Math.max(-maxLag, opts.minLag ?? -maxLag, -(b.length - 1))
	const hi = Math.min(maxLag, a.length - 1)
	const at = (lag: number) => ar[lag >= 0 ? lag : n + lag]
	let best = lo
	let sum = 0
	let sumSq = 0
	let count = 0
	for (let lag = lo; lag <= hi; lag++) {
		const v = at(lag)
		sum += v
		sumSq += v * v
		count++
		if (v > at(best)) best = lag
	}
	const peak = at(best)
	const mean = sum / count
	const sd = Math.sqrt(Math.max(0, sumSq / count - mean * mean)) || 1e-12
	const guard = opts.guard ?? 1
	let second = -Infinity
	for (let lag = lo; lag <= hi; lag++) {
		if (Math.abs(lag - best) > guard) second = Math.max(second, at(lag))
	}
	// Parabolic interpolation: the true peak sits between samples.
	let frac = 0
	if (best > lo && best < hi) {
		const y0 = at(best - 1), y1 = peak, y2 = at(best + 1)
		const denom = y0 - 2 * y1 + y2
		if (denom < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom))
	}
	return {
		lag: best + frac,
		z: (peak - mean) / sd,
		ratio: second > 0 ? peak / second : Infinity
	}
}

// ===== Envelope (coarse pass) =====

/**
 * A loudness envelope at `rate / hop` Hz, as onsets: the rise of log energy
 * from one frame to the next. Onsets (a word starting, a laugh, a cup set
 * down) are what two microphones in one room agree on; their absolute levels
 * and their room tone are what they disagree on.
 */
export function onsetEnvelope(x: Float32Array, hop: number): Float64Array {
	const frames = Math.floor(x.length / hop)
	const energy = new Float64Array(frames)
	for (let f = 0; f < frames; f++) {
		let e = 0
		for (let i = f * hop, end = i + hop; i < end; i++) e += x[i] * x[i]
		energy[f] = Math.log10(e / hop + 1e-10)
	}
	const onset = new Float64Array(frames)
	for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1])
	return standardize(onset)
}

// ===== Line fit (offset + drift) =====

export interface LagPoint {
	/** Seconds into the OTHER recording where the window started. */
	at: number
	/** Seconds: the reference time of that moment minus `at`. */
	lag: number
	z: number
}

export interface LineFit {
	/** Reference seconds where the other recording's t=0 sits. */
	offset: number
	/** Reference seconds per other-recording second (1 + drift). */
	rate: number
	/** Points that agree with the line, and the worst of their misfits. */
	inliers: LagPoint[]
	residual: number
}

function leastSquares(points: LagPoint[]): { slope: number; intercept: number } {
	const n = points.length
	if (n === 1) return { slope: 0, intercept: points[0].lag }
	let sx = 0, sy = 0, sxx = 0, sxy = 0
	for (const p of points) {
		sx += p.at; sy += p.lag; sxx += p.at * p.at; sxy += p.at * p.lag
	}
	const denom = n * sxx - sx * sx
	const slope = Math.abs(denom) < 1e-12 ? 0 : (n * sxy - sx * sy) / denom
	return { slope, intercept: (sy - slope * sx) / n }
}

/**
 * Fit `lag = offset + at * drift` through the windows' lags, refusing the
 * outliers (a window that matched a laugh to the wrong laugh). Drift steeper
 * than `maxPpm` is not a clock, it is a bad fit, so it is clamped to flat.
 */
export function fitLine(points: LagPoint[], opts: { tolerance?: number; maxPpm?: number } = {}): LineFit | null {
	if (!points.length) return null
	const tolerance = opts.tolerance ?? 0.02
	const maxSlope = (opts.maxPpm ?? 1000) / 1e6
	// Start from the median lag, which a minority of wrong windows cannot move.
	const sorted = [...points].sort((p, q) => p.lag - q.lag)
	const median = sorted[Math.floor(sorted.length / 2)].lag
	let inliers = points.filter((p) => Math.abs(p.lag - median) <= Math.max(tolerance * 5, 0.1))
	if (!inliers.length) inliers = [sorted[Math.floor(sorted.length / 2)]]
	let line = leastSquares(inliers)
	for (let round = 0; round < 4; round++) {
		const keep = points.filter((p) => Math.abs(p.lag - (line.intercept + line.slope * p.at)) <= tolerance)
		if (!keep.length) break
		inliers = keep
		line = leastSquares(inliers)
	}
	// Two windows close together cannot tell drift from noise.
	const spread = Math.max(...inliers.map((p) => p.at)) - Math.min(...inliers.map((p) => p.at))
	if (inliers.length < 3 || spread < 120 || Math.abs(line.slope) > maxSlope) {
		const flat = inliers.reduce((s, p) => s + p.lag, 0) / inliers.length
		line = { slope: 0, intercept: flat }
	}
	const residual = Math.max(...inliers.map((p) => Math.abs(p.lag - (line.intercept + line.slope * p.at))))
	return { offset: line.intercept, rate: 1 + line.slope, inliers, residual }
}
