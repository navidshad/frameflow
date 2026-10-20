import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import { analyzeAudioFile, getAudioAnalysis, spectrogramBase64 } from './audioAnalysis'

/**
 * Against the real bundled ffmpeg, like the other render tests: a synthesised
 * tone of known level, so "loud" and "quiet" are facts rather than guesses.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-audio-'))
const loud = path.join(dir, 'loud.wav')
const quiet = path.join(dir, 'quiet.wav')
const silentVideo = path.join(dir, 'picture-only.mp4')

const ffmpeg = (...args: string[]) => execFileSync(getFFmpegBinaryPath(), ['-y', '-v', 'error', ...args])

beforeAll(() => {
	ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-af', 'volume=0.8', loud)
	ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-af', 'volume=0.05', quiet)
	ffmpeg('-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1', '-pix_fmt', 'yuv420p', silentVideo)
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('analyzeAudioFile', () => {
	it('measures the length, a waveform at 50 buckets a second, and loudness', async () => {
		const a = await analyzeAudioFile(loud)
		expect(a.hasAudio).toBe(true)
		expect(a.durationSec).toBeCloseTo(2, 0)
		expect(a.peaks.length).toBeGreaterThan(95)
		expect(a.peaks.length).toBeLessThan(105)
		// ffmpeg's sine source peaks at 0.125 of full scale, and this one is at 0.8 of that.
		expect(Math.max(...a.peaks)).toBeGreaterThanOrEqual(9)
		expect(Math.max(...a.peaks)).toBeLessThanOrEqual(11)
		expect(a.lufs).not.toBeNull()
		expect(a.truePeakDb).not.toBeNull()
	})

	it('tells a loud source from a quiet one, on both the waveform and the meter', async () => {
		const [l, q] = await Promise.all([analyzeAudioFile(loud), analyzeAudioFile(quiet)])
		expect(Math.max(...l.peaks)).toBeGreaterThan(Math.max(...q.peaks) * 5)
		expect(l.lufs!).toBeGreaterThan(q.lufs! + 15)
	})

	it('says "no audio" for a picture-only file instead of failing', async () => {
		const a = await analyzeAudioFile(silentVideo)
		expect(a.hasAudio).toBe(false)
		expect(a.peaks).toEqual([])
	})

	it('refuses a file that is not there', async () => {
		await expect(analyzeAudioFile(path.join(dir, 'missing.wav'))).rejects.toThrow(/not found/i)
	})
})

describe('getAudioAnalysis', () => {
	it('measures once, then answers from the cache beside the asset', async () => {
		const assetDir = path.join(dir, 'asset-1')
		const first = await getAudioAnalysis(assetDir, loud)
		expect(fs.existsSync(path.join(assetDir, 'audio-analysis.v1.json'))).toBe(true)
		// A cached answer needs no source at all.
		const second = await getAudioAnalysis(assetDir, path.join(dir, 'gone.wav'))
		expect(second).toEqual(first)
	})

	it('re-measures a cache it cannot parse', async () => {
		const assetDir = path.join(dir, 'asset-2')
		fs.mkdirSync(assetDir, { recursive: true })
		fs.writeFileSync(path.join(assetDir, 'audio-analysis.v1.json'), '{not json')
		const a = await getAudioAnalysis(assetDir, quiet)
		expect(a.hasAudio).toBe(true)
	})

	it('does not even look at a file known to have no audio', async () => {
		const a = await getAudioAnalysis(path.join(dir, 'asset-3'), path.join(dir, 'gone.wav'), { hasAudio: false })
		expect(a.hasAudio).toBe(false)
	})
})

describe('spectrogramBase64', () => {
	it('draws a sound as a PNG an agent can read', async () => {
		const png = Buffer.from(await spectrogramBase64(loud), 'base64')
		// The PNG signature, then an IHDR chunk with the size asked for.
		expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
		expect(png.readUInt32BE(16)).toBe(640)
		expect(png.readUInt32BE(20)).toBe(256)
	})

	it('leaves no file behind and refuses a file that is not audio', async () => {
		const bad = path.join(dir, 'nope.txt')
		fs.writeFileSync(bad, 'not audio')
		await expect(spectrogramBase64(bad)).rejects.toThrow()
	})
})
