import { accessSync, constants, existsSync, realpathSync, statfsSync } from 'fs'
import { basename, dirname, join, relative, isAbsolute, resolve } from 'path'
import os from 'os'

/** `~/Movies/FrameFlow` on a Mac, `~/Videos/FrameFlow` elsewhere. */
export const suggestProjectsFolder = (home = os.homedir(), platform = process.platform): string =>
	join(home, platform === 'darwin' ? 'Movies' : 'Videos', 'FrameFlow')

/** The user picked the store itself, or a parent to nest it in: never FrameFlow/FrameFlow. */
export const nestProjectsFolder = (selected: string): string =>
	basename(selected) === 'FrameFlow' ? selected : join(selected, 'FrameFlow')

/** realpath of the nearest ancestor that exists, so a folder not yet created is still judged where it will live. */
function resolveExisting(path: string): string {
	let probe = resolve(path)
	const tail: string[] = []
	while (!existsSync(probe) && dirname(probe) !== probe) {
		tail.unshift(basename(probe))
		probe = dirname(probe)
	}
	try { probe = realpathSync(probe) } catch { /* keep what we have */ }
	return join(probe, ...tail)
}

/** True when `path` is the system temp folder or anything inside it. */
export function isInsideTemp(path: string, tmp = os.tmpdir()): boolean {
	const rel = relative(resolveExisting(tmp), resolveExisting(path))
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export interface FolderCheck {
	ok: boolean
	/** Why not, in words for the user. */
	reason?: string
	writable: boolean
	freeBytes?: number
}

export function checkProjectsFolder(path: string, tmp = os.tmpdir()): FolderCheck {
	if (!path || !isAbsolute(path)) return { ok: false, writable: false, reason: 'Choose a folder.' }
	if (isInsideTemp(path, tmp)) {
		return { ok: false, writable: false, reason: 'That is a system temporary folder, which the OS can clear. Pick a folder you keep.' }
	}
	const anchor = (() => { let p = resolve(path); while (!existsSync(p) && dirname(p) !== p) p = dirname(p); return p })()
	let writable = true
	try { accessSync(anchor, constants.W_OK) } catch { writable = false }
	let freeBytes: number | undefined
	try { const s = statfsSync(anchor); freeBytes = s.bavail * s.bsize } catch { /* not every platform */ }
	return writable
		? { ok: true, writable, freeBytes }
		: { ok: false, writable, freeBytes, reason: 'FrameFlow cannot write to that folder.' }
}
