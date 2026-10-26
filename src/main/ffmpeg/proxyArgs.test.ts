import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { getFFmpegBinaryPath, getFFprobeBinaryPath } from './binaries'
import { proxyArgs, proxyModes } from './proxyArgs'
import { toLeanAudio, toLowResolution } from './index'

const mac = { isMac: true, isWebm: false }

describe('proxyModes', () => {
	it('tries the GPU first on a Mac, then hardware decode, then software', () => {
		expect(proxyModes(mac)).toEqual(['gpu', 'hardware', 'software'])
	})
	it('keeps rotated phone footage off the GPU scaler, which would leave it sideways', () => {
		expect(proxyModes({ ...mac, rotated: true })).toEqual(['hardware', 'software'])
	})
	it('uses software alone off a Mac, and for WebM', () => {
		expect(proxyModes({ isMac: false, isWebm: false })).toEqual(['software'])
		expect(proxyModes({ isMac: true, isWebm: true })).toEqual(['software'])
	})
})

describe('proxyArgs', () => {
	it('decodes AND scales on the GPU, and drops 60 fps with -r (the fps filter cannot read GPU frames)', () => {
		const gpu = proxyArgs('gpu', { ...mac, sourceFps: 59.94 })
		expect(gpu.input).toEqual(['-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld'])
		expect(gpu.output.join(' ')).toContain('-vf scale_vt=w=-2:h=480')
		expect(gpu.output.join(' ')).toContain('-r 30')
		expect(gpu.output.join(' ')).not.toContain('fps=')
		expect(gpu.output).toContain('h264_videotoolbox')
	})
	it('hardware decodes sources above 30 fps too (it used to fall back to software for them)', () => {
		const hw = proxyArgs('hardware', { ...mac, sourceFps: 60 })
		expect(hw.input).toEqual(['-hwaccel', 'videotoolbox'])
		expect(hw.output.join(' ')).toContain('-vf fps=30,scale=-2:480')
	})
	it('never caps a 30 fps or slower source (that would duplicate frames)', () => {
		for (const mode of ['gpu', 'hardware', 'software'] as const) {
			for (const fps of [24, 29.97, 30, undefined]) {
				const args = proxyArgs(mode, { ...mac, sourceFps: fps }).output.join(' ')
				expect(args).not.toMatch(/fps=|-r 30/)
			}
		}
	})
	it('software uses no GPU option at all', () => {
		const sw = proxyArgs('software', { ...mac, sourceFps: 60 })
		expect(sw.input).toEqual([])
		expect(sw.output.join(' ')).toContain('fps=30,scale=-2:480')
	})
	it('picks the encoder by platform', () => {
		expect(proxyArgs('software', { isMac: false, isWebm: false }).output).toContain('libx264')
		expect(proxyArgs('software', { isMac: true, isWebm: true }).output).toContain('libvpx-vp9')
	})
})

/** The real thing: small generated clips through the real ffmpeg, so the arguments are known to work together. */
const execFileAsync = promisify(execFile)
let dir = ''
const probe = async (file: string) => {
	const { stdout } = await execFileAsync(getFFprobeBinaryPath(), ['-v', 'error', '-select_streams', 'v:0',
		'-show_entries', 'stream=width,height,r_frame_rate,codec_name', '-of', 'json', file])
	const s = JSON.parse(stdout).streams[0]
	const [n, d] = String(s.r_frame_rate).split('/').map(Number)
	return { width: s.width as number, height: s.height as number, fps: n / d, codec: s.codec_name as string }
}

describe('toLowResolution (real ffmpeg)', () => {
	let landscape60 = '', landscape30 = '', portrait = '', withSound = ''
	beforeAll(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'ff-proxy-'))
		const ff = getFFmpegBinaryPath()
		landscape60 = join(dir, 'land60.mp4')
		landscape30 = join(dir, 'land30.mp4')
		portrait = join(dir, 'portrait.mp4')
		withSound = join(dir, 'sound.mp4')
		const make = (rate: number, out: string) => execFileAsync(ff, ['-v', 'error', '-y', '-f', 'lavfi',
			'-i', `testsrc2=s=1280x720:r=${rate}:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', out])
		await make(60, landscape60)
		await make(30, landscape30)
		// A phone held upright: stored 1280x720, turned by a tag.
		await execFileAsync(ff, ['-v', 'error', '-y', '-display_rotation:v', '90', '-i', landscape30, '-c', 'copy', portrait])
		await execFileAsync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=3',
			'-f', 'lavfi', '-i', 'sine=frequency=440:duration=3:sample_rate=48000',
			'-f', 'lavfi', '-i', 'sine=frequency=880:duration=3:sample_rate=48000',
			'-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'libx264', '-c:a', 'aac', '-ac', '2', withSound])
	}, 120_000)
	afterAll(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }) })

	it('makes a 480p proxy of a 60 fps source at 30 fps', async () => {
		const out = await toLowResolution(landscape60, dir, undefined, undefined, { sourceFps: 60 })
		expect(await probe(out)).toMatchObject({ width: 854, height: 480, codec: 'h264' })
		expect((await probe(out)).fps).toBeCloseTo(30, 0)
	}, 60_000)

	it('keeps a 30 fps source at 30 fps', async () => {
		const out = await toLowResolution(landscape30, dir, undefined, undefined, { sourceFps: 30 })
		expect(await probe(out)).toMatchObject({ width: 854, height: 480 })
		expect((await probe(out)).fps).toBeCloseTo(30, 0)
	}, 60_000)

	it('turns a rotated source upright instead of leaving it sideways', async () => {
		const out = await toLowResolution(portrait, dir, undefined, undefined, { sourceFps: 30 })
		const { width, height } = await probe(out)
		expect(height).toBe(480)
		expect(width).toBeLessThan(height) // portrait: 270 x 480, not 854 x 480
	}, 60_000)

	it('stops on abort', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(toLowResolution(landscape30, dir, undefined, controller.signal)).rejects.toThrow(/abort/i)
	})

	it('pulls lean audio: mono, 16 kHz, the FIRST track, from the original', async () => {
		const out = await toLeanAudio(withSound, dir)
		const { stdout } = await execFileAsync(getFFprobeBinaryPath(), ['-v', 'error', '-select_streams', 'a',
			'-show_entries', 'stream=channels,sample_rate,codec_name:format=duration', '-of', 'json', out])
		const info = JSON.parse(stdout)
		expect(info.streams).toHaveLength(1)
		expect(info.streams[0]).toMatchObject({ channels: 1, sample_rate: '16000', codec_name: 'mp3' })
		expect(Number(info.format.duration)).toBeGreaterThan(2.8)
		expect(Number(info.format.duration)).toBeLessThan(3.3)
	}, 60_000)
})
