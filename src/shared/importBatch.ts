import type { ExpandedMedia, FailedImport, SkippedPath } from './mediaFiles'

/**
 * Importing a list of files one after another, as the Media panel does for a
 * picked folder or a drop. The loop lives here, apart from the store, so what
 * matters about it has tests: one bad file never stops the rest, the order is
 * the list's order, progress is told after every file, and a stop request
 * ends it between files.
 *
 * Sequential on purpose. Each import is one quick probe; the slow work
 * (transcript, proxy, thumbnails) runs after, in main's own limited pools, so
 * a hundred files do not become a hundred ffmpeg jobs at once. And assets land
 * in the project in the order the files were listed.
 */

export interface BatchProgress {
	total: number
	/** Files finished, whether they came in or failed. */
	done: number
	/** The file being imported now; null between files and at the end. */
	current: string | null
	imported: number
	failed: FailedImport[]
}

export interface BatchResult<T> {
	items: T[]
	failed: FailedImport[]
	/** True when a stop was requested before the list ran out. */
	stopped: boolean
}

export const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)

export async function importInOrder<T>(
	files: readonly string[],
	importOne: (file: string) => Promise<T | null | undefined>,
	options: { onProgress?: (p: BatchProgress) => void; shouldStop?: () => boolean } = {}
): Promise<BatchResult<T>> {
	const items: T[] = []
	const failed: FailedImport[] = []
	const tell = (done: number, current: string | null) =>
		options.onProgress?.({ total: files.length, done, current, imported: items.length, failed: [...failed] })

	tell(0, null)
	let stopped = false
	for (let i = 0; i < files.length; i++) {
		if (options.shouldStop?.()) { stopped = true; break }
		const file = files[i]
		tell(i, baseName(file))
		try {
			const item = await importOne(file)
			if (item) items.push(item)
			else failed.push({ path: file, name: baseName(file), error: 'The project is not open any more.' })
		} catch (e: any) {
			failed.push({ path: file, name: baseName(file), error: errorText(e) })
		}
	}
	tell(items.length + failed.length, null)
	return { items, failed, stopped }
}

/** Electron wraps a handler's error as "Error invoking remote method 'x': Error: message"; the person wants the message. */
export const errorText = (e: unknown): string => {
	const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unknown error'
	return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim() || 'Unknown error'
}

/** Everything the end-of-batch card shows. */
export interface BatchReport {
	imported: number
	failed: FailedImport[]
	skipped: SkippedPath[]
	truncated: boolean
	stopped: boolean
}

export const reportOf = (expanded: Pick<ExpandedMedia, 'skipped' | 'truncated'>, result: BatchResult<unknown>): BatchReport => ({
	imported: result.items.length,
	failed: result.failed,
	skipped: expanded.skipped,
	truncated: expanded.truncated,
	stopped: result.stopped
})

/** What the Media panel shows: reading the selection, importing, or the closing report. */
export interface BulkImport {
	phase: 'scanning' | 'importing' | 'done'
	progress: BatchProgress | null
	report: BatchReport | null
}
