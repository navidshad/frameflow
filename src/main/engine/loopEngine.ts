import { app } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { buildEngineSystemPrompt, buildEngineUserPrompt, ENGINES, type EngineStep, type LoopEngineId } from '@shared/engines'
import type { AgentActivity } from '@shared/agentFeed'
import type { UsageRecord } from '@shared/types'
import { settingsManager } from '../settings'
import { GeminiAdapter } from '../gemini/adapter'
import { GEMINI_MODEL_3_FLASH_PREVIEW } from '../constants/gemini'
import { rendererBridge, switchRevisionFor } from '../mcp/rendererBridge'
import { probeMotionPage } from '../motion/probe'
import { enginePermissions } from './runner'
import { loadConversation, pruneConversations, saveConversation } from './loop/conversation'
import { createLoopModel } from './loop/providers'
import { runLoopTurn, type LoopRunResult } from './loop/runLoopTurn'

/**
 * A chat turn run by an engine whose loop lives in FrameFlow, wired to the app:
 * the key and model from settings, the project's saved conversation, the spend
 * records. The loop itself is loop/runLoopTurn, which knows none of this.
 */

export interface LoopTurnArgs {
	id: LoopEngineId
	turnId: string
	prompt: string
	playheadSec: number
	selectedItemIds: string[]
	widen?: 'chapter' | 'full'
	maxSteps: number
	/** The conversation to continue, when the newest chat turn of this engine has one. */
	resumeId?: string
	/** This project's folder for saved conversations. */
	dir: string
	signal: AbortSignal
	onSteps: (steps: EngineStep[], model?: string) => void
	onActivity: (activity: AgentActivity) => void
}

export interface LoopTurnOutcome {
	result: LoopRunResult
	/** The id the chat turn carries so the next turn finds this conversation; none when there is nothing to resume. */
	sessionId?: string
	/** One per model call, for the project's spend history. */
	records: UsageRecord[]
}

/** The key and model an engine runs on. A new loop engine adds its own case. */
function credentialsFor(id: LoopEngineId): { apiKey: string; modelName: string } {
	switch (id) {
		case 'gemini-api': {
			const apiKey = settingsManager.getGeminiApiKey()
			if (!apiKey) throw new Error('Add a Gemini API key in Settings to use the Gemini API.')
			return { apiKey, modelName: settingsManager.getModelSettings().selection['editor-edit'] || GEMINI_MODEL_3_FLASH_PREVIEW }
		}
	}
}

/** Dollars for a call, from the project's price table. */
function costOf(id: LoopEngineId, modelName: string, usage: UsageRecord['usage']): number {
	switch (id) {
		case 'gemini-api': return GeminiAdapter.calculateCost(modelName, usage)
	}
}

export async function runLoopEngineTurn(args: LoopTurnArgs): Promise<LoopTurnOutcome> {
	const label = ENGINES[args.id].label
	const { apiKey, modelName } = credentialsFor(args.id)
	const history = await loadConversation(args.dir, args.resumeId)
	const resumed = history.length > 0
	const records: UsageRecord[] = []

	const result = await runLoopTurn({
		engine: args.id,
		model: createLoopModel(args.id, modelName, apiKey),
		modelName,
		prompt: buildEngineUserPrompt({
			prompt: args.prompt, playheadSec: args.playheadSec, selectedItemIds: args.selectedItemIds, widen: args.widen, resuming: resumed
		}),
		systemPrompt: buildEngineSystemPrompt({ maxSteps: args.maxSteps, engineLabel: label, planTool: true, metered: true }),
		history,
		maxSteps: args.maxSteps,
		bridge: { ...rendererBridge, switchRevision: (revisionId) => switchRevisionFor(revisionId, args.turnId) },
		turnId: args.turnId,
		version: app.getVersion(),
		signal: args.signal,
		// The user's "Write custom HTML motion layers" switch, read per call.
		permissions: () => enginePermissions(settingsManager.getAgentAccess().permissions.html),
		probeMotion: probeMotionPage,
		onSteps: args.onSteps,
		onActivity: args.onActivity,
		onUsage: (usage) => records.push({ usage, cost: costOf(args.id, modelName, usage) })
	})

	// A finished turn extends the conversation (or starts one); a failed one leaves it as it was.
	let sessionId = resumed ? args.resumeId : undefined
	if (result.ok) {
		sessionId = sessionId ?? uuidv4()
		await saveConversation(args.dir, sessionId, result.messages)
		// One conversation per project at a time: the ones "New conversation" left behind go.
		await pruneConversations(args.dir, [sessionId])
	}
	return { result, sessionId, records }
}
