import fs from 'fs'
import path from 'path'

/**
 * One list of projects, however the app is started.
 *
 * Electron names the data folder after the app. `npm run dev` runs as the package name
 * (`frameflow`), but `electron out/main/index.js` (what `start:debug` runs) has no name
 * and falls back to `Electron`, so the two kept separate project lists, settings and
 * undo history. A project made in one was missing in the other.
 *
 * Unpackaged runs now always use the `frameflow` folder (the one `npm run dev` already
 * used). The packaged app is untouched: it keeps its own folder.
 *
 * The functions here take their paths, so they are tested without Electron.
 */

export const PINNED_DIR_NAME = 'frameflow'
/** The folder the plain `electron` command writes to. */
export const STRAY_DIR_NAME = 'Electron'
const MARKER = 'imported-from-electron.json'

/** Per-project files kept beside the project list, copied along with a project. */
const SIDECARS = ['editor-history', 'editor-revisions', 'engine-sessions']

export const pinnedUserDataDir = (appData: string) => path.join(appData, PINNED_DIR_NAME)

const copyIfMissing = (from: string, to: string): boolean => {
	if (!fs.existsSync(from) || fs.existsSync(to)) return false
	fs.mkdirSync(path.dirname(to), { recursive: true })
	fs.cpSync(from, to, { recursive: true, errorOnExist: false, force: false })
	return true
}

/**
 * Brings projects that only exist in `strayDir` into `pinnedDir`, once. A project already
 * in the pinned list is left exactly as it is, and the marker stops a project the person
 * later removes from coming back on the next start. Returns the ids imported.
 */
export function importStrayProjects(strayDir: string, pinnedDir: string): string[] {
	const marker = path.join(pinnedDir, MARKER)
	if (fs.existsSync(marker)) return []
	const strayThreads = path.join(strayDir, 'threads')
	if (strayDir === pinnedDir || !fs.existsSync(strayThreads)) return []

	const imported: string[] = []
	for (const file of fs.readdirSync(strayThreads)) {
		if (!file.endsWith('.json')) continue // .bak copies are not projects
		const id = file.slice(0, -'.json'.length)
		if (!copyIfMissing(path.join(strayThreads, file), path.join(pinnedDir, 'threads', file))) continue
		for (const dir of SIDECARS) {
			const sidecar = fs.existsSync(path.join(strayDir, dir, `${id}.json`)) ? `${id}.json` : id
			copyIfMissing(path.join(strayDir, dir, sidecar), path.join(pinnedDir, dir, sidecar))
		}
		imported.push(id)
	}
	fs.mkdirSync(pinnedDir, { recursive: true })
	fs.writeFileSync(marker, JSON.stringify({ from: strayDir, at: new Date().toISOString(), imported }, null, 2))
	return imported
}
