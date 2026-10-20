import ffmpeg from 'fluent-ffmpeg'
import { runCommand } from './render'

/**
 * Normalise the finished mix and hand back the normalised file.
 *
 * Every other export step stitches with a stream copy; this re-encodes the
 * AUDIO only (`-c:v copy`), so it costs seconds rather than the minutes a
 * caption burn does. Single-pass `loudnorm`: the two-pass form measures first
 * and is more accurate, but it doubles the work for a difference nobody hears
 * on speech.
 *
 * -14 LUFS with a -1 dBTP ceiling is what YouTube, Spotify and TikTok all
 * normalise to, so hitting it means nothing gets turned down on upload.
 */
export async function normaliseLoudness(options: {
	sourcePath: string
	signal: AbortSignal
	onProgress?: (percent: number) => void
}): Promise<string> {
	const { sourcePath, signal, onProgress } = options
	const outputPath = sourcePath.replace(/\.mp4$/, '') + '.loud.mp4'
	const command = ffmpeg()
		.input(sourcePath)
		.audioFilters('loudnorm=I=-14:TP=-1:LRA=11')
		.outputOptions([
			'-c:v', 'copy',
			'-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
			'-movflags', '+faststart'
		])
	await runCommand(command, outputPath, signal, onProgress)
	return outputPath
}
