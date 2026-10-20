import { spawn } from 'child_process'
import fs from 'fs'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'

/**
 * Captured frames → an alpha-carrying intermediate.
 *
 * QuickTime Animation (`qtrle`) in a .mov, `argb`: LOSSLESS, so a second render
 * of the same clip is the same file bit for bit and the export composites
 * exactly what the page drew. Verified against the bundled FFmpeg 9.0.1 rather
 * than assumed: it lists `qtrle` (rgb24 argb …) and `prores_ks` (yuva444p10le);
 * ProRes 4444 would also carry alpha, but it is lossy, and determinism is easier
 * to promise when nothing is approximated.
 *
 * No Electron here — the capture hands this plain buffers — so the encoder runs
 * against the real binary in an ordinary vitest run.
 */

/**
 * Chromium hands back PREMULTIPLIED BGRA: a half-transparent pure red arrives as
 * (B 0, G 0, R 128, A 128). `qtrle`'s argb and ffmpeg's `overlay` both expect
 * STRAIGHT alpha, so a premultiplied frame composites with dark fringes on
 * every soft edge. In place, because a 1080p frame is 8 MB and there are many.
 */
export function unpremultiplyBgra(buffer: Buffer): Buffer {
	for (let i = 0; i < buffer.length; i += 4) {
		const a = buffer[i + 3]
		if (a === 255) continue
		if (a === 0) {
			buffer[i] = 0
			buffer[i + 1] = 0
			buffer[i + 2] = 0
			continue
		}
		buffer[i] = Math.min(255, Math.round((buffer[i] * 255) / a))
		buffer[i + 1] = Math.min(255, Math.round((buffer[i + 1] * 255) / a))
		buffer[i + 2] = Math.min(255, Math.round((buffer[i + 2] * 255) / a))
	}
	return buffer
}

/**
 * The encode's own suffix while it runs. Keeps a REAL extension: ffmpeg picks
 * its muxer from the name, and `.mov.part` fails with "Unable to choose an
 * output format" — the bug the transition cache already hit once.
 */
export const PARTIAL_SUFFIX = '.part.mov'

export function ffmpegArgs(frame: { width: number; height: number; fps: number }, output: string): string[] {
	return [
		'-hide_banner', '-loglevel', 'error', '-y',
		'-f', 'rawvideo', '-pix_fmt', 'bgra',
		'-video_size', `${frame.width}x${frame.height}`,
		'-framerate', String(frame.fps),
		'-i', 'pipe:0',
		'-c:v', 'qtrle', '-pix_fmt', 'argb',
		// Every frame a keyframe, so the export's input seek (`-ss`) lands on
		// the exact frame without decoding a run up to it.
		'-g', '1',
		output
	]
}

/**
 * Encode `count` frames, pulled one at a time from `next`, to `outputPath`.
 *
 * Frames are PULLED rather than pushed so a slow capture never queues more than
 * one 8 MB frame, and the pipe's back-pressure is honoured. Writes to a sibling
 * name and renames on success, so a crash mid-encode cannot leave a truncated
 * file at a key that would read as a cache hit forever.
 */
export async function encodeFrames(options: {
	frame: { width: number; height: number; fps: number }
	count: number
	/** Frame k as PREMULTIPLIED BGRA, width × height × 4 bytes. */
	next: (k: number) => Promise<Buffer>
	outputPath: string
	signal?: AbortSignal
	onProgress?: (done: number, total: number) => void
}): Promise<void> {
	const { frame, count, next, outputPath, signal, onProgress } = options
	const expected = frame.width * frame.height * 4
	const partial = outputPath.replace(/\.mov$/, PARTIAL_SUFFIX)
	const child = spawn(getFFmpegBinaryPath(), ffmpegArgs(frame, partial), { stdio: ['pipe', 'ignore', 'pipe'] })
	let stderr = ''
	child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
	const exited = new Promise<number>((resolve, reject) => {
		child.on('error', reject)
		child.on('close', (code) => resolve(code ?? -1))
	})
	// A write after ffmpeg died raises EPIPE on the stream; the exit code is the
	// real report, so swallow the stream error and let `exited` speak.
	child.stdin.on('error', () => {})
	const onAbort = () => child.kill('SIGKILL')
	signal?.addEventListener('abort', onAbort)

	try {
		for (let k = 0; k < count; k++) {
			if (signal?.aborted) throw new Error('aborted')
			const buffer = await next(k)
			if (buffer.length !== expected) {
				throw new Error(`Motion frame ${k} is ${buffer.length} bytes; expected ${expected} (${frame.width}×${frame.height}).`)
			}
			unpremultiplyBgra(buffer)
			if (!child.stdin.write(buffer)) {
				await new Promise<void>((resolve) => {
					const done = () => { child.stdin.off('drain', done); child.off('close', done); resolve() }
					child.stdin.once('drain', done)
					child.once('close', done)
				})
			}
			onProgress?.(k + 1, count)
		}
		child.stdin.end()
		const code = await exited
		if (signal?.aborted) throw new Error('aborted')
		if (code !== 0) throw new Error(`Motion encode failed (ffmpeg exited ${code}): ${stderr.trim().slice(-600)}`)
		fs.renameSync(partial, outputPath)
	} catch (error) {
		child.kill('SIGKILL')
		try { fs.unlinkSync(partial) } catch { /* never written */ }
		throw error
	} finally {
		signal?.removeEventListener('abort', onAbort)
	}
}
