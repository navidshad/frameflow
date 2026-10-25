import { app } from 'electron'
import path from 'path'
import type { EditorRevision, EditorRevisionsIndex, RevisionSnapshot } from '@shared/types'
import { RevisionStore } from './revisionStore'

/**
 * Revision-tree sidecar (mirrors editor/history.ts). Revisions are coarse,
 * permanent checkpoints holding full timeline snapshots, kept OUT of
 * threads/{id}.json so the debounced doc autosave stays O(1). The renderer
 * owns the tree logic; main stores, prunes and serves snapshots on request.
 * Storage layout and migration: ./revisionStore.ts.
 */

let store: RevisionStore | null = null
function revisionStore(): RevisionStore {
	if (!store) store = new RevisionStore(path.join(app.getPath('userData'), 'editor-revisions'))
	return store
}

export function loadRevisions(threadId: string): Promise<EditorRevisionsIndex> {
	return revisionStore().loadIndex(threadId)
}

export function getRevisionSnapshot(threadId: string, revisionId: string): Promise<RevisionSnapshot | null> {
	return revisionStore().getSnapshot(threadId, revisionId)
}

export function pushRevision(
	threadId: string,
	revision: EditorRevision
): Promise<{ seq: number; count: number; prunedIds: string[] }> {
	return revisionStore().push(threadId, revision)
}

/** Deletes the given ids (the renderer sends the fully collected subtree). */
export function deleteRevisions(threadId: string, ids: string[]): Promise<boolean> {
	return revisionStore().delete(threadId, ids)
}

export function deleteRevisionsFile(threadId: string): Promise<void> {
	return revisionStore().deleteAll(threadId)
}
