import fs from 'fs'
import path from 'path'
import type { TimelineItem } from '@shared/types'
import { composeMotionPage, motionFramePlan } from '@shared/motion'
import { openMotionCapture } from './capture'
import { encodeFrames } from './encode'

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
}

/** Render one clip to `outputPath`. Exported for the Electron-run test. */
export async function renderMotionClip(
	job: MotionJob,
	options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<void> {
	const { item, frame, outputPath } = job
	const plan = motionFramePlan(item, frame.fps)
	fs.mkdirSync(path.dirname(outputPath), { recursive: true })
	const capture = await openMotionCapture(composeMotionPage(item.motion, frame), frame)
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
	const total = unique.reduce((sum, j) => sum + motionFramePlan(j.item, j.frame.fps).length, 0) || 1
	let done = 0
	for (const job of unique) {
		if (options.signal?.aborted) throw new Error('aborted')
		const before = done
		await ensureMotionClip(job, {
			signal: options.signal,
			onProgress: (k) => options.onProgress?.((before + k) / total)
		})
		done = before + motionFramePlan(job.item, job.frame.fps).length
	}
	options.onProgress?.(1)
}
