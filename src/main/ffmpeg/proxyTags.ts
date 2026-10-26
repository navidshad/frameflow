import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { extname } from 'node:path'
import { promisify } from 'node:util'
import { getFFmpegBinaryPath, getFFprobeBinaryPath } from './binaries'

/**
 * Making the monitor show the pixels the export makes.
 *
 * The export is plain ffmpeg: it decodes a clip, turns it into RGB with the
 * clip's own matrix, and never converts colour any further. The monitor plays
 * the 480p proxy in a browser, which DOES: it reads the proxy's colour tags and
 * converts for the display. Two things then disagree.
 *
 *  - HDR (an iPhone's HLG, tagged BT.2020 / arib-std-b67) is tone-mapped by the
 *    browser and left flat by the export, so the same clip looked far more
 *    orange in the monitor than in the file.
 *  - Even ordinary SDR (BT.709) is lifted a little by the browser's transfer
 *    handling: 7 to 12 levels brighter in the shadows than the export.
 *
 * The fix is to tell the browser the proxy is already what it shows: keep the
 * clip's matrix (that is how its colours are decoded) but tag the transfer as
 * sRGB and the primaries as BT.709, so nothing further is applied. It is only
 * a tag: a stream copy, a few seconds for an hour of footage, no re-encode, and
 * ffmpeg (thumbnails, filmstrips, the export itself) ignores both tags.
 */

const execFileAsync = promisify(execFile)

/** What a proxy says about its colour. */
export interface VideoColorTags {
	codec: string
	height: number
	colorSpace?: string
	colorTransfer?: string
	colorPrimaries?: string
}

/** Matrix names ffmpeg and H.264 agree on, with the code the stream's own header uses. */
const MATRIX_CODE: Record<string, number> = { bt709: 1, smpte170m: 6, bt470bg: 5, bt2020nc: 9 }

/** What the monitor's tags should be for a proxy, or null when it already is (or cannot be tagged). */
export function monitorTagPlan(tags: VideoColorTags, ext: string): { matrix: string; matrixCode: number; format: 'mov' | 'mp4' } | null {
	const format = ext === '.mov' ? 'mov' : ext === '.mp4' ? 'mp4' : null
	// Only H.264 (what the proxy step makes); a WebM proxy or someone else's file is left alone.
	if (!format || tags.codec !== 'h264') return null
	// An untagged proxy is decoded by ffmpeg with its own guess: BT.601 up to 576 lines, BT.709 above.
	const known = tags.colorSpace && MATRIX_CODE[tags.colorSpace] !== undefined
	const matrix = known ? tags.colorSpace! : tags.height <= 576 ? 'smpte170m' : 'bt709'
	if (known && tags.colorTransfer === 'iec61966-2-1' && tags.colorPrimaries === 'bt709') return null
	return { matrix, matrixCode: MATRIX_CODE[matrix], format }
}

export async function probeColorTags(file: string): Promise<VideoColorTags | null> {
	try {
		const { stdout } = await execFileAsync(getFFprobeBinaryPath(), [
			'-v', 'error', '-select_streams', 'v:0',
			'-show_entries', 'stream=codec_name,height,color_space,color_transfer,color_primaries',
			'-of', 'json', file
		], { timeout: 20_000 })
		const s = JSON.parse(stdout).streams?.[0]
		if (!s) return null
		const tag = (v?: string) => (v && v !== 'unknown' && v !== 'unspecified' ? v : undefined)
		return { codec: s.codec_name, height: Number(s.height) || 0, colorSpace: tag(s.color_space), colorTransfer: tag(s.color_transfer), colorPrimaries: tag(s.color_primaries) }
	} catch {
		return null
	}
}

/**
 * Tag one proxy for the monitor (see the top of this file), in place and
 * atomically: written beside it, then renamed over it, so a monitor that has
 * the old file open keeps playing it. True when the file was changed.
 */
export async function tagProxyForMonitor(file: string): Promise<boolean> {
	if (!fs.existsSync(file)) return false
	const tags = await probeColorTags(file)
	if (!tags) return false
	const ext = extname(file).toLowerCase()
	const plan = monitorTagPlan(tags, ext)
	if (!plan) return false
	const temp = `${file}.tagging${ext}`
	try {
		await execFileAsync(getFFmpegBinaryPath(), [
			'-v', 'error', '-y', '-i', file, '-map', '0:v', '-map', '0:a?', '-c', 'copy',
			// The stream's own header (what a browser's decoder reads) and the container's (what its demuxer reads).
			'-bsf:v', `h264_metadata=colour_primaries=1:transfer_characteristics=13:matrix_coefficients=${plan.matrixCode}`,
			'-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', plan.matrix,
			'-f', plan.format, temp
		], { timeout: 30 * 60_000 })
		fs.renameSync(temp, file)
		return true
	} finally {
		try { fs.rmSync(temp, { force: true }) } catch { /* nothing left to remove */ }
	}
}
