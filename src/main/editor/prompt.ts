import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type { EditorDocument, EditorOps, EditorPersona, PromptTurn, Thread, UsageRecord } from '@shared/types'
import { applyTimelineDiff, computeContentEnd, itemDuration } from '@shared/timeline'
import { threadManager } from '../threads'
import { settingsManager } from '../settings'
import { GeminiAdapter } from '../gemini/adapter'
import { GEMINI_MODEL_2_5_FLASH } from '../constants/gemini'
import { BUILTIN_PERSONAS, DEFAULT_PERSONA_ID } from '../constants/personas'
import { buildPromptContext } from './context'
import {
	composeSystemInstruction, EDITOR_OPS_SCHEMA, editorOpsSchema, measureBuild, opsToDiff,
	parseTargetLength, routeSurveyResponse, sumUsage, type PromptStats
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

/**
 * Output budget for a small-band (single-call) turn. Thinking draws from this
 * too, which is what makes the number matter: at 32_768 a build-from-scratch
 * turn over a 92-minute source truncated mid-JSON with finishReason MAX_TOKENS
 * while the emitted JSON was only ~10k tokens — thinking had taken the rest.
 */
const EDITOR_MAX_OUTPUT_TOKENS = 65_536
/**
 * Survey-band calls are capped far lower. Their legitimate outputs are small —
 * a region list, or ranges + excludeScenes + rationale (~3k tokens worst case
 * on the 1289-piece project) — and the cap doubles as the transport safety on
 * a decoding failure: a runaway generation that would run past ~5 minutes gets
 * killed by undici's 300s response-header timeout as an opaque "fetch failed",
 * retried three times (~15 minutes of nothing). At 16k the same failure
 * surfaces in about a minute as a legible MAX_TOKENS error.
 */
const SURVEY_MAX_OUTPUT_TOKENS = 16_384

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
			// No thinkingLevel, and temperature 0.7 — both settings are load-
			// bearing, established by probe matrices against the real 92-minute
			// project (n=3 per arm, plus repeated in-app failures):
			//
			// - thinkingLevel LOW collapses gemini-3-flash-preview's structured-
			//   output discipline on survey-sized inputs: digit repetition loops
			//   in number fields ("targetLengthSec": 120.0522111...), field fusion
			//   (the whole rationale written inside another field's string), and
			//   16k-token MAX_TOKENS runaways. MEDIUM still produced runaways.
			//   Dynamic thinking (no config) completed cleanly every probe at a
			//   cost of ~1-2k thought tokens. The historical 14-minute turns were
			//   this runaway: generation > 300s -> undici header timeout ->
			//   "fetch failed" x3 slow retries.
			// - Temperature 0.2 made the digit loops near-deterministic; 0.7
			//   escapes them. Drift toward over-curating is guarded by the OUTPUT
			//   LENGTH instruction block and measureBuild, not by temperature.
			const generationConfig = {
				temperature: 0.7
			}
			const hasItems = stats.timelineItemCount > 0
			// Record usage/cost at project level, one entry per model call, fired
			// from the adapter BEFORE the response parse — a pass that dies on
			// MAX_TOKENS, and a failed second pass, must not lose recorded spend.
			const recordUsage = (record: UsageRecord) => {
				void threadManager.updateThreadWith(threadId, (t) => ({
					usageHistory: [...(t.usageHistory || []), { ...record, timestamp: Date.now() }]
				}))
			}
			const surveyCallConfig = { ...generationConfig, maxOutputTokens: SURVEY_MAX_OUTPUT_TOKENS, onUsage: recordUsage }
			const fullCallConfig = { ...generationConfig, maxOutputTokens: EDITOR_MAX_OUTPUT_TOKENS, onUsage: recordUsage }

			const records: UsageRecord[] = []
			let ops: EditorOps | undefined
			let finalContext = context
			const passNotes: string[] = []

			if (context.band === 'survey') {
				// Pass 1: condensed survey; the model may trade this call for a
				// detail read instead of committing an edit (routeSurveyResponse).
				const survey = await adapter.generateStructuredText<EditorOps>(
					modelName,
					context.contextText,
					editorOpsSchema(hasItems, true),
					composeSystemInstruction(persona, stats, 'survey'),
					controller.signal,
					undefined,
					surveyCallConfig
				)
				records.push(survey.record)
				if (controller.signal.aborted) throw new Error('Cancelled')

				const route = routeSurveyResponse(survey.data, hasItems)
				if (route.note) passNotes.push(route.note)
				if (route.kind === 'expand') {
					const detailContext = buildPromptContext(doc, prompt, {
						selectedItemIds: options.selectedItemIds,
						playheadSec: options.playheadSec,
						widen: options.widen,
						expandRegions: route.regions
					})
					finalContext = detailContext
					const detail = await adapter.generateStructuredText<EditorOps>(
						modelName,
						detailContext.contextText,
						editorOpsSchema(hasItems, false),
						composeSystemInstruction(persona, stats, 'detail'),
						controller.signal,
						undefined,
						surveyCallConfig
					)
					records.push(detail.record)
					ops = detail.data
					passNotes.push(
						`Condensed survey of ${context.pieceCount} pieces; read ${detailContext.expandedPieces ?? 0} ` +
						`piece${detailContext.expandedPieces === 1 ? '' : 's'} across ${detailContext.expandedRegions ?? 0} ` +
						`span${detailContext.expandedRegions === 1 ? '' : 's'} in detail before editing.`
					)
				} else {
					ops = route.ops
				}
			} else {
				const single = await adapter.generateStructuredText<EditorOps>(
					modelName,
					context.contextText,
					editorOpsSchema(hasItems),
					composeSystemInstruction(persona, stats),
					controller.signal,
					undefined,
					fullCallConfig
				)
				records.push(single.record)
				ops = single.data
			}

			if (controller.signal.aborted) throw new Error('Cancelled')

			// Map ops against a FRESH read (doc may have advanced during the call);
			// the renderer re-validates against ITS live doc anyway.
			const freshDoc = threadManager.getThread(threadId)?.editor || doc
			const { diff, addMarkers, droppedOps, notes } = opsToDiff(ops || {}, freshDoc)
			const targetLengthSec = parseTargetLength(ops?.targetLength)
			const build = measureBuild(diff, freshDoc, stats, targetLengthSec)

			// The quiet failure the design critique predicted: a SHORT cut from
			// scratch committed off gists alone. Valid, but worth surfacing —
			// unlike a full-length cleanup, where survey granularity is exactly
			// the designed one-pass path and the same note would be noise.
			const builtShortFromGists =
				context.band === 'survey' && records.length === 1 && !hasItems && !ops?.answer &&
				!!(ops?.addClips?.length || ops?.addSceneRanges?.length) &&
				!!build && build.producedSec < 0.5 * build.sourceSec
			if (builtShortFromGists) {
				passNotes.push(
					`Built a short cut from the condensed survey (${context.pieceCount} pieces) without ` +
					'reading any span in detail — piece choices inside groups were made from gists alone.'
				)
			}
			const allNotes = [...passNotes, ...notes]

			const completed: PromptTurn = {
				...turn,
				status: 'completed',
				diff,
				rationale: ops?.rationale,
				targetLengthSec,
				answer: ops?.answer,
				droppedOps: droppedOps.length ? droppedOps : undefined,
				notes: allNotes.length ? allNotes : undefined,
				build,
				scopeLabel: context.scope.label,
				usage: sumUsage(records.map((r) => r.usage)),
				cost: records.reduce((sum, r) => sum + r.cost, 0)
			}
			await persistTurn(threadId, completed)
			emitTurnUpdate({
				threadId,
				turn: completed,
				addMarkers,
				thinContext: finalContext.thinContext,
				// OR-ed: the flag must survive whichever pass truncated — the
				// detail pass is a strict superset of the survey, so it can hit
				// the char budget when the survey did not.
				truncated: context.truncated || finalContext.truncated
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

