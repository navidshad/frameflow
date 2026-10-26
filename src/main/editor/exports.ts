import fs from 'fs'
import path from 'path'
import type { EditorExportFile } from '@shared/types'
import { THREAD_DIRS } from '../constants/paths'

/** What a finished export can be: the H.264 mp4, the ProRes mov, a re-wrapped copy. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm'])

export const exportsDirFor = (tempDir: string): string => path.join(tempDir, THREAD_DIRS.EXPORTS)

/**
 * The finished videos in a project's exports folder, newest first.
 *
 * Only plain video files sitting directly in the folder count. The per-export
 * work folders (named by render id) live beside the results and are skipped as
 * directories; dotfiles and `.tmp`/`.part` leftovers are skipped as unfinished.
 * A missing folder is an empty list, not an error — a project that never
 * exported has none.
 */
export function listExportFiles(tempDir: string): EditorExportFile[] {
	const dir = exportsDirFor(tempDir)
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return []
	}
	const files: EditorExportFile[] = []
	for (const entry of entries) {
		if (!entry.isFile() || entry.name.startsWith('.')) continue
		if (!VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
		const full = path.join(dir, entry.name)
		try {
			const stat = fs.statSync(full)
			files.push({ name: entry.name, path: full, size: stat.size, modifiedAt: stat.mtimeMs })
		} catch { /* removed between readdir and stat */ }
	}
	return files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name))
}

/**
 * `filePath` as an export of this project, or null. The renderer hands paths
 * back to the main process to reveal/open, so this is the one gate: the path
 * must be a direct child of the exports folder (no `..`, no nesting, no other
 * project) and a file that is there right now.
 */
export function resolveExportPath(tempDir: string, filePath: unknown): string | null {
	if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return null
	const dir = path.resolve(exportsDirFor(tempDir))
	const resolved = path.resolve(filePath)
	if (path.dirname(resolved) !== dir) return null
	try {
		return fs.statSync(resolved).isFile() ? resolved : null
	} catch {
		return null
	}
}
