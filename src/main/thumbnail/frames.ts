import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import type { GrayFrame } from '@shared/thumbnail'

/**
 * The two ffmpeg calls "Generate thumbnail" makes per frame. Each is one input
 * seek and one output frame: milliseconds, never a render.
 */

/** Size of the scoring image. Forced, not aspect-true: scores only compare frames of the same video. */
export const GRAY_SIZE = { width: 96, height: 54 } as const

const run = (args: string[]) =>
	new Promise<Buffer>((resolve, reject) => {
		execFile(
			getFFmpegBinaryPath(),
			['-v', 'error', '-nostdin', ...args],
			{ encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 30_000 },
			(error, stdout) => (error ? reject(error) : resolve(stdout))
		)
	})

/** Raw luma of the frame at `sec`, or null when ffmpeg returned the wrong amount of picture. */
export async function grabGray(sourcePath: string, sec: number): Promise<GrayFrame | null> {
	const { width, height } = GRAY_SIZE
	const out = await run([
		'-ss', sec.toFixed(3), '-i', sourcePath, '-frames:v', '1',
		'-vf', `scale=${width}:${height}:flags=area,format=gray`, '-f', 'rawvideo', '-'
	])
	return out.length === width * height ? { width, height, data: new Uint8Array(out) } : null
}

/**
 * A full-size JPEG, capped at 1280 wide: the thumbnail is 1280x720, so more
 * pixels only make the Gemini upload heavier. Never upscaled.
 */
export async function grabStill(sourcePath: string, sec: number, outPath: string): Promise<void> {
	fs.mkdirSync(path.dirname(outPath), { recursive: true })
	await run([
		'-y', '-ss', sec.toFixed(3), '-i', sourcePath, '-frames:v', '1',
		'-vf', "scale='min(1280,iw)':-2", '-q:v', '2', outPath
	])
	if (!fs.existsSync(outPath)) throw new Error('ffmpeg wrote no frame')
}
