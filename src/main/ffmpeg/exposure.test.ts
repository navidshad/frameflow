import { describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getFFmpegBinaryPath } from './binaries'
import { effectChain, exposureShiftLevels } from '@shared/effects'

/**
 * The monitor shows Exposure as an addition of exposureShiftLevels(v) to every
 * channel. This holds that to the real `eq` filter, through the fragment the
 * export builds, on a frame the way the export has it (YUV): if the filter's
 * behaviour changes, the preview drifts and this fails instead.
 */

const execFileAsync = promisify(execFile)

async function exportPixel(amount: number, rgb: [number, number, number]): Promise<number[]> {
	const [fragment] = effectChain([{ id: 'x', kind: 'exposure', params: { amount } }], 'video')
	const hex = rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
	const { stdout } = await execFileAsync(getFFmpegBinaryPath(), [
		'-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=16x16:d=0.04,format=yuv420p`,
		'-vf', fragment, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
	], { encoding: 'buffer' })
	return [...(stdout as Buffer).subarray(0, 3)]
}

describe('Exposure preview', () => {
	it.each([-0.4, -0.2, -0.05, 0.07, 0.15, 0.3])('adds what ffmpeg adds at %f, to within five levels', async (amount) => {
		const swatch: [number, number, number] = [120, 140, 100]
		const base = await exportPixel(0.0001, swatch) // the swatch as the YUV round trip leaves it
		const exported = await exportPixel(amount, swatch)
		const shift = exposureShiftLevels(amount)
		// Both clamp at the ends of the range: a channel cannot go below 0 or above 255.
		exported.forEach((v, i) => expect(Math.abs(v - Math.min(255, Math.max(0, base[i] + shift)))).toBeLessThanOrEqual(5))
	}, 30_000)
})
