import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type {
	EditorDocument, EditorOps, EditorPersona, PromptTurn, Thread, TimelineDiff, TimelineItem
} from '@shared/types'
import { computeContentEnd, itemEnd, TIMELINE_DIFF_SCHEMA_VERSION } from '@shared/timeline'
import { threadManager } from '../threads'
import { settingsManager } from '../settings'
import { GeminiAdapter } from '../gemini/adapter'
import { GEMINI_MODEL_2_5_FLASH } from '../constants/gemini'
import { BUILTIN_PERSONAS, DEFAULT_PERSONA_ID } from '../constants/personas'
import { buildPromptContext } from './context'

/**
 * AI prompt orchestrator for the timeline editor (PRD §5.7).
 * One structured Gemini call per turn: persona systemPrompt + fixed editor
 * contract + windowed context -> EditorOps -> TimelineDiff (opsToDiff).
 * Streams turn state over the dedicated `editor-turn-update` event.
 * The base document is NEVER mutated here — the renderer applies the diff
 * only on user accept (commitStep with origin 'ai').
 */

// ===== Ops schema (constrained on purpose — see EditorOps in shared/types) =====
export const EDITOR_OPS_SCHEMA = {
	type: 'object',
	properties: {
		answer: {
			type: 'string',
			description: 'Only when the request is a question — answer it and propose no operations'
		},
		rationale: {
			type: 'string',
			description: 'Plain-language explanation of the proposed edit, citing scene descriptions'
		},
		removeItemIds: { type: 'array', items: { type: 'string' } },
		updateItems: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					timelineStart: { type: 'number' },
					in: { type: 'number' },
					out: { type: 'number' },
					speed: { type: 'number' },
					label: { type: 'string' },
					gain: { type: 'number' },
					fadeInSec: { type: 'number' },
					fadeOutSec: { type: 'number' }
				},
				required: ['id']
			}
		},
		addClips: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					assetId: { type: 'string' },
					sceneIndex: { type: 'integer', description: "A scene # from that asset's AVAILABLE SCENES list" },
					in: { type: 'number' },
					out: { type: 'number' },
					atSec: { type: 'number' },
					afterItemId: { type: 'string' },
					label: { type: 'string' }
				},
				required: ['assetId']
			}
		},
		addMarkers: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					atSec: { type: 'number' },
					label: { type: 'string' }
				},
				required: ['atSec', 'label']
			}
		}
	}
}

// ===== System instruction composition =====
export function composeSystemInstruction(persona: EditorPersona): string {
	const defaults = persona.defaults || {}
	const durationLine = defaults.targetDurationSec != null
		? `Target output duration: about ${defaults.targetDurationSec} seconds. Cut toward this target.`
		: 'No length target — PRESERVE the full runtime. Make editorial improvements (remove dead air, tighten with retime, reorder, chapter) without shrinking the substantive content.'

	return [
		persona.systemPrompt,
		'',
		'=== EDITOR CONTRACT (always applies) ===',
		'You are proposing an edit to a video timeline in a non-linear editor. You receive the',
		"current timeline items (each with a stable id), the project's media assets with their",
		'detected scenes, and a user request.',
		'- If the request is a QUESTION about the project, put the answer in `answer` and',
		'  propose no operations.',
		'- Otherwise propose ONE coherent edit:',
		'  - Reference existing timeline items ONLY by their exact `id` from the items list.',
		'  - Add new material ONLY via `addClips`, referencing an `assetId` plus a scene `#`',
		"    from that asset's AVAILABLE SCENES list (preferred), or explicit in/out seconds",
		"    within the asset's duration.",
		'  - Never invent ids or scene numbers. All times are seconds.',
		'  - `updateItems` may change timelineStart, in, out, speed (0.25-4.0), label,',
		'    gain (0-2, audio mix level), and fadeInSec / fadeOutSec (audio fade lengths, seconds).',
		'    Never set durations — they are derived from (out - in) / speed.',
		'  - Only modify items listed in the items section.',
		'- Always include a short `rationale` describing what you changed and why, citing',
		'  scene descriptions where available.',
		'',
		'=== ACTIVE PERSONA DEFAULTS ===',
		`Tone: ${persona.tone || 'neutral'}. Pacing: ${defaults.pacing || 'balanced'}.`,
		durationLine,
		defaults.aspectRatio ? `Target aspect ratio: ${defaults.aspectRatio}.` : ''
	].filter(Boolean).join('\n')
}

// ===== Ops -> TimelineDiff mapping =====
export function opsToDiff(
	ops: EditorOps,
	doc: EditorDocument
): { diff: TimelineDiff; addMarkers: { time: number; label: string }[]; droppedOps: string[] } {
	const droppedOps: string[] = []
	const diff: TimelineDiff = { schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION }
	const itemIds = new Set(doc.timeline.map((i) => i.id))

	// Removals
	if (ops.removeItemIds?.length) {
		const known = ops.removeItemIds.filter((id) => itemIds.has(id))
		for (const id of ops.removeItemIds) {
			if (!itemIds.has(id)) droppedOps.push(`remove: unknown item ${id}`)
		}
		if (known.length) diff.removeItemIds = known
	}

	// Updates (whitelist fields; validation happens in applyTimelineDiff)
	if (ops.updateItems?.length) {
		const updates: NonNullable<TimelineDiff['updateItems']> = []
		for (const update of ops.updateItems) {
			if (!itemIds.has(update.id)) {
				droppedOps.push(`update: unknown item ${update.id}`)
				continue
			}
			const clean: { id: string } & Partial<TimelineItem> = { id: update.id }
			if (typeof update.timelineStart === 'number') clean.timelineStart = update.timelineStart
			if (typeof update.in === 'number') clean.in = update.in
			if (typeof update.out === 'number') clean.out = update.out
			if (typeof update.speed === 'number') clean.speed = update.speed
			if (typeof update.label === 'string') clean.label = update.label
			// Audio adjustments — clamped again in applyTimelineDiff's normalize
			if (typeof update.gain === 'number') clean.gain = Math.max(0, Math.min(2, update.gain))
			if (typeof update.fadeInSec === 'number') clean.fadeInSec = Math.max(0, update.fadeInSec)
			if (typeof update.fadeOutSec === 'number') clean.fadeOutSec = Math.max(0, update.fadeOutSec)
			if (Object.keys(clean).length > 1) updates.push(clean)
		}
		if (updates.length) diff.updateItems = updates
	}

	// Adds: resolve asset + scene references; ids generated HERE, never by the model
	if (ops.addClips?.length) {
		const adds: TimelineItem[] = []
		// Sequential placement cursor for adds without explicit position
		let appendCursor = computeContentEnd(doc.timeline)
		const targetTrack = [...doc.tracks]
			.sort((a, b) => a.order - b.order)
			.find((t) => t.kind === 'video' && !t.locked && !t.hidden)

		for (const add of ops.addClips) {
			const asset = doc.media.find((a) => a.id === add.assetId)
			if (!asset) {
				droppedOps.push(`add: unknown asset ${add.assetId}`)
				continue
			}
			if (!targetTrack) {
				droppedOps.push('add: no unlocked video track available')
				break
			}

			let sourceIn: number | undefined
			let sourceOut: number | undefined
			let sourceClipId: string | undefined
			let masterSegmentIndex: number | undefined
			let label = add.label

			if (typeof add.sceneIndex === 'number') {
				const clip = asset.clips.find((c) => c.index === add.sceneIndex)
				if (!clip) {
					droppedOps.push(`add: unknown scene #${add.sceneIndex} of ${asset.name}`)
					continue
				}
				sourceIn = clip.in
				sourceOut = clip.out
				sourceClipId = clip.id
				masterSegmentIndex = clip.masterSegmentIndex
				label = label || clip.visual?.slice(0, 40) || `Piece #${clip.index}`
			} else if (typeof add.in === 'number' && typeof add.out === 'number') {
				const assetDuration = asset.metadata?.duration ?? Number.POSITIVE_INFINITY
				if (!(add.in >= 0 && add.out > add.in && add.out <= assetDuration + 0.01)) {
					droppedOps.push(`add: invalid range ${add.in}-${add.out} for ${asset.name}`)
					continue
				}
				sourceIn = add.in
				sourceOut = add.out
				label = label || asset.name
			} else {
				droppedOps.push(`add: neither sceneIndex nor in/out given for ${asset.name}`)
				continue
			}

			// Placement: explicit atSec > after a known item > append at end
			let timelineStart: number
			if (typeof add.atSec === 'number' && add.atSec >= 0) {
				timelineStart = add.atSec
			} else if (add.afterItemId && itemIds.has(add.afterItemId)) {
				const anchor = doc.timeline.find((i) => i.id === add.afterItemId)!
				timelineStart = itemEnd(anchor)
			} else {
				timelineStart = appendCursor
			}

			const duration = sourceOut! - sourceIn!
			adds.push({
				id: uuidv4(),
				trackId: targetTrack.id,
				sourceAssetId: asset.id,
				sourceClipId,
				masterSegmentIndex,
				timelineStart,
				in: sourceIn!,
				out: sourceOut!,
				speed: 1.0,
				preservePitch: true,
				duration,
				label
			})
			appendCursor = Math.max(appendCursor, timelineStart + duration)
		}
		if (adds.length) diff.addItems = adds
	}

	const addMarkers = (ops.addMarkers || [])
		.filter((m) => typeof m.atSec === 'number' && m.atSec >= 0 && m.label)
		.map((m) => ({ time: m.atSec, label: m.label }))

	return { diff, addMarkers, droppedOps }
}

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

			const modelSettings = settingsManager.getModelSettings()
			const modelName = modelSettings.selection['editor-edit'] || GEMINI_MODEL_2_5_FLASH

			const adapter = GeminiAdapter.create()
			const { data: ops, record } = await adapter.generateStructuredText<EditorOps>(
				modelName,
				context.contextText,
				EDITOR_OPS_SCHEMA,
				composeSystemInstruction(persona),
				controller.signal
			)

			// Record usage/cost at project level
			await threadManager.updateThreadWith(threadId, (t) => ({
				usageHistory: [...(t.usageHistory || []), { ...record, timestamp: Date.now() }]
			}))

			if (controller.signal.aborted) throw new Error('Cancelled')

			// Map ops against a FRESH read (doc may have advanced during the call);
			// the renderer re-validates against ITS live doc anyway.
			const freshDoc = threadManager.getThread(threadId)?.editor || doc
			const { diff, addMarkers, droppedOps } = opsToDiff(ops || {}, freshDoc)

			const completed: PromptTurn = {
				...turn,
				status: 'completed',
				diff,
				rationale: ops?.rationale,
				answer: ops?.answer,
				droppedOps: droppedOps.length ? droppedOps : undefined,
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
