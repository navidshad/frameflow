import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getFFmpegBinaryPath } from './binaries'
import { detectSilence, SILENCE_OUTPUT_OPTIONS } from './index'

/** Against the real bundled ffmpeg: a camera-like file, picture and sound, with one known pause. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-silence-'))
const clip = path.join(dir, 'talk.mp4')

beforeAll(() => {
	// 2 s tone, 1.5 s silence, 2 s tone, under a moving picture.
	execFileSync(getFFmpegBinaryPath(), [
		'-y', '-v', 'error',
		'-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=5.5',
		'-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=5.5',
		'-filter_complex', "[1:a]volume=enable='between(t,2,3.5)':volume=0[a]",
		'-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip
	])
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('detectSilence', () => {
	it('reads only the sound: the picture is never decoded', () => {
		expect(SILENCE_OUTPUT_OPTIONS).toContain('-vn')
	})

	it('finds the pause in a file with a picture', async () => {
		const regions = await detectSilence(clip, { noiseDb: -40, minDurationSec: 0.8 })
		expect(regions).toHaveLength(1)
		expect(regions[0].start).toBeCloseTo(2, 1)
		expect(regions[0].end).toBeCloseTo(3.5, 1)
	})
})
