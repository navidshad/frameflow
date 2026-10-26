import { spawn } from 'child_process'
import type { MulticamSync } from '@shared/types'
import { soundScore } from '@shared/multicam'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import { crossCorrelate, fitLine, onsetEnvelope, standardize, type LagPoint } from './correlate'

/**
 * Sync recordings of one moment by their sound: where each sits against the
 * first (the reference), how fast its clock runs against it, and how sure the
 * match is. See correlate.ts for the method.
 */

export const SYNC_RATE = 8000
/** 10 ms frames for the coarse envelope. */
const HOP = SYNC_RATE / 100
/** Fine windows: this long, searched this far either side of the coarse answer. */
const WINDOW_SEC = 10
const SEARCH_SEC = 0.5
/** A window counts when its peak is this clear. */
const MIN_WINDOW_Z = 6
const MIN_WINDOW_RATIO = 1.15

// ===== Decoding =====

/** Mono samples at SYNC_RATE, straight from the file (no proxy: its encode can shift sound). */
export function decodeMono(file: string, signal?: AbortSignal): Promise<Float32Array> {
	return new Promise((resolve, reject) => {
		const child = spawn(getFFmpegBinaryPath(), [
			'-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SYNC_RATE), '-f', 'f32le', '-'
		], { stdio: ['ignore', 'pipe', 'pipe'] })
		const chunks: Buffer[] = []
		let bytes = 0
		let stderr = ''
		const abort = () => child.kill('SIGKILL')
		signal?.addEventListener('abort', abort, { once: true })
		child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); bytes += chunk.length })
		child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
		child.on('error', reject)
		child.on('close', (code) => {
			signal?.removeEventListener('abort', abort)
			if (signal?.aborted) return reject(new Error('Sync cancelled.'))
			if (code !== 0) {
				const noAudio = /matches no streams|does not contain any stream/i.test(stderr)
				return noAudio ? resolve(new Float32Array(0)) : reject(new Error(`Could not read the sound of ${file}: ${stderr.trim().split('\n').pop()}`))
			}
			const all = Buffer.concat(chunks, bytes)
			const out = new Float32Array(Math.floor(all.length / 4))
			for (let i = 0; i < out.length; i++) out[i] = all.readFloatLE(i * 4)
			resolve(out)
		})
	})
}

/** RBJ biquad, applied in place, twice over (a 4th-order slope) for speech band limits. */
function biquad(x: Float32Array, kind: 'high' | 'low', freq: number): void {
	const w = (2 * Math.PI * freq) / SYNC_RATE
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

/** The speech band (200 Hz – 3.5 kHz): where two microphones in one room agree most. */
export function speechBand(x: Float32Array): Float32Array {
	const y = Float32Array.from(x)
	biquad(y, 'high', 200)
	biquad(y, 'low', 3500)
	return y
}

// ===== Sound quality (for suggesting the main sound) =====

export interface SoundQuality {
	/** Loud speech: the 95th percentile of 50 ms frame levels, dBFS. */
	levelDb: number
	/** Room tone: the 10th percentile, dBFS. */
	noiseDb: number
	/** levelDb - noiseDb: how far the voices stand above the room. */
	snrDb: number
	/** Share of samples at or past full scale: clipping. */
	clipped: number
}

export function measureQuality(raw: Float32Array): SoundQuality | null {
	const frame = SYNC_RATE / 20
	const frames = Math.floor(raw.length / frame)
	if (frames < 20) return null
	const levels: number[] = []
	let clippedCount = 0
	for (let f = 0; f < frames; f++) {
		let e = 0
		for (let i = f * frame, end = i + frame; i < end; i++) {
			e += raw[i] * raw[i]
			if (Math.abs(raw[i]) >= 0.99) clippedCount++
		}
		levels.push(10 * Math.log10(e / frame + 1e-12))
	}
	levels.sort((a, b) => a - b)
	const levelDb = levels[Math.floor(frames * 0.95)]
	const noiseDb = levels[Math.floor(frames * 0.1)]
	return { levelDb, noiseDb, snrDb: levelDb - noiseDb, clipped: clippedCount / (frames * frame) }
}

/**
 * Which member should be the main sound: the clearest voices over the
 * quietest room, never one that clips. Returns asset ids, best first.
 */
export function rankSoundSources(sources: Array<{ assetId: string; quality: SoundQuality | null }>): string[] {
	return [...sources].sort((a, b) => soundScore(b.quality) - soundScore(a.quality)).map((s) => s.assetId)
}

// ===== One pair =====

export interface PairSync {
	offset: number
	rate: number
	sync: MulticamSync
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

/**
 * Where `other` sits against `ref` (both speech-band samples at SYNC_RATE).
 * `hintSec` is the offset recording times suggest, used when the sound cannot
 * decide (a silent camera, a camera with its microphone off).
 */
export async function syncPair(
	ref: Float32Array,
	other: Float32Array,
	opts: { hintSec?: number; signal?: AbortSignal } = {}
): Promise<PairSync> {
	// The sound could not decide: fall back to what the recording times say, and
	// say it failed so the user checks it.
	const failed = (measured = 0): PairSync => ({
		offset: opts.hintSec ?? 0,
		rate: 1,
		sync: {
			method: opts.hintSec !== undefined ? 'recorded' : 'manual',
			confidence: 'failed',
			driftPpm: 0,
			windows: { agreed: 0, measured }
		}
	})
	if (ref.length < SYNC_RATE * 2 || other.length < SYNC_RATE * 2) return failed()

	// --- Coarse: the whole of both, as onsets at 100 Hz ---
	const envRef = onsetEnvelope(ref, HOP)
	const envOther = onsetEnvelope(other, HOP)
	await tick()
	const coarse = crossCorrelate(envRef, envOther, Math.max(envRef.length, envOther.length), { guard: 50 })
	const coarseSec = (coarse.lag * HOP) / SYNC_RATE
	// A weak coarse peak far from what the clocks say is less likely than the clocks.
	const coarseOk = coarse.z >= 5 && coarse.ratio >= 1.05
	const centre = !coarseOk && opts.hintSec !== undefined ? opts.hintSec : coarseSec

	// --- Fine: windows along the other recording, near the coarse answer ---
	const otherSec = other.length / SYNC_RATE
	const refSec = ref.length / SYNC_RATE
	const step = Math.min(90, Math.max(15, otherSec / 40))
	let globalEnergy = 0
	for (let i = 0; i < other.length; i += 16) globalEnergy += other[i] * other[i]
	const globalRms = Math.sqrt(globalEnergy / Math.ceil(other.length / 16))
	const points: LagPoint[] = []
	let measured = 0
	for (let at = 2; at + WINDOW_SEC <= otherSec - 1; at += step) {
		if (opts.signal?.aborted) throw new Error('Sync cancelled.')
		const refStart = at + centre - SEARCH_SEC
		if (refStart < 0 || refStart + WINDOW_SEC + 2 * SEARCH_SEC > refSec) continue
		const b = other.subarray(Math.round(at * SYNC_RATE), Math.round((at + WINDOW_SEC) * SYNC_RATE))
		let e = 0
		for (let i = 0; i < b.length; i++) e += b[i] * b[i]
		// A quiet window has nothing to match: skip it rather than count it as a miss.
		if (Math.sqrt(e / b.length) < 0.3 * globalRms) continue
		const a = ref.subarray(
			Math.round(refStart * SYNC_RATE),
			Math.round((refStart + WINDOW_SEC + 2 * SEARCH_SEC) * SYNC_RATE)
		)
		measured++
		const est = crossCorrelate(standardize(a), standardize(b), Math.round(2 * SEARCH_SEC * SYNC_RATE), {
			phat: true, minLag: 0, guard: Math.round(0.25 * SYNC_RATE)
		})
		if (est.z >= MIN_WINDOW_Z && est.ratio >= MIN_WINDOW_RATIO) {
			points.push({ at, lag: refStart + est.lag / SYNC_RATE - at, z: est.z })
		}
		await tick()
	}

	const fit = fitLine(points, { tolerance: 0.02, maxPpm: 1000 })
	if (!fit) {
		// No window agreed. The coarse answer alone is still better than nothing
		// when it was clear; it is just not proven.
		if (coarseOk) {
			return {
				offset: coarseSec, rate: 1,
				sync: { method: 'audio', confidence: 'weak', driftPpm: 0, windows: { agreed: 0, measured } }
			}
		}
		return failed(measured)
	}
	const agreed = fit.inliers.length
	const strong = agreed >= 3 && agreed >= measured * 0.5 && fit.residual <= 0.02
	return {
		offset: fit.offset,
		rate: fit.rate,
		sync: {
			method: 'audio',
			confidence: strong ? 'strong' : 'weak',
			driftPpm: Math.round((fit.rate - 1) * 1e6 * 10) / 10,
			windows: { agreed, measured },
			residualSec: Math.round(fit.residual * 10000) / 10000
		}
	}
}

// ===== A whole group =====

export interface SyncInput {
	assetId: string
	path: string
	/** When the file says it started recording (epoch ms), for the fallback. */
	startedAt?: number
}

export interface SyncedMember {
	assetId: string
	offset: number
	rate: number
	sync: MulticamSync
	quality: SoundQuality | null
}

/**
 * Sync every file against the first. Progress is reported per file decoded
 * and per file matched, so a two-hour pair shows movement throughout.
 */
export async function syncRecordings(
	inputs: SyncInput[],
	opts: { signal?: AbortSignal; onProgress?: (fraction: number, label: string) => void } = {}
): Promise<SyncedMember[]> {
	if (inputs.length < 2) throw new Error('A camera group needs at least two files.')
	const steps = inputs.length * 2 - 1
	let done = 0
	const progress = (label: string) => opts.onProgress?.(Math.min(1, ++done / steps), label)

	const decoded: Array<{ band: Float32Array; quality: SoundQuality | null }> = []
	for (const [i, input] of inputs.entries()) {
		const raw = await decodeMono(input.path, opts.signal)
		decoded.push({ band: speechBand(raw), quality: measureQuality(raw) })
		progress(`Reading sound ${i + 1} of ${inputs.length}`)
	}

	const ref = inputs[0]
	const out: SyncedMember[] = [{
		assetId: ref.assetId, offset: 0, rate: 1, quality: decoded[0].quality,
		sync: { method: 'reference', confidence: 'strong', driftPpm: 0 }
	}]
	for (let i = 1; i < inputs.length; i++) {
		const input = inputs[i]
		const hintSec = input.startedAt !== undefined && ref.startedAt !== undefined
			? (input.startedAt - ref.startedAt) / 1000
			: undefined
		const pair = await syncPair(decoded[0].band, decoded[i].band, { hintSec, signal: opts.signal })
		out.push({ assetId: input.assetId, ...pair, quality: decoded[i].quality })
		progress(`Matching ${i + 1} of ${inputs.length}`)
	}
	return out
}
