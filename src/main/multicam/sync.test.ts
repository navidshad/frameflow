import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import { decodeMono, measureQuality, rankSoundSources, syncRecordings } from './sync'

/**
 * The sync against REAL ffmpeg: two recordings of one moment, made so the
 * answer is known — the second started 1.37 s later, its clock runs 100 ppm
 * fast, its microphone is quieter and noisier. Pure-math tests cannot catch a
 * decode that shifts the sound, and that is the bug that would ruin a sync.
 */

const execFileAsync = promisify(execFile)
const OFFSET = 1.37
const RATE = 1.0001
let dir = ''
let ref = '', cam2 = '', silent = ''

beforeAll(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), 'ff-multicam-'))
	ref = join(dir, 'cam1.m4a')
	cam2 = join(dir, 'cam2.mp4')
	silent = join(dir, 'silent.mp4')
	const ff = getFFmpegBinaryPath()
	// "Speech": pink noise switched on and off at an irregular rhythm, like phrases.
	await execFileAsync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=600:c=pink:r=48000:seed=7',
		'-af', "volume='if(lt(mod(t*1.7+sin(t*0.37)*3,2.3),1.1),1,0.02)':eval=frame", '-c:a', 'aac', '-b:a', '128k', ref])
	// Cam 2: the same moment from 1.37 s on, its clock 100 ppm fast, quieter, with its own hiss, plus a picture.
	await execFileAsync(ff, ['-v', 'error', '-y', '-i', ref,
		'-f', 'lavfi', '-i', 'anoisesrc=d=600:c=white:r=48000:seed=3:a=0.03',
		'-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=10:d=600',
		'-filter_complex', `[0:a]atrim=start=${OFFSET},asetpts=PTS-STARTPTS,asetrate=48000*${RATE},aresample=48000,volume=0.4[s];[s][1:a]amix=inputs=2:duration=first:normalize=0[a]`,
		'-map', '2:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', cam2])
	// A camera with its microphone off: picture only.
	await execFileAsync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=10:d=30',
		'-c:v', 'libx264', '-preset', 'ultrafast', silent])
}, 120_000)

afterAll(async () => {
	if (dir) await fs.rm(dir, { recursive: true, force: true })
})

describe('syncRecordings', () => {
	it('finds the offset to a few milliseconds and the drift to a few ppm', async () => {
		const members = await syncRecordings([{ assetId: 'cam1', path: ref }, { assetId: 'cam2', path: cam2 }])
		expect(members[0]).toMatchObject({ assetId: 'cam1', offset: 0, rate: 1, sync: { method: 'reference' } })
		const m = members[1]
		expect(m.sync).toMatchObject({ method: 'audio', confidence: 'strong' })
		// Within 5 ms: a sixth of a frame at 30 fps.
		expect(Math.abs(m.offset - OFFSET)).toBeLessThan(0.005)
		expect(Math.abs(m.sync.driftPpm - 100)).toBeLessThan(5)
		expect(m.sync.windows!.agreed).toBeGreaterThanOrEqual(10)
	}, 120_000)

	it('falls back to the recording times for a camera without sound, and says it failed', async () => {
		const t = Date.UTC(2026, 6, 17, 17, 11, 55)
		const members = await syncRecordings([
			{ assetId: 'cam1', path: ref, startedAt: t },
			{ assetId: 'silent', path: silent, startedAt: t + 2000 }
		])
		expect(members[1]).toMatchObject({ offset: 2, rate: 1, sync: { method: 'recorded', confidence: 'failed' } })
		expect(members[1].quality).toBeNull()
	}, 120_000)
})

describe('sound quality', () => {
	it('prefers the cleaner microphone', async () => {
		const [clean, noisy] = await Promise.all([decodeMono(ref), decodeMono(cam2)])
		const q1 = measureQuality(clean)!, q2 = measureQuality(noisy)!
		expect(q1.snrDb).toBeGreaterThan(q2.snrDb)
		expect(rankSoundSources([{ assetId: 'cam2', quality: q2 }, { assetId: 'cam1', quality: q1 }])).toEqual(['cam1', 'cam2'])
	}, 60_000)

	it('prefers the clearer voice even if it clips a little; clipping only breaks a tie', () => {
		const clearer = { levelDb: -6, noiseDb: -30, snrDb: 24, clipped: 0.0012 }
		const clean = { levelDb: -12, noiseDb: -31, snrDb: 19, clipped: 0 }
		expect(rankSoundSources([{ assetId: 'clean', quality: clean }, { assetId: 'clearer', quality: clearer }])[0]).toBe('clearer')
		const tied = { ...clean, snrDb: 24.2 }
		expect(rankSoundSources([{ assetId: 'clearer', quality: clearer }, { assetId: 'tied', quality: tied }])[0]).toBe('tied')
	})
})
