import crypto from 'node:crypto'
import os from 'os'
import path from 'path'
import type { TimelineItem } from '@shared/types'
import { motionRenderRecipe } from '@shared/motion'
import { THREAD_DIRS } from '../constants/paths'

/**
 * Where a rendered motion clip lives, named by WHAT it is.
 *
 * The key is a hash of `motionRenderRecipe` — the composed page, every frame's
 * state, the size and the rate — so it cannot drift from the picture (the
 * lesson of the transition cache, whose first hand-listed key went stale). Two
 * identical lower thirds share one file; moving a clip along the timeline does
 * not re-render it; changing one letter does.
 *
 * No Electron imports: `computeRegions` resolves these paths synchronously,
 * and it runs under plain vitest.
 */

export const motionCacheDir = (tempDir: string) => path.join(tempDir, THREAD_DIRS.MOTION)

/** For callers with no project (tests, previews of a doc with no thread). */
export const fallbackMotionDir = () => path.join(os.tmpdir(), 'frameflow-motion')

export function motionClipKey(
	item: Pick<TimelineItem, 'motion' | 'duration' | 'keyframes'>,
	frame: { width: number; height: number; fps: number }
): string {
	return crypto.createHash('sha1').update(motionRenderRecipe(item, frame)).digest('hex').slice(0, 24)
}

export function motionClipPath(
	dir: string,
	item: Pick<TimelineItem, 'motion' | 'duration' | 'keyframes'>,
	frame: { width: number; height: number; fps: number }
): string {
	return path.join(dir, `${motionClipKey(item, frame)}.mov`)
}
