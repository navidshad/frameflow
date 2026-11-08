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
	/** Added to the file name before the extension, so a same-container file never lands on the source. */
	suffix: string
	label: string
	/** Output options; the input is the finished h264 file. */
	options: string[]
}

/** The audio every delivery shares, apart from ProRes' PCM. */
const AAC_COPY = ['-c:a', 'copy']

/**
 * H.265 / HEVC in an mp4.
 *
 * `hvc1`, not the `hev1` ffmpeg writes by default: QuickTime, Safari and iOS
 * refuse to play `hev1`.
 *
 * Settings are measured, not guessed. On a 10 s 1080p clip made from an 8 Mb/s
 * h264 source (SSIM against it, size, encode time on an M-series Mac):
 *   hevc_videotoolbox -q:v 65   0.989   2.9 MB   2 s   <- chosen on macOS
 *   libx265 medium crf 23       0.990   2.5 MB   7 s   <- the software fallback
 *   hevc_videotoolbox -q:v 50   0.980   1.4 MB
 *   hevc_videotoolbox -b:v 5M   —       6.4 MB   (bitrate mode overshoots a quiet clip)
 * So the hardware encoder at 65 lands where software medium/crf 23 does, three
 * times faster, and the file is a quarter of the h264 it came from.
 */
export const HEVC_HARDWARE: string[] = [
	'-c:v', 'hevc_videotoolbox', '-q:v', '65', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p'
]
export const HEVC_SOFTWARE: string[] = [
	'-c:v', 'libx265', '-preset', 'medium', '-crf', '23', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p',
	'-x265-params', 'log-level=error'
]

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
	h265: {
		extension: '.mp4',
		suffix: '_h265',
		label: 'MP4 (H.265)',
		options: [...HEVC_SOFTWARE, ...AAC_COPY, '-movflags', '+faststart']
	},
	prores: {
		extension: '.mov',
		suffix: '',
		label: 'ProRes 422 HQ',
		options: [
			'-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0',
			'-pix_fmt', 'yuv422p10le',
			'-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'
		]
	}
}

/**
 * The output options for `format`, or null when it needs no pass. HEVC takes the
 * hardware encoder where there is one; everything else has a single recipe.
 */
export function deliveryOptions(format: DeliveryFormat, hardware: boolean): string[] | null {
	const spec = DELIVERY[format]
	if (!spec) return null
	if (format === 'h265' && hardware) return [...HEVC_HARDWARE, ...AAC_COPY, '-movflags', '+faststart']
	return spec.options
}

/** Where the delivered file goes: beside the source, never on top of it. */
export function deliveryPath(sourcePath: string, spec: DeliverySpec): string {
	return sourcePath.replace(/\.mp4$/, '') + spec.suffix + spec.extension
}

/** The hardware HEVC encoder exists on macOS builds only. */
const HAS_HARDWARE_HEVC = process.platform === 'darwin'

/**
 * Transcode the finished file to `format`, returning the new path.
 *
 * Returns null for a format that needs no pass, so the caller can keep what it
 * already has rather than paying for an identity encode.
 *
 * HEVC tries the hardware encoder first and, if that fails for any reason other
 * than the user cancelling (older Intel Macs, a busy media engine, a size it
 * refuses), repeats the pass with software x265 rather than failing the export.
 */
export async function deliver(options: {
	sourcePath: string
	format: DeliveryFormat
	signal: AbortSignal
	onProgress?: (percent: number) => void
	/** Test seam: pretend the platform has / lacks the hardware HEVC encoder. */
	hardware?: boolean
}): Promise<string | null> {
	const spec = DELIVERY[options.format]
	if (!spec) return null

	const outputPath = deliveryPath(options.sourcePath, spec)
	const hardware = options.hardware ?? HAS_HARDWARE_HEVC
	const run = (outputOptions: string[]) =>
		runCommand(ffmpeg().input(options.sourcePath).outputOptions(outputOptions), outputPath, options.signal, options.onProgress)

	if (options.format === 'h265' && hardware) {
		try {
			await run(deliveryOptions('h265', true)!)
			return outputPath
		} catch (error) {
			if (options.signal.aborted) throw error
			console.warn('[deliver] Hardware HEVC failed, using software x265:', (error as Error)?.message)
		}
	}
	await run(deliveryOptions(options.format, false)!)
	return outputPath
}
