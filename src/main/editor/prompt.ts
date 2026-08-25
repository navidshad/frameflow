import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type { EditorDocument, EditorOps, EditorPersona, PromptTurn, Thread } from '@shared/types'
import { applyTimelineDiff, computeContentEnd, itemDuration } from '@shared/timeline'
import { threadManager } from '../threads'
import { settingsManager } from '../settings'
import { GeminiAdapter } from '../gemini/adapter'
import { GEMINI_MODEL_2_5_FLASH } from '../constants/gemini'
import { BUILTIN_PERSONAS, DEFAULT_PERSONA_ID } from '../constants/personas'
import { buildPromptContext } from './context'
import {
	composeSystemInstruction, EDITOR_OPS_SCHEMA, measureBuild, opsToDiff, type PromptStats
} from './ops'

/**
 * AI prompt orchestrator for the timeline editor (PRD §5.7).
 * One structured Gemini call per turn: persona systemPrompt + fixed editor
 * contract + windowed context -> EditorOps -> TimelineDiff (opsToDiff).
 * Streams turn state over the dedicated `editor-turn-update` event.
 * The base document is NEVER mutated here — the renderer applies the diff
 * when the turn completes and records it as a revision.
 */

// The ops contract lives in ./ops so it stays free of Electron imports (testable).
export { EDITOR_OPS_SCHEMA, composeSystemInstruction, opsToDiff }

/** Reserve enough output for a large assembly; thinking draws from this budget too. */
const EDITOR_MAX_OUTPUT_TOKENS = 32_768

// ===== Turn lifecycle =====
const turnControllers = new Map<string, AbortController>()

function emitTurnUpdate(payload: {
	threadId: string
	turn: PromptTurn
	addMarkers?: { time: number; label: string }[]
	thinContext?: boolean
	truncated?: boolean
}) {
	BrowserWindow.getAllWindows().forEach((win) => {
		win.webContents.send('editor-turn-update', payload)
	})
}

async function persistTurn(threadId: string, turn: PromptTurn): Promise<void> {
	await threadManager.updateThreadWith(threadId, (thread) => {
		if (!thread.editor) return null
		const turns = [...thread.editor.turns]
		const index = turns.findIndex((t) => t.id === turn.id)
		if (index === -1) turns.push(turn)
		else turns[index] = turn
		return { editor: { ...thread.editor, turns } }
	})
}

function resolvePersona(doc: EditorDocument, personaId: string): EditorPersona {
	return (
		doc.customPersonas?.find((p) => p.id === personaId) ||
		settingsManager.getPersonas().find((p) => p.id === personaId) ||
		BUILTIN_PERSONAS.find((p) => p.id === personaId) ||
		BUILTIN_PERSONAS.find((p) => p.id === DEFAULT_PERSONA_ID)!
	)
}

export function abortEditorPrompt(turnId: string): void {
	const controller = turnControllers.get(turnId)
	if (controller) {
		controller.abort()
		turnControllers.delete(turnId)
	}
}

/**
 * Runs one prompt turn. Returns the turnId immediately; work continues async
 * and streams over `editor-turn-update`.
 */
export function runEditorPrompt(options: {
	threadId: string
	personaId: string
	prompt: string
	baseStepId: string
	selectedItemIds: string[]
	playheadSec: number
	widen?: 'chapter' | 'full'
}): { turnId: string } {
	const { threadId, personaId, prompt, baseStepId } = options
	const turnId = uuidv4()

	const turn: PromptTurn = {
		id: turnId,
		personaId,
		prompt,
		baseStepId,
		status: 'running',
		createdAt: Date.now()
	}

	// Async body — errors land on the turn record, never thrown to the caller
	void (async () => {
		const controller = new AbortController()
		turnControllers.set(turnId, controller)
		try {
			const thread: Thread | null = threadManager.getThread(threadId)
			if (!thread || thread.type !== 'editor' || !thread.editor) {
				throw new Error('Not an editor project')
			}
			if (thread.editor.media.length === 0) {
				throw new Error('Import media before prompting')
			}
			const doc = thread.editor

			await persistTurn(threadId, turn)
			emitTurnUpdate({ threadId, turn })

			const persona = resolvePersona(doc, personaId)
			const context = buildPromptContext(doc, prompt, {
				selectedItemIds: options.selectedItemIds,
				playheadSec: options.playheadSec,
				widen: options.widen
			})

			// What "full length" means for this project. Only in-scope, timed assets
			// count: quoting a runtime the model cannot see invites it to invent
			// material, and images have no intrinsic duration.
			const scopeAssetIds = new Set(context.scope.assetIds)
			const timedAssets = doc.media.filter(
				(a) => scopeAssetIds.has(a.id) && (a.kind === 'video' || a.kind === 'audio')
			)
			const stats: PromptStats = {
				timelineItemCount: doc.timeline.length,
				timelineDurationSec: computeContentEnd(doc.timeline),
				sourceDurationSec: timedAssets.reduce((sum, a) => sum + (a.metadata?.duration ?? 0), 0),
				sourceClipCount: timedAssets.reduce((sum, a) => sum + (a.clips?.length ?? 0), 0)
			}

			const modelSettings = settingsManager.getModelSettings()
			const modelName = modelSettings.selection['editor-edit'] || GEMINI_MODEL_2_5_FLASH

			const adapter = GeminiAdapter.create()
			const { data: ops, record } = await adapter.generateStructuredText<EditorOps>(
				modelName,
				context.contextText,
				EDITOR_OPS_SCHEMA,
				composeSystemInstruction(persona, stats),
				controller.signal,
				undefined,
				// Assembly is bookkeeping, not creative writing: bound the thinking
				// (it bills at the OUTPUT rate and shares the output budget) and keep
				// the temperature low so the model does not drift into curating.
				{ maxOutputTokens: EDITOR_MAX_OUTPUT_TOKENS, thinkingLevel: 'LOW', temperature: 0.2 }
			)

			// Record usage/cost at project level
			await threadManager.updateThreadWith(threadId, (t) => ({
				usageHistory: [...(t.usageHistory || []), { ...record, timestamp: Date.now() }]
			}))

			if (controller.signal.aborted) throw new Error('Cancelled')

			// Map ops against a FRESH read (doc may have advanced during the call);
			// the renderer re-validates against ITS live doc anyway.
			const freshDoc = threadManager.getThread(threadId)?.editor || doc
			const { diff, addMarkers, droppedOps, notes } = opsToDiff(ops || {}, freshDoc)

			const completed: PromptTurn = {
				...turn,
				status: 'completed',
				diff,
				rationale: ops?.rationale,
				targetLengthSec: ops?.targetLengthSec,
				answer: ops?.answer,
				droppedOps: droppedOps.length ? droppedOps : undefined,
				notes: notes.length ? notes : undefined,
				build: measureBuild(diff, freshDoc, stats, ops?.targetLengthSec),
				scopeLabel: context.scope.label,
				usage: record.usage,
				cost: record.cost
			}
			await persistTurn(threadId, completed)
			emitTurnUpdate({
				threadId,
				turn: completed,
				addMarkers,
				thinContext: context.thinContext,
				truncated: context.truncated
			})
		} catch (error: any) {
			const message = controller.signal.aborted ? 'Cancelled' : (error?.message || 'Prompt failed')
			const failed: PromptTurn = { ...turn, status: 'error', error: message }
			try {
				await persistTurn(threadId, failed)
			} catch { /* best effort */ }
			emitTurnUpdate({ threadId, turn: failed })
		} finally {
			turnControllers.delete(turnId)
		}
	})()

	return { turnId }
}

