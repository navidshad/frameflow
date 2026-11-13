import { spawn } from 'child_process'
import fs from 'fs'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import { FeatureExtractor, HOP, INSPECT_RATE, summarizeFeatures, type AudioInspection } from '../../shared/audioFeatures'
import { measureLoudness, rangeArgs, spectrogramBase64, type SourceRange } from './audioAnalysis'

/**
 * Look at any audio the way an agent can: a spectrogram with its axes, and the
 * numbers behind it (see shared/audioFeatures.ts for what they are and how they
 * are measured).
 *
 * One decode to 22.05 kHz mono streams through the feature extractor while two
 * other ffmpeg runs, side by side, measure loudness and draw the picture; none
 * needs another's output. Works on a video file too: only its sound is read.
 */

/** Past this many seconds the hop grows, so an hour of podcast costs seconds, not a minute. */
const LONG_SEC = 20 * 60
const LONG_HOP = HOP * 4

/** Decode `range` of `file` to mono 22.05 kHz PCM and run it through `extractor` as it streams. */
function streamFeatures(file: string, extractor: FeatureExtractor, range: SourceRange | undefined, signal?: AbortSignal): Promise<{ hasAudio: boolean }> {
	return new Promise((resolve, reject) => {
		const child = spawn(getFFmpegBinaryPath(), [
			'-v', 'error', '-nostdin', ...rangeArgs(range), '-i', file, '-vn', '-ac', '1', '-ar', String(INSPECT_RATE), '-f', 's16le', '-'
		], { stdio: ['ignore', 'pipe', 'pipe'] })
		let carry: Buffer = Buffer.alloc(0)
		let stderr = ''
		let gotBytes = false
		child.stdout.on('data', (chunk: Buffer) => {
			gotBytes = true
			const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
			const usable = buf.length - (buf.length % 2)
			carry = buf.subarray(usable)
			// Copied to an aligned buffer: a Node chunk may sit at an odd offset.
			const samples = new Int16Array(usable / 2)
			for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2)
			extractor.push(samples)
		})
		child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
		child.on('error', reject)
		child.on('close', (code) => {
			if (signal?.aborted) return reject(new Error('Audio inspection aborted'))
			if (!gotBytes && /does not contain any stream|Output file #0 does not contain/i.test(stderr)) return resolve({ hasAudio: false })
			if (code !== 0 && !gotBytes) return reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`))
			resolve({ hasAudio: gotBytes })
		})
		signal?.addEventListener('abort', () => child.kill('SIGKILL'))
	})
}

export interface InspectOptions {
	/** Source seconds. Default: the whole file. */
	fromSec?: number
	toSec?: number
	/** How long the source is, when the caller knows (decides how finely it is read). */
	durationSec?: number
	signal?: AbortSignal
}

export async function inspectAudioFile(file: string, opts: InspectOptions = {}): Promise<AudioInspection> {
	if (!fs.existsSync(file)) throw new Error(`Audio source not found: ${file}`)
	const fromSec = Math.max(0, opts.fromSec ?? 0)
	const known = opts.durationSec && opts.durationSec > 0 ? opts.durationSec : undefined
	const wantsEnd = opts.toSec !== undefined && Number.isFinite(opts.toSec)
	if (wantsEnd && opts.toSec! <= fromSec) throw new Error('toSec must be after fromSec.')
	// An open end reads to the end of the file: leave -t off rather than guess it.
	const range: SourceRange | undefined = wantsEnd || fromSec > 0
		? { fromSec, durSec: wantsEnd ? opts.toSec! - fromSec : Math.max(0.1, (known ?? 1e6) - fromSec) }
		: undefined
	const expected = range ? range.durSec : known ?? 0
	const hop = expected > LONG_SEC ? LONG_HOP : HOP
	const notes: string[] = []
	if (hop !== HOP) notes.push(`Long audio (${Math.round(expected / 60)} min): read at a coarser grain, so tempo is not measured. Pass fromSec/toSec to inspect a stretch finely.`)

	const extractor = new FeatureExtractor(hop)
	const [stream, loud, picture] = await Promise.all([
		streamFeatures(file, extractor, range, opts.signal),
		measureLoudness(file, opts.signal, range),
		// Time labels run 0..length: the caller adds `fromSec` in words.
		spectrogramBase64(file, { width: 1024, height: 420, legend: true, range }).catch((error: Error) => {
			notes.push(`The spectrogram could not be drawn: ${error.message}`)
			return undefined
		})
	])
	if (!stream.hasAudio) return { hasAudio: false, fromSec, toSec: fromSec, loudness: { lufs: null, lra: null, truePeakDb: null }, notes }

	const features = extractor.finish()
	const toSec = fromSec + features.durationSec
	return {
		hasAudio: true,
		fromSec,
		toSec,
		loudness: loud,
		summary: summarizeFeatures(features, { offsetSec: fromSec }),
		spectrogram: picture,
		notes
	}
}
