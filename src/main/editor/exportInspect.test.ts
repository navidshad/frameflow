import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import { contactSheet, measureExportLoudness, probeExport, sheetClock, sheetTimes } from './exportInspect'

/** Runs the real ffmpeg on a small generated file, like renderPipeline.test.ts. */

describe('sheetTimes', () => {
	it('spans the range asked for, widening the step to fit the cap', () => {
		expect(sheetTimes(10, { everySec: 2 })).toEqual([0, 2, 4, 6, 8])
		const many = sheetTimes(600, { everySec: 1 })
		expect(many).toHaveLength(48)
		expect(many[0]).toBe(0)
		expect(many.at(-1)).toBeCloseTo(599.95, 1)
		expect(sheetTimes(10, { times: [3, 1, 99, 1] })).toEqual([1, 3, 9.95])
		expect(sheetTimes(10, { fromSec: 4, toSec: 6, everySec: 1 })).toEqual([4, 5, 6])
	})

	it('labels', () => {
		expect(sheetClock(83.44)).toBe('1:23.4')
		expect(sheetClock(5)).toBe('0:05.0')
	})
})

describe('export inspection on a real file', () => {
	let dir: string
	let file: string

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-inspect-'))
		file = path.join(dir, 'clip.mp4')
		execFileSync(getFFmpegBinaryPath(), [
			'-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4',
			'-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
			'-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', file
		])
	})
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

	it('reads what the file is', async () => {
		const facts = await probeExport(file)
		expect(facts).toMatchObject({ width: 640, height: 360, fps: 30, videoCodec: 'h264', audioCodec: 'aac' })
		expect(facts.durationSec).toBeGreaterThan(3.9)
		expect(facts.bytes).toBeGreaterThan(1000)
	})

	it('tiles labelled frames into one picture', async () => {
		const sheet = await contactSheet(file, [0, 1, 2, 3], { tileWidth: 200, columns: 2 })
		expect(sheet.columns).toBe(2)
		expect(sheet.rows).toBe(2)
		expect(sheet.jpeg.subarray(0, 2).toString('hex')).toBe('ffd8')
		const out = path.join(dir, 'sheet.jpg')
		fs.writeFileSync(out, sheet.jpeg)
		const facts = await probeExport(out)
		// 2 tiles of 200 plus padding and margins.
		expect(facts.width).toBeGreaterThan(400)
		expect(facts.height).toBeGreaterThan(220)
	})

	it('measures loudness', async () => {
		const loud = await measureExportLoudness(file)
		expect(loud.lufs).not.toBeNull()
		expect(loud.lufs!).toBeLessThan(0)
	})
})
