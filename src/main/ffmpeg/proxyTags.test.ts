import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getFFmpegBinaryPath } from './binaries'
import { monitorTagPlan, probeColorTags, tagProxyForMonitor } from './proxyTags'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-proxytags-'))
const hlg = path.join(dir, 'iphone_480p.mov')
const sdr = path.join(dir, 'dji_480p.mp4')
const ffmpeg = (...args: string[]) => execFileSync(getFFmpegBinaryPath(), ['-y', '-v', 'error', ...args])

beforeAll(() => {
	// A small H.264 proxy the way the app makes it from an iPhone: HLG HDR tags, BT.2020 matrix.
	ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
		'-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', hlg)
	ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
		'-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', sdr)
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('monitorTagPlan', () => {
	const tags = { codec: 'h264', height: 480, colorSpace: 'bt2020nc', colorTransfer: 'arib-std-b67', colorPrimaries: 'bt2020' }
	it('keeps the clip\'s own matrix and says sRGB for the rest', () => {
		expect(monitorTagPlan(tags, '.mov')).toEqual({ matrix: 'bt2020nc', matrixCode: 9, format: 'mov' })
		expect(monitorTagPlan({ ...tags, colorSpace: 'bt709' }, '.mp4')).toEqual({ matrix: 'bt709', matrixCode: 1, format: 'mp4' })
	})
	it('guesses the matrix the way ffmpeg does for an untagged proxy', () => {
		expect(monitorTagPlan({ codec: 'h264', height: 480 }, '.mp4')?.matrix).toBe('smpte170m')
		expect(monitorTagPlan({ codec: 'h264', height: 720 }, '.mp4')?.matrix).toBe('bt709')
	})
	it('leaves alone what is already tagged, and what it cannot tag', () => {
		expect(monitorTagPlan({ ...tags, colorSpace: 'bt709', colorTransfer: 'iec61966-2-1', colorPrimaries: 'bt709' }, '.mp4')).toBeNull()
		expect(monitorTagPlan({ ...tags, codec: 'vp9' }, '.webm')).toBeNull()
		expect(monitorTagPlan({ ...tags, codec: 'hevc' }, '.mov')).toBeNull()
	})
})

describe('tagProxyForMonitor (real ffmpeg)', () => {
	it('re-tags an HLG proxy without touching its pictures, once', async () => {
		const pixels = () => execFileSync(getFFmpegBinaryPath(), ['-v', 'error', '-i', hlg, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']).toString('hex')
		const before = pixels()
		expect(await tagProxyForMonitor(hlg)).toBe(true)
		expect(await probeColorTags(hlg)).toMatchObject({ colorSpace: 'bt2020nc', colorTransfer: 'iec61966-2-1', colorPrimaries: 'bt709' })
		// A stream copy: the picture ffmpeg decodes is the same one (the matrix did not change).
		expect(pixels()).toBe(before)
		// Nothing left behind, and a second call has nothing to do.
		expect(fs.readdirSync(dir).filter((f) => f.includes('.tagging'))).toEqual([])
		expect(await tagProxyForMonitor(hlg)).toBe(false)
	}, 60_000)

	it('tags an ordinary BT.709 proxy as sRGB too', async () => {
		expect(await tagProxyForMonitor(sdr)).toBe(true)
		expect(await probeColorTags(sdr)).toMatchObject({ colorSpace: 'bt709', colorTransfer: 'iec61966-2-1', colorPrimaries: 'bt709' })
	}, 60_000)

	it('does nothing for a file that is not there', async () => {
		expect(await tagProxyForMonitor(path.join(dir, 'missing.mov'))).toBe(false)
	})
})
