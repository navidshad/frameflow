import ffmpeg from 'fluent-ffmpeg'
import { runCommand } from './render'
import type { DeliveryFormat } from '@shared/types'

/**
 * Delivery: the last pass, which decides what kind of file comes out.
 *
 * The render itself always produces h264 intermediates — they have to be
 * identical for `concat -c copy` to work at all — so a different deliverable is
 * a transcode of the finished file rather than a different pipeline. That costs
 * one encode, and it keeps every stage before it unchanged.
 */

export interface DeliverySpec {
	extension: string
	label: string
	/** Output options; the input is the finished h264 file. */
	options: string[]
}

/**
 * ProRes 422 HQ via `prores_ks`, not `prores_videotoolbox`: the hardware
 * encoder is faster but takes its profile as a bare number and silently
 * ignores several of the flags an editor cares about. Delivery is the one
 * place where predictable beats fast.
 *
 * PCM audio is the ProRes convention — an intermediate that will be re-encoded
 * again downstream should not carry a lossy track.
 */
export const DELIVERY: Record<DeliveryFormat, DeliverySpec | null> = {
	// The default: the file the render already produced, no second encode.
	h264: null,
	prores: {
		extension: '.mov',
		label: 'ProRes 422 HQ',
		options: [
			'-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0',
			'-pix_fmt', 'yuv422p10le',
			'-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'
		]
	}
}

/**
 * Transcode the finished file to `format`, returning the new path.
 *
 * Returns null for a format that needs no pass, so the caller can keep what it
 * already has rather than paying for an identity encode.
 */
export async function deliver(options: {
	sourcePath: string
	format: DeliveryFormat
	signal: AbortSignal
	onProgress?: (percent: number) => void
}): Promise<string | null> {
	const spec = DELIVERY[options.format]
	if (!spec) return null

	const outputPath = options.sourcePath.replace(/\.mp4$/, '') + spec.extension
	const command = ffmpeg().input(options.sourcePath).outputOptions(spec.options)
	await runCommand(command, outputPath, options.signal, options.onProgress)
	return outputPath
}
