import fs from 'node:fs/promises'
import path from 'node:path'
import {
	dedupePaths, importKindOf, isHiddenName, orderDirEntries,
	type ExpandedMedia, type SkippedPath
} from '@shared/mediaFiles'

/**
 * Turn what a person picked or dropped (files, folders, both) into the list of
 * files to import. The rules (which types, hidden entries, order) are in
 * `shared/mediaFiles`; this walks the disk.
 *
 * Nothing here throws for one bad entry: a folder that cannot be read, a file
 * that vanished or a link that loops is recorded as skipped and the walk goes
 * on. Asynchronous throughout, so a big folder never stalls the main process.
 */

/** What the walk needs from a file system; a fake one in tests. */
export interface WalkFs {
	/** What `p` is, following links: 'file', 'dir', or null when it is neither or cannot be read. */
	kindOf(p: string): Promise<'file' | 'dir' | 'missing' | 'other'>
	/** Entries of a folder, links already resolved to what they point at. */
	list(p: string): Promise<{ name: string; isDirectory: boolean }[]>
	/** A stable identity for a folder, so a link back up the tree is not walked twice. */
	identity(p: string): Promise<string>
}

export const realFs: WalkFs = {
	async kindOf(p) {
		try {
			const s = await fs.stat(p)
			return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'
		} catch (e: any) {
			return e?.code === 'ENOENT' ? 'missing' : 'other'
		}
	},
	async list(p) {
		const entries = await fs.readdir(p, { withFileTypes: true })
		const out: { name: string; isDirectory: boolean }[] = []
		for (const e of entries) {
			if (e.isSymbolicLink()) {
				// A link is judged by its target; a dangling one is nothing to import.
				const s = await fs.stat(path.join(p, e.name)).catch(() => null)
				if (s) out.push({ name: e.name, isDirectory: s.isDirectory() })
			} else {
				out.push({ name: e.name, isDirectory: e.isDirectory() })
			}
		}
		return out
	},
	async identity(p) {
		return fs.realpath(p).catch(() => p)
	}
}

/** A folder this deep is a mistake (the home folder, a link maze), not a shoot. */
export const MAX_DEPTH = 12
/** Enough for any shoot; a stop, not a failure. */
export const MAX_FILES = 2000

export async function expandMediaPaths(inputs: readonly string[], walkFs: WalkFs = realFs, limits: { maxFiles?: number; maxDepth?: number } = {}): Promise<ExpandedMedia> {
	const maxFiles = limits.maxFiles ?? MAX_FILES
	const maxDepth = limits.maxDepth ?? MAX_DEPTH
	const files: string[] = []
	const skipped: SkippedPath[] = []
	const visited = new Set<string>()
	let truncated = false

	const visitFile = (file: string) => {
		if (importKindOf(file)) files.push(file)
		else skipped.push({ path: file, reason: 'unsupported' })
	}

	const walk = async (dir: string, depth: number): Promise<void> => {
		if (truncated) return
		const id = await walkFs.identity(dir)
		if (visited.has(id)) return
		visited.add(id)

		let entries
		try {
			entries = await walkFs.list(dir)
		} catch {
			skipped.push({ path: dir, reason: 'unreadable' })
			return
		}
		for (const entry of orderDirEntries(entries)) {
			if (truncated) return
			const full = path.join(dir, entry.name)
			if (isHiddenName(entry.name)) {
				skipped.push({ path: full, reason: 'hidden' })
			} else if (entry.isDirectory) {
				if (depth >= maxDepth) skipped.push({ path: full, reason: 'unreadable' })
				else await walk(full, depth + 1)
			} else if (importKindOf(entry.name)) {
				if (files.length >= maxFiles) { truncated = true; return }
				files.push(full)
			} else {
				skipped.push({ path: full, reason: 'unsupported' })
			}
		}
	}

	for (const input of dedupePaths(inputs.map((p) => path.resolve(p)))) {
		if (truncated) break
		const kind = await walkFs.kindOf(input)
		if (kind === 'dir') await walk(input, 0)
		else if (kind === 'file') visitFile(input)
		else skipped.push({ path: input, reason: kind === 'missing' ? 'missing' : 'unreadable' })
	}

	// A file named on its own and again inside a dropped folder is one import.
	return { files: dedupePaths(files), skipped, truncated }
}
