import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { EditorHistoryFile, EditorHistoryStep, TimelineSnapshot } from '@shared/types'
import { threadManager } from '../threads'
import { applyStepCap } from '@shared/editor-history'

/**
 * Undo/redo sidecar persistence for the timeline editor (PRD §6).
 * History lives OUTSIDE threads/{id}.json so the debounced doc autosave is
 * decoupled from history growth. The renderer is authoritative for applying
 * diffs; this module only loads/appends/prunes and persists.
 *
 * The pointer of record is doc.historyRef.currentStepId (persisted with the
 * doc in one atomic write); the sidecar's currentStepId is informational.
 */

const MAX_STEPS = 50

function historyDir(): string {
	return path.join(app.getPath('userData'), 'editor-history')
}

function historyPath(threadId: string): string {
	return path.join(historyDir(), `${threadId}.json`)
}

function emptyHistory(threadId: string): EditorHistoryFile {
	return { threadId, steps: [], keyframes: [], currentStepId: '' }
}

function writeHistory(file: EditorHistoryFile) {
	const dir = historyDir()
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
	// Write-temp-then-rename so a crash mid-write can't corrupt the file.
	const target = historyPath(file.threadId)
	const temp = `${target}.tmp`
	fs.writeFileSync(temp, JSON.stringify(file))
	fs.renameSync(temp, target)
}

export function loadHistory(threadId: string): EditorHistoryFile {
	const filePath = historyPath(threadId)
	if (!fs.existsSync(filePath)) return emptyHistory(threadId)
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as EditorHistoryFile
		if (!Array.isArray(parsed.steps)) return emptyHistory(threadId)
		return { ...emptyHistory(threadId), ...parsed, threadId }
	} catch (error) {
		console.error(`[editor-history] Failed to read history for ${threadId}:`, error)
		return emptyHistory(threadId)
	}
}

/**
 * Appends a step: truncates any redo branch after the current pointer,
 * assigns a monotonic seq, enforces the ring cap, stores an optional
 * keyframe, and moves the pointer to the new step.
 * Returns the assigned seq + resulting step count (renderer mirrors the ring).
 */
export async function pushStep(
	threadId: string,
	step: EditorHistoryStep,
	keyframe?: TimelineSnapshot
): Promise<{ seq: number; stepCount: number; prunedIds: string[] }> {
	const file = loadHistory(threadId)

	// Kill the redo branch beyond the current pointer
	const pointerIndex = file.steps.findIndex((s) => s.id === file.currentStepId)
	if (pointerIndex !== -1 && pointerIndex < file.steps.length - 1) {
		const removed = new Set(file.steps.slice(pointerIndex + 1).map((s) => s.id))
		file.steps = file.steps.slice(0, pointerIndex + 1)
		file.keyframes = file.keyframes.filter((k) => !removed.has(k.stepId))
	} else if (pointerIndex === -1 && file.currentStepId === '' && file.steps.length > 0) {
		// Pointer at pre-history root: everything is a redo branch — drop it
		file.steps = []
		file.keyframes = []
	}

	const seq = await threadManager.getNextVersion(threadId)
	const stored: EditorHistoryStep = { ...step, seq }
	file.steps.push(stored)

	if (keyframe) {
		file.keyframes.push({ ...keyframe, stepId: stored.id })
	}

	// Ring cap: evict oldest steps; keep the newest keyframe at-or-before the
	// new oldest step as the replay baseline, drop older ones.
	//
	// The evicted ids are REPORTED rather than left for the renderer to work out.
	// It used to re-implement this cap with its own literal 50 — two numbers on
	// opposite sides of an IPC boundary that had to agree, with nothing linking
	// them. Main owns the cap; the renderer applies what main says it dropped,
	// which is how the revisions sidecar already works.
	const capped = applyStepCap(file.steps, file.keyframes, MAX_STEPS)
	file.steps = capped.steps
	file.keyframes = capped.keyframes
	const prunedIds = capped.prunedIds

	file.currentStepId = stored.id
	writeHistory(file)
	return { seq, stepCount: file.steps.length, prunedIds }
}

export function setPointer(threadId: string, currentStepId: string): boolean {
	const file = loadHistory(threadId)
	file.currentStepId = currentStepId
	writeHistory(file)
	return true
}

/**
 * Wipes the fine-grained ring (used on revision switches: old steps' diffs
 * were computed against pre-switch states — redoing them onto a switched
 * snapshot would corrupt it, and a pointer-only reset would rehydrate them).
 */
export function clearHistory(threadId: string): void {
	writeHistory(emptyHistory(threadId))
}

export function deleteHistory(threadId: string): void {
	const filePath = historyPath(threadId)
	try {
		if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
	} catch (error) {
		console.error(`[editor-history] Failed to delete history for ${threadId}:`, error)
	}
}
