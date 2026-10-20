import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import {
	NO_AUDIO, PEAK_RATE, bucketPeaks, parseLoudness,
	type AudioAnalysis
} from '../../shared/audio'

/**
 * Measure how a source sounds: a waveform (peaks) and its loudness.
 *
 * The peaks come from decoding to 8 kHz mono PCM and keeping the loudest sample
 * of each 1/PEAK_RATE second — plenty for a timeline, and a minute of audio is
 * a few KB. The loudness is ffmpeg's own EBU R128 meter, the same one the
 * export's Loudness switch normalises with, so what this says is what that does.
 *
 * Two ffmpeg passes, run side by side: neither needs the other's output.
 */

const SAMPLE_RATE = 8000
const SAMPLES_PER_BUCKET = SAMPLE_RATE / PEAK_RATE

/** Decode to mono 8 kHz s16le and reduce to peak buckets as the bytes stream in. */
function measurePeaks(file: string, signal?: AbortSignal): Promise<{ peaks: number[]; hasAudio: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn(getFFmpegBinaryPath(), [
			'-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-'
		], { stdio: ['ignore', 'pipe', 'pipe'] })

		const peaks: number[] = []
		let carry: Buffer = Buffer.alloc(0)
		// Samples left over from the previous chunk that did not fill a bucket.
		let pending: number[] = []
		let stderr = ''
		let gotBytes = false

		const flush = (final: boolean) => {
			while (pending.length >= SAMPLES_PER_BUCKET) {
				peaks.push(...bucketPeaks(pending.slice(0, SAMPLES_PER_BUCKET), SAMPLES_PER_BUCKET))
				pending = pending.slice(SAMPLES_PER_BUCKET)
			}
			if (final && pending.length) {
				peaks.push(...bucketPeaks(pending, SAMPLES_PER_BUCKET))
				pending = []
			}
		}

		child.stdout.on('data', (chunk: Buffer) => {
			gotBytes = true
			const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
			const usable = buf.length - (buf.length % 2)
			carry = buf.subarray(usable)
			for (let i = 0; i < usable; i += 2) pending.push(buf.readInt16LE(i))
			flush(false)
		})
		child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
		child.on('error', reject)
		child.on('close', (code) => {
			if (signal?.aborted) return reject(new Error('Audio analysis aborted'))
			flush(true)
			// A file with no audio stream is an answer, not a failure.
			if (!gotBytes && /does not contain any stream|Output file #0 does not contain/i.test(stderr)) {
				return resolve({ peaks: [], hasAudio: false })
			}
			if (code !== 0 && !gotBytes) return reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`))
			resolve({ peaks, hasAudio: gotBytes })
		})
		signal?.addEventListener('abort', () => child.kill('SIGKILL'))
	})
}

/** ffmpeg's EBU R128 meter over the whole file: integrated loudness, range, true peak. */
function measureLoudness(file: string, signal?: AbortSignal): Promise<ReturnType<typeof parseLoudness>> {
	return new Promise((resolve) => {
		const child = spawn(getFFmpegBinaryPath(), [
			'-nostats', '-nostdin', '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'
		], { stdio: ['ignore', 'ignore', 'pipe'] })
		let stderr = ''
		child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
		// Loudness is a nicety next to the waveform: if it cannot be measured the
		// waveform still draws, so this resolves empty rather than rejecting.
		child.on('error', () => resolve({ lufs: null, truePeakDb: null, lra: null }))
		child.on('close', () => resolve(parseLoudness(stderr)))
		signal?.addEventListener('abort', () => child.kill('SIGKILL'))
	})
}

export async function analyzeAudioFile(file: string, signal?: AbortSignal): Promise<AudioAnalysis> {
	if (!fs.existsSync(file)) throw new Error(`Audio source not found: ${file}`)
	const [{ peaks, hasAudio }, loud] = await Promise.all([measurePeaks(file, signal), measureLoudness(file, signal)])
	if (!hasAudio) return { ...NO_AUDIO }
	return {
		v: 1,
		hasAudio: true,
		durationSec: peaks.length / PEAK_RATE,
		peakRate: PEAK_RATE,
		peaks,
		lufs: loud.lufs,
		truePeakDb: loud.truePeakDb,
		lra: loud.lra
	}
}

// ===== Per-asset cache =====

const CACHE_NAME = 'audio-analysis.v1.json'

/**
 * The analysis of an asset's source, measured once and kept next to it. The
 * source of an asset never changes in place (a re-import is a new asset id), so
 * there is nothing to invalidate; a cache the reader cannot parse is re-measured.
 */
export async function getAudioAnalysis(
	assetDir: string,
	sourcePath: string,
	opts?: { signal?: AbortSignal; hasAudio?: boolean }
): Promise<AudioAnalysis> {
	if (opts?.hasAudio === false) return { ...NO_AUDIO }
	const cache = path.join(assetDir, CACHE_NAME)
	try {
		const cached = JSON.parse(fs.readFileSync(cache, 'utf8')) as AudioAnalysis
		if (cached?.v === 1 && Array.isArray(cached.peaks)) return cached
	} catch { /* not measured yet, or unreadable: measure */ }

	const analysis = await analyzeAudioFile(sourcePath, opts?.signal)
	try {
		fs.mkdirSync(assetDir, { recursive: true })
		fs.writeFileSync(cache, JSON.stringify(analysis))
	} catch (error) {
		console.warn('[audio] could not cache the analysis:', error)
	}
	return analysis
}

// ===== A short sound as a handful of bars =====

/**
 * The shape of a short file as `buckets` peaks (0..100), evenly spread over its
 * whole length. For sounds of a tenth of a second, where the 50-a-second
 * analysis would give five bars: this is for the palette's little waveforms.
 */
export function previewPeaks(file: string, buckets = 48): Promise<number[]> {
	return new Promise((resolve, reject) => {
		const child = spawn(getFFmpegBinaryPath(), [
			'-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'
		], { stdio: ['ignore', 'pipe', 'pipe'] })
		const chunks: Buffer[] = []
		child.stdout.on('data', (d: Buffer) => chunks.push(d))
		child.on('error', reject)
		child.on('close', () => {
			const buf = Buffer.concat(chunks)
			const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
			if (!samples.length) return resolve(new Array(buckets).fill(0))
			resolve(bucketPeaks(samples, Math.ceil(samples.length / buckets)).slice(0, buckets))
		})
	})
}
