import fs from 'fs'
import path from 'path'
import type { TimelineItem } from '@shared/types'
import { composeMotionPage, motionFramePlan, motionFrameState, type MotionKit } from '@shared/motion'
import { openMotionCapture } from './capture'
import { encodeFrames, PARTIAL_SUFFIX } from './encode'
import { mapPool } from '../editor/pool'

/**
 * Motion layers for the export: render each clip once, by content hash, to an
 * alpha .mov the region graph composites like any other overlay.
 *
 * The page captured here is `composeMotionPage` — the same string the monitor's
 * iframe loads — and every frame's state is `motionFramePlan`, built from the
 * same `motionFrameState` the monitor calls at the playhead. Preview and export
 * agree because there is nothing for them to disagree about.
 */

export interface MotionJob {
	item: Pick<TimelineItem, 'id' | 'label' | 'motion' | 'duration' | 'keyframes'>
	frame: { width: number; height: number; fps: number }
	outputPath: string
	/** The project kit the page uses (the one its cache key was hashed with). */
	kits?: MotionKit[]
}

/** Render one clip to `outputPath`. Exported for the Electron-run test. */
export async function renderMotionClip(
	job: MotionJob,
	options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<void> {
	const { item, frame, outputPath } = job
	const plan = motionFramePlan(item, frame.fps)
	fs.mkdirSync(path.dirname(outputPath), { recursive: true })
	const capture = await openMotionCapture(composeMotionPage(item.motion, frame, job.kits), frame)
	try {
		await encodeFrames({
			frame,
			count: plan.length,
			next: (k) => capture.frame(plan[k]),
			outputPath,
			signal: options.signal,
			onProgress: options.onProgress
		})
	} finally {
		capture.close()
	}
}

/** In-flight renders, so the monitor's exact frame and an export share one. */
const inFlight = new Map<string, Promise<void>>()

/**
 * Frames `first`..`last` of the clip `job` would render, and nothing else, as
 * a short clip at `outputPath` whose frame 0 is the clip's frame `first`. The
 * states are the clip's own (`motionFramePlan`), so the pixels are the ones the
 * full clip would hold. For the exact frame: a still of a two-minute layer
 * captures a handful of frames instead of thousands.
 */
export async function ensureMotionFrames(job: MotionJob, first: number, last: number, outputPath: string): Promise<string> {
	if (fs.existsSync(outputPath)) return outputPath
	const running = inFlight.get(outputPath)
	if (running) {
		await running
		return outputPath
	}
	const work = (async () => {
		// Frame k is clip time k / fps, exactly as `motionFramePlan` builds it.
		const plan = Array.from({ length: last - first + 1 }, (_, j) => motionFrameState(job.item, (first + j) / job.frame.fps))
		fs.mkdirSync(path.dirname(outputPath), { recursive: true })
		const capture = await openMotionCapture(composeMotionPage(job.item.motion, job.frame, job.kits), job.frame)
		try {
			await encodeFrames({ frame: job.frame, count: plan.length, next: (k) => capture.frame(plan[k]), outputPath })
		} finally {
			capture.close()
		}
	})()
	inFlight.set(outputPath, work)
	try {
		await work
	} catch (error: any) {
		const name = job.item.label || job.item.id
		throw new Error(`Motion layer "${name}" could not be drawn: ${error?.message || error}`)
	} finally {
		inFlight.delete(outputPath)
	}
	sweepStills(path.dirname(outputPath))
	return outputPath
}

/** Stills kept per project; each is a few frames, but a long session makes many. */
const STILLS_LIMIT = 200

function sweepStills(dir: string): void {
	try {
		const files = fs.readdirSync(dir)
			.filter((f) => f.endsWith('.mov') && !f.endsWith(PARTIAL_SUFFIX))
			.map((f) => ({ full: path.join(dir, f), at: fs.statSync(path.join(dir, f)).mtimeMs }))
			.sort((a, b) => b.at - a.at)
		for (const stale of files.slice(STILLS_LIMIT)) {
			try { fs.unlinkSync(stale.full) } catch { /* ignore */ }
		}
	} catch { /* nothing to sweep */ }
}

/** Render the clip unless an identical one is already on disk. */
export async function ensureMotionClip(
	job: MotionJob,
	options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<string> {
	if (fs.existsSync(job.outputPath)) return job.outputPath
	const running = inFlight.get(job.outputPath)
	if (running) {
		await running
		return job.outputPath
	}
	const work = renderMotionClip(job, options)
	inFlight.set(job.outputPath, work)
	try {
		await work
	} catch (error: any) {
		const name = job.item.label || job.item.id
		throw new Error(`Motion layer "${name}" could not be rendered: ${error?.message || error}`)
	} finally {
		inFlight.delete(job.outputPath)
	}
	return job.outputPath
}

/**
 * Render every distinct motion clip a set of slices needs, reporting progress
 * across all of them as one fraction (0..1) by frame count.
 */
export async function ensureMotionJobs(
	jobs: MotionJob[],
	options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {}
): Promise<void> {
	const unique = [...new Map(jobs.map((j) => [j.outputPath, j])).values()]
		.filter((j) => !fs.existsSync(j.outputPath))
	const frames = unique.map((j) => motionFramePlan(j.item, j.frame.fps).length)
	const total = frames.reduce((sum, n) => sum + n, 0) || 1
	const done = unique.map(() => 0)
	const report = () => options.onProgress?.(done.reduce((sum, n) => sum + n, 0) / total)
	// Each clip draws in its own hidden window and pipes to its own ffmpeg, and a
	// frame spends most of its time waiting on the window's screenshot, not on a
	// core — a 4K60 export of 28 layers sat at about 20% CPU one clip at a time.
	await mapPool(unique.length, motionConcurrency(unique), async (i, signal) => {
		await ensureMotionClip(unique[i], {
			signal,
			onProgress: (k) => { done[i] = k; report() }
		})
		done[i] = frames[i]
		report()
	}, options.signal ?? new AbortController().signal)
	options.onProgress?.(1)
}

/**
 * Motion clips drawn at once. At 480p a frame is mostly waiting (~17 ms, 59 fps
 * alone), so four windows keep the machine busy. At 4K it is mostly the main
 * thread copying pixels (~108 of ~137 ms), which windows cannot share, so more
 * than two only queue behind each other and hold 33 MB frames in memory.
 */
export const motionConcurrency = (jobs: MotionJob[]): number => {
	const pixels = jobs.reduce((max, j) => Math.max(max, j.frame.width * j.frame.height), 0)
	return pixels > 1920 * 1080 ? 2 : 4
}
