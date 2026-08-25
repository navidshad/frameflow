import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EditorRevision, EditorRevisionsFile } from '@shared/types'
import { applyPrune, pruneToCap } from '@shared/revision-tree'

/**
 * Revision-tree sidecar persistence (mirrors editor/history.ts).
 * Revisions are coarse, permanent checkpoints holding FULL timeline
 * snapshots — kept OUT of threads/{id}.json so the debounced doc autosave
 * stays O(1), and OUT of the capped undo ring so they never dangle.
 * The renderer owns the tree logic; this module only load/push/delete/persists.
 */

const MAX_REVISIONS = 100

function revisionsDir(): string {
	return path.join(app.getPath('userData'), 'editor-revisions')
}

function revisionsPath(threadId: string): string {
	return path.join(revisionsDir(), `${threadId}.json`)
}

function emptyFile(threadId: string): EditorRevisionsFile {
	return { threadId, schemaVersion: 1, revisionCounter: 0, revisions: [] }
}

function writeRevisions(file: EditorRevisionsFile) {
	const dir = revisionsDir()
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	const target = revisionsPath(file.threadId)
	const temp = `${target}.tmp`
	fs.writeFileSync(temp, JSON.stringify(file))
	fs.renameSync(temp, target)
}

export function loadRevisions(threadId: string): EditorRevisionsFile {
	const filePath = revisionsPath(threadId)
	if (!fs.existsSync(filePath)) return emptyFile(threadId)
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EditorRevisionsFile
		if (!Array.isArray(parsed.revisions)) return emptyFile(threadId)
		return { ...emptyFile(threadId), ...parsed, threadId }
	} catch (error) {
		console.error(`[editor-revisions] Failed to read revisions for ${threadId}:`, error)
		return emptyFile(threadId)
	}
}

/**
 * Appends a revision: assigns a monotonic seq (max-ever — V numbers never
 * reused after deletes) and enforces the cap by pruning the OLDEST LEAF
 * (no children) that is neither the root nor the just-pushed revision.
 * Leaf-only pruning guarantees no surviving revision loses an ancestor.
 */
export function pushRevision(
	threadId: string,
	revision: EditorRevision
): { seq: number; count: number; prunedIds: string[] } {
	const file = loadRevisions(threadId)
	const seq = ++file.revisionCounter
	const stored: EditorRevision = { ...revision, seq }
	file.revisions.push(stored)

	// Report what the cap removed. Without this the renderer keeps showing a
	// revision that no longer exists on disk until the project is reloaded.
	const prunedIds = pruneToCap(file.revisions, stored.id, MAX_REVISIONS)
	file.revisions = applyPrune(file.revisions, prunedIds)

	writeRevisions(file)
	return { seq, count: file.revisions.length, prunedIds }
}

/** Deletes the given ids (the renderer sends the fully collected subtree). */
export function deleteRevisions(threadId: string, ids: string[]): boolean {
	const file = loadRevisions(threadId)
	const remove = new Set(ids)
	// Never delete the root
	const root = file.revisions.find((r) => r.parentId === null)
	if (root) remove.delete(root.id)
	file.revisions = file.revisions.filter((r) => !remove.has(r.id))
	writeRevisions(file)
	return true
}

export function deleteRevisionsFile(threadId: string): void {
	const filePath = revisionsPath(threadId)
	try {
		if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
	} catch (error) {
		console.error(`[editor-revisions] Failed to delete revisions for ${threadId}:`, error)
	}
}
