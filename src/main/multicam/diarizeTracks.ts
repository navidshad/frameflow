import {
	DEFAULT_WEIGHTS, biquad, emissions, gmmFromLabels, rawSeparation, smoothEmissions, windowFeatures, FRAME_SEC, RATE, buildFrameTable, buildTurns, cepstrumAt, fitGmm, levelDb, median, newMicTrack,
	percentile, pitchAt, N_CEP,
	type DimWeights, type FrameTable, type Gmm, type MicTrack, type RawTurn
} from './diarizeMath'

/**
 * From sound to speaker turns, without the file system: a microphone's samples
 * become frames on the group clock (`fillMicTrack`), and the frames of all the
 * microphones become turns (`clusterVoices`). diarize.ts reads the files.
 */

const HALF = 200 // samples either side of a frame's centre: one 50 ms frame

/**
 * Measure one file's sound on the group's frame grid and write it into the
 * camera's track. `member` is the file's line on the group clock
 * (`group = offset + source × rate`); frames the file did not record stay NaN.
 */
export function fillMicTrack(
	track: MicTrack,
	samples: Float32Array,
	member: { offset: number; rate: number },
	gridStartSec: number
): void {
	const band = Float32Array.from(samples)
	biquad(band, 'high', 80)
	biquad(band, 'low', 3500)
	// Pitch lives low: a 1.2 kHz low-pass at half the sample rate keeps the harmonics
	// that carry it and drops the formants that confuse the period.
	const lowFull = Float32Array.from(band)
	biquad(lowFull, 'low', 1200)
	const lp = new Float32Array(lowFull.length >> 1)
	for (let i = 0; i < lp.length; i++) lp[i] = lowFull[i * 2]

	const frames = track.level.length
	const centreSec = (f: number) => gridStartSec + (f + 0.5) * FRAME_SEC
	const indexOf = (f: number) => Math.round(((centreSec(f) - member.offset) / member.rate) * RATE)
	const covered: number[] = []
	for (let f = 0; f < frames; f++) {
		const i = indexOf(f)
		if (i - HALF < 0 || i + HALF > band.length) continue
		track.level[f] = levelDb(band, i - HALF, i + HALF)
		covered.push(f)
	}
	// Spectra and pitch only where there is something to measure: a few dB over this file's room tone.
	const gate = percentile(covered.map((f) => track.level[f]), 0.1) + 4
	for (const f of covered) {
		if (track.level[f] < gate) continue
		const i = indexOf(f)
		cepstrumAt(band, i, track.cep, f * N_CEP)
		track.f0[f] = pitchAt(lp, i >> 1)
	}
}

export interface VoiceSummary {
	/** Seconds of speech the model gave this voice. */
	talkSec: number
	/** Median pitch over its voiced frames. */
	pitchHz: number | null
	/** Mean margin above each microphone's floor while this voice speaks, dB, per track. */
	marginDb: number[]
	/** Index of the track that hears this voice best, or -1 when no microphone stands out. */
	closest: number
}

export interface VoiceClusters {
	k: number
	turns: RawTurn[]
	voices: VoiceSummary[]
	/** How different every pair of voices is on raw per-frame features (see rawSeparation()). */
	separation: number[][]
	table: FrameTable
	gmm: Gmm
}

export interface ClusterOptions {
	/** How many people. Estimated (2–5) when left out. */
	speakers?: number
	weights?: DimWeights
	seed?: number
	switchNats?: number
	temper?: number
	/** Half-width of the averaging window, seconds. */
	windowSec?: number
	fineSec?: number
	fineTemper?: number
	fineWeights?: DimWeights
}

/** Cluster the frames of all microphones into voices and make turns from them. */
export function clusterVoices(tracks: MicTrack[], gridStartSec: number, opts: ClusterOptions = {}): VoiceClusters | null {
	const frameTable = buildFrameTable(tracks, gridStartSec)
	if (frameTable.active.length < 100) return null
	const table = windowFeatures(frameTable, opts.windowSec ?? 3.5)
	const weights = opts.weights ?? DEFAULT_WEIGHTS

	let k = opts.speakers ?? 0
	if (!k) k = estimateSpeakers(table, weights, opts.seed)
	const { gmm } = fitGmm(table, k, { weights, seed: opts.seed })
	const switchNats = opts.switchNats
	const coarseEmit = emissions(table, gmm, { weights, temper: opts.temper })
	const coarse = smoothEmissions(table.active, k, coarseEmit, { switchNats })
	// Second pass. The averaged features found the voices but blur every change by
	// seconds. Closeness and pitch change AT the change, so a short-window model of
	// just those (learned from the frames the first pass was sure of) is added: it
	// pins down where Somi stops and a man starts, and says nothing between two
	// people who share a microphone and a pitch, which the first pass keeps deciding.
	let sm = coarse
	if (opts.fineSec !== 0) {
		const fine = windowFeatures(frameTable, opts.fineSec ?? 0.4)
		const fineW = opts.fineWeights ?? FINE_WEIGHTS
		const fineEmit = emissions(fine, gmmFromLabels(fine, coarse, k, 0.9, fineW), { weights: fineW, temper: opts.fineTemper ?? 0.5 })
		const both = Float64Array.from(coarseEmit, (v, i) => v + fineEmit[i])
		sm = smoothEmissions(table.active, k, both, { switchNats })
	}
	const turns = buildTurns(table, sm, k)

	const D = table.dims.length
	const f0Dim = table.dims.indexOf('f0')
	const voices: VoiceSummary[] = Array.from({ length: k }, () => ({ talkSec: 0, pitchHz: null, marginDb: [], closest: -1 }))
	const pitches: number[][] = Array.from({ length: k }, () => [])
	const sums = Array.from({ length: k }, () => new Float64Array(tracks.length))
	const counts = Array.from({ length: k }, () => new Float64Array(tracks.length))
	table.active.forEach((f, row) => {
		const j = sm.label[row]
		voices[j].talkSec += FRAME_SEC
		const v = table.x[row * D + f0Dim]
		if (v === v) pitches[j].push(2 ** v)
		tracks.forEach((_, c) => {
			const m = table.margin[c][f]
			if (m === m) { sums[j][c] += m; counts[j][c]++ }
		})
	})
	voices.forEach((v, j) => {
		v.pitchHz = pitches[j].length ? Math.round(median(pitches[j])) : null
		v.marginDb = Array.from(sums[j], (s, c) => (counts[j][c] ? Math.round((s / counts[j][c]) * 10) / 10 : NaN))
		// The microphone this voice stands furthest above, compared with how far ALL voices stand above it.
		const overall = tracks.map((_, c) => {
			let s = 0, n = 0
			voices.forEach((_, q) => { if (counts[q][c]) { s += sums[q][c] / counts[q][c]; n++ } })
			return n ? s / n : 0
		})
		const rel = v.marginDb.map((m, c) => m - overall[c])
		let best = -1, bestRel = 0
		rel.forEach((r, c) => { if (r > bestRel) { best = c; bestRel = r } })
		v.closest = bestRel >= 2 ? best : -1
	})
	const sep = rawSeparation(frameTable, sm, k, weights).map((row) => row.map((v) => Math.round(v * 100) / 100))
	return { k, turns, voices, separation: sep, table, gmm }
}

/**
 * How many voices, when nobody said: where adding another stops paying. Each
 * extra voice raises the fit; the first ones by a lot (real voices), the later
 * ones by little (one voice's loud and quiet states). Take the last k whose
 * gain is still close to the first gain. A GUESS: on the real two-camera shoot
 * the likelihood has no clean elbow (3 people, the guess is 4), so the caller
 * says so and the count can be given. Splitting too many is cheap to undo
 * (mergeSpeakers); too few is not.
 */
export function estimateSpeakers(table: FrameTable, weights: DimWeights, seed?: number): number {
	const ll: number[] = []
	for (let k = 2; k <= 6; k++) ll[k] = fitGmm(table, k, { weights, seed, maxRows: 6000, iterations: 20, starts: 3 }).logLik
	const first = ll[3] - ll[2]
	let chosen = 2
	for (let k = 2; k < 6; k++) {
		if (ll[k + 1] - ll[k] >= 0.45 * first) chosen = k + 1
		else break
	}
	return Math.max(2, chosen)
}

/** The fast cues only: they change where the speaker does. */
export const FINE_WEIGHTS: DimWeights = { close: 2, pitch: 1, timbre: 0 }
