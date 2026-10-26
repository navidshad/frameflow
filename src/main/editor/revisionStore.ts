import fs from 'fs'
import path from 'path'
import type {
	EditorRevision, EditorRevisionSummary, EditorRevisionsIndex, RevisionSnapshot
} from '@shared/types'
import { applyPrune, pruneToCap, reattachOrphans, summarizeRevision } from '@shared/revision-tree'
import { collectRefs, dehydrate, hydrate } from './blobRefs'
import { streamTopLevelArrays } from './jsonStream'

/**
 * Revision tree storage, schema 2. Revisions are coarse, permanent checkpoints
 * holding full timeline snapshots, so they must be cheap to keep and cheap to
 * open however many motion pages a project has.
 *
 *   <root>/<threadId>/index.json              summaries only (what the renderer lists)
 *   <root>/<threadId>/snapshots/<revId>.json  one snapshot, big strings as references
 *   <root>/<threadId>/blobs/<sha256>          each distinct big string, once
 *
 * An edit to one motion page adds that page's text and a small snapshot
 * skeleton, not another copy of every page. Opening a project reads only the
 * index; a snapshot is read when the renderer asks for it.
 *
 * Schema 1 kept everything in <root>/<threadId>.json. It is migrated the first
 * time the project opens, streamed one revision at a time.
 *
 * Every failure to read stored revisions degrades to "fewer revisions, plus a
 * `problem` to show": it never stops the project from opening. The project's
 * own thread.json holds the current timeline either way.
 */

export const MAX_REVISIONS = 100

interface StoredEntry extends EditorRevisionSummary {
	/** Blob hashes this revision's snapshot uses — lets deletes free text without reading snapshots. */
	blobRefs: string[]
}

interface IndexFile {
	schemaVersion: 2
	threadId: string
	revisionCounter: number
	revisions: StoredEntry[]
}

interface SnapshotFile {
	schemaVersion: 2
	revision: EditorRevisionSummary
	snapshot: RevisionSnapshot
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

function writeAtomic(target: string, data: string) {
	const temp = `${target}.tmp`
	fs.writeFileSync(temp, data)
	fs.renameSync(temp, target)
}

export class RevisionStore {
	private queues = new Map<string, Promise<unknown>>()
	/** A problem found while opening, handed to the renderer once with the next index load. */
	private problems = new Map<string, string>()

	constructor(private readonly root: string) {}

	// ---- paths ----

	private legacyPath(threadId: string) { return path.join(this.root, `${threadId}.json`) }
	private dir(threadId: string) { return path.join(this.root, threadId) }
	private indexPath(threadId: string) { return path.join(this.dir(threadId), 'index.json') }
	private snapshotsDir(threadId: string) { return path.join(this.dir(threadId), 'snapshots') }
	private blobsDir(threadId: string) { return path.join(this.dir(threadId), 'blobs') }
	private snapshotPath(threadId: string, revisionId: string) {
		const name = SAFE_ID.test(revisionId) ? revisionId : Buffer.from(revisionId).toString('hex').slice(0, 200)
		return path.join(this.snapshotsDir(threadId), `${name}.json`)
	}
	private blobPath(threadId: string, hash: string) { return path.join(this.blobsDir(threadId), hash) }

	/** One operation per project at a time: migration is async and must not interleave with a push. */
	private serial<T>(threadId: string, run: () => Promise<T> | T): Promise<T> {
		const previous = this.queues.get(threadId) || Promise.resolve()
		const next = previous.catch(() => undefined).then(run)
		this.queues.set(threadId, next)
		const clear = () => { if (this.queues.get(threadId) === next) this.queues.delete(threadId) }
		next.then(clear, clear)
		return next
	}

	private ensureDirs(threadId: string) {
		fs.mkdirSync(this.snapshotsDir(threadId), { recursive: true })
		fs.mkdirSync(this.blobsDir(threadId), { recursive: true })
	}

	private emptyIndex(threadId: string): IndexFile {
		return { schemaVersion: 2, threadId, revisionCounter: 0, revisions: [] }
	}

	private writeIndex(index: IndexFile) {
		fs.mkdirSync(this.dir(index.threadId), { recursive: true })
		writeAtomic(this.indexPath(index.threadId), JSON.stringify(index))
	}

	private noteProblem(threadId: string, message: string) {
		console.error(`[editor-revisions] ${threadId}: ${message}`)
		const earlier = this.problems.get(threadId)
		this.problems.set(threadId, earlier ? `${earlier} ${message}` : message)
	}

	// ---- writing one revision ----

	/** Writes the revision's text and snapshot file; returns its index entry. */
	private writeRevision(threadId: string, revision: EditorRevision): StoredEntry {
		this.ensureDirs(threadId)
		const summary = summarizeRevision(revision)
		const snapshot = dehydrate(revision.snapshot, (hash, text) => {
			const target = this.blobPath(threadId, hash)
			if (!fs.existsSync(target)) writeAtomic(target, text)
		})
		const file: SnapshotFile = { schemaVersion: 2, revision: summary, snapshot }
		writeAtomic(this.snapshotPath(threadId, revision.id), JSON.stringify(file))
		return { ...summary, blobRefs: [...collectRefs(snapshot)] }
	}

	/** Removes snapshot files for `removedIds` and any text no remaining revision uses. */
	private collectGarbage(threadId: string, index: IndexFile, removedIds: Iterable<string>) {
		for (const id of removedIds) {
			try { fs.rmSync(this.snapshotPath(threadId, id), { force: true }) } catch { /* best effort */ }
		}
		const live = new Set<string>()
		for (const entry of index.revisions) for (const hash of entry.blobRefs) live.add(hash)
		let names: string[] = []
		try { names = fs.readdirSync(this.blobsDir(threadId)) } catch { return }
		for (const name of names) {
			if (live.has(name) || name.endsWith('.tmp')) continue
			try { fs.rmSync(this.blobPath(threadId, name), { force: true }) } catch { /* best effort */ }
		}
	}

	// ---- opening ----

	/** Reads (migrating or repairing first if needed) the index. Never throws. */
	private async openIndex(threadId: string): Promise<IndexFile> {
		const legacy = this.legacyPath(threadId)
		const indexPath = this.indexPath(threadId)
		if (fs.existsSync(indexPath)) {
			if (fs.existsSync(legacy)) {
				// Migration finished but the old file outlived it (crash before cleanup).
				try { fs.rmSync(legacy, { force: true }) } catch { /* retried next open */ }
			}
			try {
				const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as IndexFile
				if (parsed?.schemaVersion !== 2 || !Array.isArray(parsed.revisions)) throw new Error('unexpected shape')
				return { ...parsed, threadId }
			} catch (error) {
				console.error(`[editor-revisions] Index for ${threadId} unreadable:`, error)
				return this.rebuildIndex(threadId)
			}
		}
		if (fs.existsSync(legacy)) return this.migrateLegacy(threadId)
		if (fs.existsSync(this.snapshotsDir(threadId))) return this.rebuildIndex(threadId)
		return this.emptyIndex(threadId)
	}

	/** Recreates index.json from the snapshot files (each carries its own summary). */
	private rebuildIndex(threadId: string): IndexFile {
		const index = this.emptyIndex(threadId)
		let names: string[] = []
		try { names = fs.readdirSync(this.snapshotsDir(threadId)) } catch { /* none */ }
		let unreadable = 0
		for (const name of names) {
			if (!name.endsWith('.json')) continue
			try {
				const file = JSON.parse(fs.readFileSync(path.join(this.snapshotsDir(threadId), name), 'utf-8')) as SnapshotFile
				if (!file?.revision?.id) throw new Error('no revision')
				index.revisions.push({ ...file.revision, blobRefs: [...collectRefs(file.snapshot)] })
			} catch {
				unreadable++
			}
		}
		index.revisions.sort((a, b) => a.seq - b.seq)
		index.revisionCounter = index.revisions.reduce((max, r) => Math.max(max, r.seq), 0)
		reattachOrphans(index.revisions)
		if (index.revisions.length || unreadable) {
			this.noteProblem(threadId, `The list of saved versions was damaged and has been rebuilt (${index.revisions.length} recovered${unreadable ? `, ${unreadable} unreadable` : ''}).`)
		}
		this.writeIndex(index)
		return index
	}

	/**
	 * Schema 1 → 2. Streams the old file one revision at a time, checks each
	 * converted revision restores to exactly the stored JSON, then deletes the
	 * old file. If the old file cannot be read to the end, whatever was read is
	 * kept, the old file is set aside (never deleted), and a problem is reported.
	 */
	private async migrateLegacy(threadId: string): Promise<IndexFile> {
		const legacy = this.legacyPath(threadId)
		const index = this.emptyIndex(threadId)
		const seen = new Set<string>()
		let skipped = 0
		let failure: unknown = null
		let rest: Record<string, unknown> = {}
		const started = Date.now()
		try {
			rest = await streamTopLevelArrays(legacy, ['revisions'], (_key, json) => {
				let revision: EditorRevision
				try {
					revision = JSON.parse(json) as EditorRevision
				} catch {
					skipped++
					return
				}
				if (!revision?.id || !revision.snapshot || !Array.isArray(revision.snapshot.timeline) || seen.has(revision.id)) {
					skipped++
					return
				}
				const blobs = new Map<string, string>()
				const roundTrip = JSON.stringify({
					...revision,
					snapshot: hydrate(dehydrate(revision.snapshot, (h, t) => blobs.set(h, t)), (h) => blobs.get(h))
				})
				if (roundTrip !== JSON.stringify(revision)) throw new Error(`Revision ${revision.id} did not convert cleanly`)
				index.revisions.push(this.writeRevision(threadId, revision))
				seen.add(revision.id)
			})
		} catch (error) {
			failure = error
		}

		const counter = typeof rest.revisionCounter === 'number' ? rest.revisionCounter : 0
		index.revisionCounter = Math.max(counter, ...index.revisions.map((r) => r.seq), 0)
		const reattached = reattachOrphans(index.revisions)
		this.writeIndex(index)
		this.collectGarbage(threadId, index, [])

		if (failure) {
			const aside = `${legacy}.unreadable-${Date.now()}`
			try { fs.renameSync(legacy, aside) } catch { /* left in place; the index now wins */ }
			const reason = failure instanceof Error ? failure.message : String(failure)
			this.noteProblem(threadId, `Older saved versions could not all be read (${reason}). ${index.revisions.length} were recovered; the original file was kept at ${aside}.`)
		} else {
			fs.rmSync(legacy, { force: true })
			if (skipped || reattached) {
				this.noteProblem(threadId, `${skipped} damaged saved version(s) were skipped while upgrading the version history.`)
			}
		}
		console.log(`[editor-revisions] Migrated ${index.revisions.length} revision(s) for ${threadId} in ${Date.now() - started} ms`)
		return index
	}

	// ---- public API (all serialised per project) ----

	/** Summaries for the revisions list, plus any problem found while opening. */
	loadIndex(threadId: string): Promise<EditorRevisionsIndex> {
		return this.serial(threadId, async () => {
			let index: IndexFile
			try {
				index = await this.openIndex(threadId)
			} catch (error) {
				// Last resort: open with no revisions rather than not at all.
				this.noteProblem(threadId, `Saved versions could not be opened (${error instanceof Error ? error.message : error}).`)
				index = this.emptyIndex(threadId)
			}
			const problem = this.problems.get(threadId)
			this.problems.delete(threadId)
			return {
				threadId,
				schemaVersion: 2 as const,
				revisionCounter: index.revisionCounter,
				revisions: index.revisions.map(({ blobRefs: _refs, ...summary }) => summary),
				...(problem ? { problem } : {})
			}
		})
	}

	/** One revision's full snapshot, or null when it is gone or damaged. */
	getSnapshot(threadId: string, revisionId: string): Promise<RevisionSnapshot | null> {
		return this.serial(threadId, async () => {
			await this.openIndex(threadId)
			try {
				const file = JSON.parse(fs.readFileSync(this.snapshotPath(threadId, revisionId), 'utf-8')) as SnapshotFile
				return hydrate(file.snapshot, (hash) => {
					try { return fs.readFileSync(this.blobPath(threadId, hash), 'utf-8') } catch { return undefined }
				})
			} catch (error) {
				console.error(`[editor-revisions] Snapshot ${revisionId} of ${threadId} unreadable:`, error)
				return null
			}
		})
	}

	/**
	 * Appends a revision: assigns a monotonic seq (max-ever — V numbers never
	 * reused after deletes) and enforces the cap by pruning the OLDEST LEAF
	 * that is neither the root nor the just-pushed revision.
	 */
	push(threadId: string, revision: EditorRevision): Promise<{ seq: number; count: number; prunedIds: string[] }> {
		return this.serial(threadId, async () => {
			const index = await this.openIndex(threadId)
			const seq = ++index.revisionCounter
			const entry = this.writeRevision(threadId, { ...revision, seq })
			index.revisions = index.revisions.filter((r) => r.id !== entry.id)
			index.revisions.push(entry)

			// Report what the cap removed, so the renderer stops listing it.
			const prunedIds = pruneToCap(index.revisions, entry.id, MAX_REVISIONS)
			index.revisions = applyPrune(index.revisions, prunedIds)
			this.writeIndex(index)
			if (prunedIds.length) this.collectGarbage(threadId, index, prunedIds)
			return { seq, count: index.revisions.length, prunedIds }
		})
	}

	/**
	 * Rewrites an existing revision's snapshot and label in place: same id, same
	 * seq, same place in the tree. An agent's round keeps ONE revision this way
	 * instead of one per edit. Unknown ids are appended like push, so a replace
	 * never loses a save. Text only the old snapshot used is collected.
	 */
	replace(threadId: string, revision: EditorRevision): Promise<{ seq: number; count: number; prunedIds: string[] }> {
		return this.serial(threadId, async () => {
			const index = await this.openIndex(threadId)
			const at = index.revisions.findIndex((r) => r.id === revision.id)
			if (at === -1) {
				const seq = ++index.revisionCounter
				index.revisions.push(this.writeRevision(threadId, { ...revision, seq }))
				const prunedIds = pruneToCap(index.revisions, revision.id, MAX_REVISIONS)
				index.revisions = applyPrune(index.revisions, prunedIds)
				this.writeIndex(index)
				if (prunedIds.length) this.collectGarbage(threadId, index, prunedIds)
				return { seq, count: index.revisions.length, prunedIds }
			}
			const old = index.revisions[at]
			// Parent, seq and birth time belong to the revision's place in the tree: they stay.
			index.revisions[at] = this.writeRevision(threadId, { ...revision, parentId: old.parentId, seq: old.seq, createdAt: old.createdAt })
			this.writeIndex(index)
			this.collectGarbage(threadId, index, [])
			return { seq: old.seq, count: index.revisions.length, prunedIds: [] }
		})
	}

	/** Deletes the given ids (the renderer sends the fully collected subtree). Never the root. */
	delete(threadId: string, ids: string[]): Promise<boolean> {
		return this.serial(threadId, async () => {
			const index = await this.openIndex(threadId)
			const remove = new Set(ids)
			const root = index.revisions.find((r) => r.parentId === null)
			if (root) remove.delete(root.id)
			index.revisions = index.revisions.filter((r) => !remove.has(r.id))
			this.writeIndex(index)
			this.collectGarbage(threadId, index, remove)
			return true
		})
	}

	/** Removes everything stored for a project (deleting the project). */
	deleteAll(threadId: string): Promise<void> {
		return this.serial(threadId, () => {
			for (const target of [this.dir(threadId), this.legacyPath(threadId)]) {
				try { fs.rmSync(target, { recursive: true, force: true }) } catch (error) {
					console.error(`[editor-revisions] Failed to delete ${target}:`, error)
				}
			}
			this.problems.delete(threadId)
		})
	}
}
