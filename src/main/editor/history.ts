import { app } from 'electron'
import path from 'path'
import type { EditorHistoryLoad, EditorHistoryStep, TimelineSnapshot } from '@shared/types'
import { threadManager } from '../threads'
import { HistoryStore } from './historyStore'

/**
 * Undo/redo sidecar persistence for the timeline editor (PRD §6).
 * History lives OUTSIDE threads/{id}.json so the debounced doc autosave is
 * decoupled from history growth. The renderer is authoritative for applying
 * diffs; main loads/appends/prunes and persists (storage: ./historyStore.ts).
 *
 * The pointer of record is doc.historyRef.currentStepId (persisted with the
 * doc in one atomic write); the sidecar's currentStepId is informational.
 */

let store: HistoryStore | null = null
function historyStore(): HistoryStore {
	if (!store) {
		store = new HistoryStore(
			path.join(app.getPath('userData'), 'editor-history'),
			(threadId) => threadManager.getNextVersion(threadId)
		)
	}
	return store
}

export function loadHistory(threadId: string): Promise<EditorHistoryLoad> {
	return historyStore().load(threadId)
}

export function pushStep(
	threadId: string,
	step: EditorHistoryStep,
	keyframe?: TimelineSnapshot
): Promise<{ seq: number; stepCount: number; prunedIds: string[] }> {
	return historyStore().pushStep(threadId, step, keyframe)
}

export function setPointer(threadId: string, currentStepId: string): Promise<boolean> {
	return historyStore().setPointer(threadId, currentStepId)
}

/**
 * Wipes the fine-grained ring (used on revision switches: old steps' diffs
 * were computed against pre-switch states — redoing them onto a switched
 * snapshot would corrupt it, and a pointer-only reset would rehydrate them).
 */
export function clearHistory(threadId: string): Promise<void> {
	return historyStore().clear(threadId)
}

export function deleteHistory(threadId: string): Promise<void> {
	return historyStore().delete(threadId)
}
