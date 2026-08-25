import type { Thread } from './types'

/**
 * Threads created by the retired AI video pipeline.
 *
 * The graph used to accept a video and produce a rendered cut. It now serves
 * images only; video work happens in the timeline editor. Records from before
 * that change still exist on disk and cannot be opened, so Home shows them as
 * unsupported with a working Delete rather than hiding them — hiding removes
 * the user's only handle for deleting gigabytes of proxies and transcripts,
 * and getAllThreads re-discovers the folders anyway.
 *
 * Derived, never migrated: no write-on-read, so nothing is rewritten just by
 * being listed. `type` is optional because it predates the field — a record
 * with no type but a videoPath is legacy too.
 */
export function isLegacyVideoThread(thread: Pick<Thread, 'type' | 'videoPath'>): boolean {
	if (thread.type === 'video') return true
	return thread.type === undefined && !!thread.videoPath
}
