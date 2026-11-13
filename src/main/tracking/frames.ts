import { spawn } from 'node:child_process'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import type { Frame } from './image'

/**
 * A stretch of a video as raw frames, each with its exact SOURCE time.
 *
 * ffmpeg decodes and scales; the frames arrive as bgr24 on a pipe. The time of
 * each frame comes from ffmpeg's own `showinfo` line for it rather than from
 * counting at an assumed rate, so a variable-rate phone clip still lands every
 * sample on the frame it was measured on.
 */

export interface TimedFrame extends Frame {
	/** Seconds in the source file. */
	t: number
}

export interface ReadOptions {
	fromSec: number
	toSec: number
	/** The picture's longer side, in pixels. Never scaled up. */
	longSide: number
}

const scaleFilter = (long: number): string =>
	`scale=w='if(gte(iw,ih),min(${long},iw),-2)':h='if(gte(iw,ih),-2,min(${long},ih))':flags=bilinear`

export async function* readFrames(file: string, options: ReadOptions): AsyncGenerator<TimedFrame> {
	const from = Math.max(0, options.fromSec)
	const duration = Math.max(0.001, options.toSec - from)
	const proc = spawn(getFFmpegBinaryPath(), [
		'-hide_banner', '-nostdin', '-nostats', '-ss', from.toFixed(4), '-i', file, '-t', duration.toFixed(4),
		'-an', '-sn', '-dn', '-vf', `${scaleFilter(options.longSide)},showinfo`,
		'-fps_mode', 'passthrough', '-pix_fmt', 'bgr24', '-f', 'rawvideo', '-'
	], { stdio: ['ignore', 'pipe', 'pipe'] })

	const times: number[] = []
	let size: { w: number; h: number } | null = null
	let log = ''
	let ended = false
	let wake: (() => void) | null = null
	const notify = () => { wake?.(); wake = null }
	proc.stderr.setEncoding('utf8')
	proc.stderr.on('data', (text: string) => {
		log = (log + text).slice(-8000)
		for (const line of text.split('\n')) {
			if (!line.includes('Parsed_showinfo')) continue
			const t = line.match(/pts_time:\s*(-?[\d.]+)/)
			const s = line.match(/\bs:(\d+)x(\d+)/)
			if (t) times.push(from + Number(t[1]))
			if (s && !size) size = { w: Number(s[1]), h: Number(s[2]) }
		}
		notify()
	})
	const closed = new Promise<number | null>((resolve) => proc.on('close', (code) => { ended = true; notify(); resolve(code) }))
	proc.on('error', () => { ended = true; notify() })
	/** Waits for stderr to say more (a frame's line can trail the frame itself by a moment). */
	const until = async (ready: () => boolean) => {
		while (!ready() && !ended) await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, 50) })
	}

	let pending: Buffer[] = []
	let have = 0
	let index = 0
	try {
		for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
			pending.push(chunk)
			have += chunk.length
			await until(() => !!size)
			if (!size) break
			const { w, h } = size as { w: number; h: number }
			const bytes = w * h * 3
			while (have >= bytes) {
				const all = pending.length === 1 ? pending[0] : Buffer.concat(pending)
				const data = new Uint8Array(bytes)
				data.set(all.subarray(0, bytes))
				const rest = all.subarray(bytes)
				pending = rest.length ? [rest] : []
				have = rest.length
				await until(() => times.length > index)
				const t = times[index] ?? (index ? times[times.length - 1] + 1 / 30 : from)
				index++
				yield { data, width: w, height: h, t }
			}
		}
		const code = await closed
		if (code && !index) throw new Error(`ffmpeg could not read frames from the file: ${log.split('\n').filter(Boolean).slice(-2).join(' ')}`)
	} finally {
		if (!ended) proc.kill('SIGKILL')
	}
}

/**
 * The same frames latest-first, for following an object back in time. Video
 * only decodes forwards, so this reads a few seconds at a time, working
 * backwards, and hands each stretch over in reverse.
 */
export async function* readFramesBackward(file: string, options: ReadOptions & { chunkSec?: number }): AsyncGenerator<TimedFrame> {
	const chunk = options.chunkSec ?? 2.5
	let end = options.toSec
	while (end > options.fromSec + 1e-4) {
		const start = Math.max(options.fromSec, end - chunk)
		const frames: TimedFrame[] = []
		for await (const frame of readFrames(file, { ...options, fromSec: start, toSec: end })) {
			if (frame.t < end - 1e-4) frames.push(frame)
		}
		for (let i = frames.length - 1; i >= 0; i--) yield frames[i]
		// The next stretch ends where this one's first frame began, so no frame is read twice.
		end = frames.length ? Math.min(start, frames[0].t) : start
		if (!frames.length && start <= options.fromSec) break
	}
}
