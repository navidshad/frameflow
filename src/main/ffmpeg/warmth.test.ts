import { describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getFFmpegBinaryPath } from './binaries'
import { effectChain, kelvinGains } from '@shared/effects'

/**
 * The monitor shows Warmth with gains copied from ffmpeg's `colortemperature`.
 * This holds that copy to the real filter, through the same fragment the
 * export builds: if ffmpeg ever changes its fit, the preview drifts and this
 * fails instead of the colour quietly disagreeing.
 */

const execFileAsync = promisify(execFile)
const SWATCH = [200, 180, 160] as const

async function exportPixel(kelvin: number): Promise<number[]> {
	const [fragment] = effectChain([{ id: 'w', kind: 'warmth', params: { kelvin } }], 'video')
	const { stdout } = await execFileAsync(getFFmpegBinaryPath(), [
		'-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xC8B4A0:s=16x16:d=0.04,format=gbrp',
		'-vf', fragment, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
	], { encoding: 'buffer' })
	return [...(stdout as Buffer).subarray(0, 3)]
}

describe('Warmth preview gains', () => {
	it.each([2000, 3000, 5000, 9000, 12000])('match ffmpeg at %i K to within one level', async (kelvin) => {
		const gains = kelvinGains(kelvin)
		const preview = SWATCH.map((v, i) => v * gains[i])
		const exported = await exportPixel(kelvin)
		preview.forEach((v, i) => expect(Math.abs(v - exported[i])).toBeLessThanOrEqual(1))
	}, 30_000)
})
