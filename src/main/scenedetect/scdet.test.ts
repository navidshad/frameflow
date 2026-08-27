import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import ffmpegStatic from 'ffmpeg-static'
import { toScenes, SceneDetector } from './index'
import {
	clampSensitivity,
	sensitivityToScdetThreshold,
	SCENE_SENSITIVITY_MIN,
	SCENE_SENSITIVITY_MAX,
	SCENE_SENSITIVITY_DEFAULT
} from '@shared/scene-sensitivity'

const execFileAsync = promisify(execFile)

describe('sensitivity → scdet threshold', () => {
	it('maps the default sensitivity onto the calibrated threshold', () => {
		// Calibrated against PySceneDetect t=27 over real footage — see the table
		// in @shared/scene-sensitivity. Moving this changes what every existing
		// project's re-detect produces, so it should not drift casually.
		const threshold = sensitivityToScdetThreshold(SCENE_SENSITIVITY_DEFAULT)
		expect(threshold).toBeCloseTo(6.1, 1)
	})

	it('keeps the default mid-scale, so users can go both ways', () => {
		const atMin = sensitivityToScdetThreshold(SCENE_SENSITIVITY_MIN)
		const atDefault = sensitivityToScdetThreshold(SCENE_SENSITIVITY_DEFAULT)
		const atMax = sensitivityToScdetThreshold(SCENE_SENSITIVITY_MAX)
		expect(atDefault).toBeLessThan(atMin)
		expect(atDefault).toBeGreaterThan(atMax)
	})

	it('is monotonically decreasing — more sensitivity means a lower threshold', () => {
		const thresholds = []
		for (let s = SCENE_SENSITIVITY_MIN; s <= SCENE_SENSITIVITY_MAX; s++) {
			thresholds.push(sensitivityToScdetThreshold(s))
		}
		for (let i = 1; i < thresholds.length; i++) {
			expect(thresholds[i]).toBeLessThan(thresholds[i - 1])
		}
	})

	it('stays inside scdet\'s valid 0..100 range across the whole scale', () => {
		for (let s = SCENE_SENSITIVITY_MIN; s <= SCENE_SENSITIVITY_MAX; s++) {
			const threshold = sensitivityToScdetThreshold(s)
			expect(threshold).toBeGreaterThan(0)
			expect(threshold).toBeLessThanOrEqual(100)
		}
	})

	it('falls back to the default for junk arriving over IPC', () => {
		const fallback = sensitivityToScdetThreshold(SCENE_SENSITIVITY_DEFAULT)
		expect(sensitivityToScdetThreshold(undefined)).toBe(fallback)
		expect(sensitivityToScdetThreshold(NaN)).toBe(fallback)
	})

	it('clamps out-of-range values instead of extrapolating', () => {
		expect(clampSensitivity(-5)).toBe(SCENE_SENSITIVITY_MIN)
		expect(clampSensitivity(999)).toBe(SCENE_SENSITIVITY_MAX)
		expect(clampSensitivity(3.4)).toBe(3)
	})
})

describe('toScenes', () => {
	it('spans a cut-less video with a single scene', () => {
		expect(toScenes([], 12)).toEqual([{ startTime: 0, endTime: 12, duration: 12 }])
	})

	it('turns cut points into contiguous scenes covering the whole media', () => {
		const scenes = toScenes([4, 8], 12)
		expect(scenes).toEqual([
			{ startTime: 0, endTime: 4, duration: 4 },
			{ startTime: 4, endTime: 8, duration: 4 },
			{ startTime: 8, endTime: 12, duration: 4 }
		])
	})

	it('leaves no gaps or overlaps between consecutive scenes', () => {
		const scenes = toScenes([1.5, 3.25, 7.125], 10)
		expect(scenes[0].startTime).toBe(0)
		expect(scenes[scenes.length - 1].endTime).toBe(10)
		for (let i = 1; i < scenes.length; i++) {
			expect(scenes[i].startTime).toBe(scenes[i - 1].endTime)
		}
	})

	it('sorts cuts arriving out of order', () => {
		expect(toScenes([8, 4], 12)).toEqual(toScenes([4, 8], 12))
	})

	it('folds away cuts too close together to make a usable clip', () => {
		// 4.0 and 4.05 are the same cut as far as a clip tray is concerned.
		expect(toScenes([4, 4.05], 12)).toHaveLength(2)
	})

	it('drops a cut landing on the tail of the media', () => {
		// Would otherwise produce a trailing scene of a few milliseconds.
		expect(toScenes([11.99], 12)).toEqual([{ startTime: 0, endTime: 12, duration: 12 }])
	})

	it('returns nothing when the duration probe came back empty', () => {
		expect(toScenes([4], 0)).toEqual([])
		expect(toScenes([4], NaN)).toEqual([])
	})

	it('ignores non-finite cut times', () => {
		expect(toScenes([NaN, 6, Infinity], 12)).toEqual([
			{ startTime: 0, endTime: 6, duration: 6 },
			{ startTime: 6, endTime: 12, duration: 6 }
		])
	})
})

/**
 * Exercises the real bundled FFmpeg. This is the only thing that would catch
 * `scdet` changing its stderr format on an FFmpeg upgrade, which would silently
 * turn every video into a single scene.
 */
describe('SceneDetector against the bundled FFmpeg', () => {
	const dir = join(tmpdir(), 'frameflow-scdet-test')
	const cutsPath = join(dir, 'cuts.mp4')
	const flatPath = join(dir, 'flat.mp4')
	const ffmpegPath = (ffmpegStatic as unknown as string) || 'ffmpeg'

	beforeAll(async () => {
		await fs.mkdir(dir, { recursive: true })
		// Luma-distinct segments: black -> white -> gray, hard cuts at 2s and 4s.
		await execFileAsync(ffmpegPath, [
			'-y', '-loglevel', 'error',
			'-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=2:r=25',
			'-f', 'lavfi', '-i', 'color=c=white:s=320x240:d=2:r=25',
			'-f', 'lavfi', '-i', 'color=c=gray:s=320x240:d=2:r=25',
			'-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1[out]',
			'-map', '[out]', '-pix_fmt', 'yuv420p', cutsPath
		])
		// A single unbroken shot.
		await execFileAsync(ffmpegPath, [
			'-y', '-loglevel', 'error',
			'-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=3:r=25',
			'-pix_fmt', 'yuv420p', flatPath
		])
	}, 60_000)

	afterAll(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it('finds both cuts and reports progress', async () => {
		const seen: number[] = []
		const scenes = await new SceneDetector().detectScenes(
			cutsPath,
			undefined,
			SCENE_SENSITIVITY_DEFAULT,
			(p) => seen.push(p)
		)

		expect(scenes).toHaveLength(3)
		expect(scenes[0].endTime).toBeCloseTo(2, 1)
		expect(scenes[1].endTime).toBeCloseTo(4, 1)
		expect(scenes[2].endTime).toBeCloseTo(6, 1)
		expect(seen.length).toBeGreaterThan(0)
		expect(Math.max(...seen)).toBeLessThanOrEqual(100)
	}, 60_000)

	it('returns one whole-media scene for a cut-less video', async () => {
		const scenes = await new SceneDetector().detectScenes(flatPath)
		expect(scenes).toHaveLength(1)
		expect(scenes[0].startTime).toBe(0)
		expect(scenes[0].endTime).toBeCloseTo(3, 1)
	}, 60_000)

	it('rejects immediately when the signal is already aborted', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(
			new SceneDetector().detectScenes(cutsPath, controller.signal)
		).rejects.toThrow(/aborted/i)
	})

	it('aborts an in-flight detection', async () => {
		const controller = new AbortController()
		const pending = new SceneDetector().detectScenes(cutsPath, controller.signal)
		queueMicrotask(() => controller.abort())
		await expect(pending).rejects.toThrow(/aborted/i)
	}, 60_000)
})
