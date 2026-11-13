import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { getFFmpegBinaryPath, getFFprobeBinaryPath } from '../ffmpeg/binaries'
import { GENERATED_TO_BT709, RGB_TO_BT709, SDR_TAG_FILTER, colorAction, sourceColorFilter } from './colorPolicy'

const execFileAsync = promisify(execFile)

const HLG = { transfer: 'arib-std-b67', primaries: 'bt2020', matrix: 'bt2020nc' }
const DJI = { transfer: 'bt709', primaries: 'bt709', matrix: 'bt709' }

describe('colorAction', () => {
	it('leaves BT.709 footage, and a file that says nothing, alone', () => {
		expect(colorAction(DJI)).toBe('none')
		expect(colorAction(undefined)).toBe('none')
		expect(colorAction({})).toBe('none')
		expect(colorAction({ transfer: 'unknown', primaries: 'unspecified', matrix: 'unknown' })).toBe('none')
	})

	it('tone-maps HLG and PQ', () => {
		expect(colorAction(HLG)).toBe('tonemap')
		expect(colorAction({ transfer: 'smpte2084', primaries: 'bt2020' })).toBe('tonemap')
		// Probed before the matrix was recorded: the transfer alone is enough.
		expect(colorAction({ transfer: 'arib-std-b67' })).toBe('tonemap')
	})

	it('converts SDR in another matrix or primaries', () => {
		expect(colorAction({ transfer: 'bt709', primaries: 'bt2020', matrix: 'bt2020nc' })).toBe('convert')
		expect(colorAction({ transfer: 'smpte170m', primaries: 'smpte170m', matrix: 'smpte170m' })).toBe('convert')
		expect(colorAction({ matrix: 'bt470bg' })).toBe('convert')
		// An old probe has primaries but no matrix: BT.2020 primaries imply the BT.2020 matrix.
		expect(colorAction({ primaries: 'bt2020' })).toBe('convert')
	})
})

describe('sourceColorFilter', () => {
	it('is empty when nothing needs doing', () => {
		expect(sourceColorFilter(DJI)).toBe('')
		expect(sourceColorFilter(undefined)).toBe('')
	})

	it('names the input side of an HDR clip, so a re-tagged proxy is still read right', () => {
		const filter = sourceColorFilter(HLG)
		expect(filter).toContain('tin=arib-std-b67')
		expect(filter).toContain('pin=2020')
		expect(filter).toContain('min=2020_ncl')
		expect(filter).toContain('tonemap=tonemap=hable')
		expect(filter.endsWith('format=yuv420p')).toBe(true)
	})

	it('names the curve when it only moves matrix and primaries', () => {
		const filter = sourceColorFilter({ transfer: 'smpte170m', primaries: 'smpte170m', matrix: 'smpte170m' })
		expect(filter).toContain('min=170m')
		expect(filter).toContain('tin=709')
		expect(filter).not.toContain('tonemap')
	})
})

// ===== Against the real ffmpeg =====

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-color-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const ffmpeg = (args: string[]) => execFileAsync(getFFmpegBinaryPath(), ['-v', 'error', '-y', ...args], { encoding: 'buffer' })

async function tagsOf(file: string): Promise<string> {
	const { stdout } = await execFileAsync(getFFprobeBinaryPath(), [
		'-v', 'error', '-select_streams', 'v:0',
		'-show_entries', 'stream=pix_fmt,color_range,color_space,color_transfer,color_primaries', '-of', 'csv=p=0', file
	])
	return stdout.trim()
}

/** The first pixel of a clip as RGB, with the YUV read the way a BT.709 player reads it. */
async function bt709Pixel(chain: string, input: string[]): Promise<number[]> {
	const { stdout } = await ffmpeg([
		...input, '-vf', `${chain},scale=in_color_matrix=bt709:in_range=tv,format=rgb24`,
		'-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
	])
	return [...(stdout as Buffer).subarray(0, 3)]
}

describe('the export colour policy, against the real ffmpeg', () => {
	const red = [200, 60, 60]
	const near = (got: number[], want: number[], tolerance: number) =>
		got.forEach((v, i) => expect(Math.abs(v - want[i]), `channel ${i}: ${v} vs ${want[i]}`).toBeLessThanOrEqual(tolerance))

	let motion: string
	let hlg: string
	beforeAll(async () => {
		// A motion layer as the capture writes it: ARGB in a QuickTime file, nothing tagged.
		motion = path.join(dir, 'motion.mov')
		await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xC83C3C:s=64x64:r=5:d=0.4,format=argb', '-c:v', 'qtrle', '-pix_fmt', 'argb', motion])
		// An iPhone clip: HLG, BT.2020.
		hlg = path.join(dir, 'hlg.mov')
		// (H.264 with its header rewritten: the encoder's own colour flags do not carry a transfer.)
		await ffmpeg([
			'-f', 'lavfi', '-i', 'testsrc2=s=128x72:r=10:d=1', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
			'-bsf:v', 'h264_metadata=video_full_range_flag=0:colour_primaries=9:transfer_characteristics=18:matrix_coefficients=9', hlg
		])
	}, 60_000)

	it('the fixture really is HLG', async () => {
		expect(await tagsOf(hlg)).toContain('arib-std-b67')
	})

	it('a motion layer keeps its colours (the automatic RGB to YUV step does not: it is BT.601)', async () => {
		const before = await bt709Pixel('format=yuv420p', ['-i', motion])
		expect(Math.max(...before.map((v, i) => Math.abs(v - red[i])))).toBeGreaterThan(6) // the bug, measured
		const after = await bt709Pixel(`${RGB_TO_BT709},format=yuv420p`, ['-i', motion])
		near(after, red, 3)
	}, 30_000)

	it('a generated colour keeps its colours', async () => {
		const input = ['-f', 'lavfi', '-i', 'color=c=0xC83C3C:s=64x64:r=5:d=0.4']
		const before = await bt709Pixel('format=yuv420p', input)
		expect(Math.max(...before.map((v, i) => Math.abs(v - red[i])))).toBeGreaterThan(6) // YUV coded as BT.601
		near(await bt709Pixel(GENERATED_TO_BT709, input), red, 3)
	}, 30_000)

	it('an HLG clip leaves the graph as BT.709 SDR, and says so', async () => {
		const out = path.join(dir, 'sdr.mov')
		await ffmpeg([
			'-i', hlg, '-vf', `${sourceColorFilter(HLG)},scale=128:72,format=yuv420p,${SDR_TAG_FILTER}`,
			'-c:v', 'libx264', '-preset', 'ultrafast', out
		])
		// pix_fmt, range, matrix, transfer, primaries: every one of them BT.709 SDR.
		expect(await tagsOf(out)).toBe('yuv420p,tv,bt709,bt709,bt709')
	}, 30_000)

	it('footage that is already BT.709 is only stamped, and a file inherits that stamp whatever came first', async () => {
		// The clip the old export started with: HLG tags straight through, nothing converted.
		const raw = path.join(dir, 'raw-hlg.mov')
		await ffmpeg(['-i', hlg, '-vf', 'scale=128:72,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', raw])
		expect(await tagsOf(raw)).toContain('arib-std-b67')
		// The same graph with the tag filter: honest, whatever the source said.
		const tagged = path.join(dir, 'tagged.mov')
		await ffmpeg(['-i', raw, '-vf', `scale=128:72,format=yuv420p,${SDR_TAG_FILTER}`, '-c:v', 'libx264', '-preset', 'ultrafast', tagged])
		expect(await tagsOf(tagged)).toBe('yuv420p,tv,bt709,bt709,bt709')
	}, 30_000)
})
