import { BrowserWindow } from 'electron'
import fs from 'fs'
import type { EditorDocument } from '@shared/types'
import { ensureMotionClip } from '../motion'
import { threadManager } from '../threads'
import { hasActiveRender, planForRender } from './render'
import { motionJobsFor } from './renderBuilders'

/**
 * Draws a project's motion layers in the background, at the size and rate an
 * original-quality export will want, so that the export finds them already on
 * disk. Drawing them is the longest stage of an export (a 4K60 project with 46
 * layers took about an hour), and nothing about it needs the user waiting.
 *
 * It adds no new kind of file and no new path: a clip is found by a hash of its
 * content, size and rate, so what is drawn here is byte for byte what the
 * export would have drawn, and the export simply skips it. The plan comes from
 * the export's own `planForRender` for that reason.
 *
 * It is a guest, not a rival:
 *  - one clip at a time, resting half of each frame (`IDLE_RATIO`), because a
 *    4K frame holds the main process for most of its time;
 *  - it stops as soon as an export starts (which draws what is left itself,
 *    and joins any clip already in flight);
 *  - a newer snapshot of the same project replaces it, and only between clips,
 *    so a clip an export may be waiting on is never abandoned half way.
 */

/** Rest this fraction of each frame's time: 1 = half speed. */
export const IDLE_RATIO = 1

export interface MotionPrerenderProgress {
	threadId: string
	/** Clips the export would want that are on disk. */
	done: number
	/** Clips the export would want. */
	total: number
	/** Still drawing. False once it has finished, been left to an export, or given up on a layer. */
	running: boolean
}

/** The newest run per project; an older one stops at its next clip. */
const generations = new Map<string, number>()

const broadcast = (progress: MotionPrerenderProgress) => {
	BrowserWindow.getAllWindows().forEach((win) => win.webContents.send('motion-prerender-progress', progress))
}

/** The clips an original-quality export of `doc` needs, once each. */
export function motionClipsFor(doc: EditorDocument, tempDir: string) {
	const plan = planForRender(doc, 'original', tempDir)
	return [...new Map(motionJobsFor(plan.regions).map((job) => [job.outputPath, job])).values()]
}

export async function prerenderMotion(
	options: { threadId: string; doc: EditorDocument },
	hooks: { report?: (progress: MotionPrerenderProgress) => void } = {}
): Promise<MotionPrerenderProgress | null> {
	const { threadId, doc } = options
	const report = hooks.report ?? broadcast
	const thread = threadManager.getThread(threadId)
	if (!thread || thread.type !== 'editor') return null

	const generation = (generations.get(threadId) ?? 0) + 1
	generations.set(threadId, generation)

	let jobs: ReturnType<typeof motionClipsFor>
	try {
		jobs = motionClipsFor(doc, thread.tempDir)
	} catch {
		// A timeline that cannot be planned is for the export's own pre-flight to explain.
		return null
	}
	let done = jobs.filter((job) => fs.existsSync(job.outputPath)).length
	const progress = (running: boolean): MotionPrerenderProgress => ({ threadId, done, total: jobs.length, running })
	const finish = () => {
		const last = progress(false)
		report(last)
		return last
	}
	report(progress(jobs.some((job) => !fs.existsSync(job.outputPath))))

	for (const job of jobs) {
		if (fs.existsSync(job.outputPath)) continue
		// A newer snapshot took over: its run owns the status from here.
		if (generations.get(threadId) !== generation) return progress(true)
		if (hasActiveRender()) return finish() // the export draws what is left
		try {
			await ensureMotionClip(job, { idleRatio: IDLE_RATIO })
		} catch (error) {
			// One layer that cannot be drawn stays the export's to report, with its name.
			console.warn('[motion-prerender]', error instanceof Error ? error.message : error)
			continue
		}
		done++
		report(progress(true))
	}
	return generations.get(threadId) === generation ? finish() : progress(true)
}
