/**
 * Which files FrameFlow imports as media, and how a pile of them (several
 * files, a folder, a mix) becomes one ordered list.
 *
 * Pure on purpose: the file picker, drag-and-drop, the folder walk in main and
 * the progress card in the Media panel all ask the same questions, and the
 * answers have tests. `main/editor/expandMedia.ts` does the file system; this
 * file decides what to do with what it finds.
 *
 * The editor imports video and sound. Stills are not a media kind the timeline
 * can place today, so a folder of photos is skipped (and counted), not failed.
 */

export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.mpg', '.mpeg'] as const
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.aif', '.aiff', '.wma'] as const

const VIDEO_SET: ReadonlySet<string> = new Set(VIDEO_EXTENSIONS)
const AUDIO_SET: ReadonlySet<string> = new Set(AUDIO_EXTENSIONS)

export type ImportKind = 'video' | 'audio'

/** The part of a file name from its last dot, lower-cased; '' when there is none (or it is a dotfile). */
export const extensionOf = (name: string): string => {
	const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
	const dot = base.lastIndexOf('.')
	return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/** What an import would treat this file as, going by its name alone. Null when FrameFlow does not import it. */
export const importKindOf = (name: string): ImportKind | null => {
	const ext = extensionOf(name)
	if (VIDEO_SET.has(ext)) return 'video'
	if (AUDIO_SET.has(ext)) return 'audio'
	return null
}

/** The extension list a native open dialog wants: no dots. */
export const dialogExtensions = (kind?: ImportKind): string[] =>
	(kind === 'video' ? VIDEO_EXTENSIONS : kind === 'audio' ? AUDIO_EXTENSIONS : [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]).map((e) => e.slice(1))

/**
 * Hidden entries inside a folder are never media the person meant to bring:
 * `.DS_Store`, `.git`, `.Trashes`, and macOS's `._clip.mp4` sidecars, which
 * carry a video extension and are not video. Only applied while walking a
 * folder; a file picked or dropped by name is judged by its type alone.
 */
export const isHiddenName = (name: string): boolean => name.startsWith('.')

// ===== Order =====

/** Numbers inside names compare as numbers, so clip2 comes before clip10. A fixed locale: the order must not depend on the machine. */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

export const compareNames = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)

export interface DirEntry {
	name: string
	isDirectory: boolean
}

/**
 * The order a folder's contents are imported in: its own files first, by name,
 * then each subfolder (by name) in turn. Cameras number their clips
 * (C0001, C0002 ... C0010), so reading order is shooting order.
 */
export const orderDirEntries = <T extends DirEntry>(entries: readonly T[]): T[] =>
	[...entries].sort((a, b) => Number(a.isDirectory) - Number(b.isDirectory) || compareNames(a.name, b.name))

// ===== Result of expanding a selection =====

export type SkipReason = 'unsupported' | 'hidden' | 'unreadable' | 'missing'

export interface SkippedPath {
	path: string
	reason: SkipReason
}

export interface ExpandedMedia {
	/** Absolute paths to import, in import order, each once. */
	files: string[]
	/** Everything that was looked at and left out. */
	skipped: SkippedPath[]
	/** True when the walk stopped at its limit: the folder holds more than was gathered. */
	truncated: boolean
}

/** First occurrence wins: a file dropped together with the folder it sits in is imported once. */
export const dedupePaths = (paths: readonly string[]): string[] => {
	const seen = new Set<string>()
	const out: string[] = []
	for (const p of paths) {
		if (seen.has(p)) continue
		seen.add(p)
		out.push(p)
	}
	return out
}

const REASON_TEXT: Record<SkipReason, string> = {
	unsupported: 'not video or audio',
	hidden: 'hidden',
	unreadable: 'could not be read',
	missing: 'not found'
}

/** "4 skipped (3 not video or audio, 1 hidden)", or '' when nothing was left out. */
export const describeSkipped = (skipped: readonly SkippedPath[]): string => {
	if (!skipped.length) return ''
	const counts = new Map<SkipReason, number>()
	for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1)
	const parts = [...counts].map(([reason, n]) => `${n} ${REASON_TEXT[reason]}`)
	return `${skipped.length} skipped (${parts.join(', ')})`
}

// ===== A batch, as the person hears about it =====

export interface FailedImport {
	path: string
	name: string
	error: string
}

export interface BatchOutcome {
	imported: number
	failed: readonly FailedImport[]
	skipped: readonly SkippedPath[]
	truncated?: boolean
}

/** One line for the end of a batch: what came in, what did not. */
export const describeBatch = (o: BatchOutcome): string => {
	const parts: string[] = []
	parts.push(o.imported === 1 ? '1 file imported' : `${o.imported} files imported`)
	if (o.failed.length) parts.push(`${o.failed.length} failed`)
	const skipped = describeSkipped(o.skipped)
	if (skipped) parts.push(skipped)
	if (o.truncated) parts.push('folder too large: stopped early')
	return parts.join(' · ')
}
