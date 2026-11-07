import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import {
	buildEngineSystemPrompt, buildEngineUserPrompt, CLI_ENGINE_IDS, ENGINES, isCliEngine, latestEngineTurn, resumableSessionId, shouldRestartFresh,
	type CliEngineId, type EngineDetection, type EngineSettings
} from '@shared/engines'
import type { PromptTurn, PromptTurnEngine } from '@shared/types'
import { settingsManager } from '../settings'
import { threadManager } from '../threads'
import { emitTurnUpdate, persistTurn } from '../editor/prompt'
import { rendererBridge, switchRevisionFor } from '../mcp/rendererBridge'
import { detectCli, locate, recordRunFailure } from './detect'
import { enginePermissions, runEngineTurn } from './runner'
import { probeMotionPage } from '../motion/probe'
import { hasPromptableContent } from '@shared/tracks'

/**
 * The AI engine, wired to the app: the Settings card and engine chip's IPC,
 * and chat turns run by a CLI engine.
 *
 * A CLI turn is a PromptTurn like a Gemini one, streamed down the same
 * `editor-turn-update`. While it runs it carries the steps; its edits arrive
 * separately as agent turns (via apply_ops) that point back at it; when it
 * ends it carries the revisions they made and the agent's reply.
 */

export interface EngineState {
	settings: EngineSettings
	detections: EngineDetection[]
	detecting: boolean
}

let detections: EngineDetection[] = []
let detecting: Promise<EngineDetection[]> | null = null

function apiDetection(): EngineDetection {
	return settingsManager.getGeminiApiKey()
		? { id: 'gemini-api', status: 'per-token' }
		: { id: 'gemini-api', status: 'no-key', note: 'Add a Gemini API key below.' }
}

function broadcast(channel: string, payload: unknown): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.webContents.send(channel, payload)
	}
}

const state = (): EngineState => ({
	settings: settingsManager.getEngineSettings(),
	detections: [...detections.filter((d) => d.id !== 'gemini-api'), apiDetection()],
	detecting: !!detecting
})

function detectAll(): Promise<EngineDetection[]> {
	if (!detecting) {
		detecting = Promise.all(CLI_ENGINE_IDS.map((id) => detectCli(id).catch((): EngineDetection => ({ id, status: 'missing' }))))
			.then((found) => {
				detections = found
				return found
			})
			.finally(() => {
				detecting = null
				broadcast('engine-state', state())
			})
		broadcast('engine-state', state())
	}
	return detecting
}

// ===== Turns =====

const controllers = new Map<string, AbortController>()

/**
 * The folder a project's CLI conversation runs in. The CLI files a conversation
 * by the folder it ran in, so resuming one needs the same folder every turn:
 * one per project, kept between runs. It holds only the MCP config, which names
 * the token by variable and never contains it.
 */
function sessionDir(threadId: string): string {
	const dir = path.join(app.getPath('userData'), 'engine-sessions', threadId)
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	return dir
}

export function abortEngineTurn(turnId: string): boolean {
	const controller = controllers.get(turnId)
	if (!controller) return false
	controller.abort()
	return true
}

/**
 * "New conversation": the next run starts a fresh CLI conversation. The newest
 * chat turn decides which one continues, so clearing its id is the whole reset.
 * The project, its revisions and the chat stay as they are.
 */
export async function resetEngineConversation(threadId: string): Promise<boolean> {
	const id = settingsManager.getEngineSettings().engine
	if (!isCliEngine(id)) return false
	const thread = threadManager.getThread(threadId)
	const turn = latestEngineTurn(thread?.editor?.turns, id)
	if (!turn?.engine?.sessionId) return false
	const cleared: PromptTurn = { ...turn, engine: { ...turn.engine, sessionId: undefined } }
	await persistTurn(threadId, cleared)
	emitTurnUpdate({ threadId, turn: cleared })
	return true
}

export function cliEngineSelected(): boolean {
	return isCliEngine(settingsManager.getEngineSettings().engine)
}

export function runCliEditorPrompt(options: {
	threadId: string
	prompt: string
	baseStepId: string
	selectedItemIds: string[]
	playheadSec: number
	widen?: 'chapter' | 'full'
	/** Retry names the engine the failed run used, whatever is selected now. */
	engine?: CliEngineId
}): { turnId: string } {
	const settings = settingsManager.getEngineSettings()
	const id = options.engine ?? settings.engine as CliEngineId
	const label = ENGINES[id].label
	const turnId = uuidv4()
	const engine: PromptTurnEngine = {
		id, label, steps: [],
		request: { selectedItemIds: options.selectedItemIds, playheadSec: options.playheadSec, widen: options.widen }
	}
	const turn: PromptTurn = {
		id: turnId,
		prompt: options.prompt,
		baseStepId: options.baseStepId,
		status: 'running',
		createdAt: Date.now(),
		engine
	}
	const controller = new AbortController()
	controllers.set(turnId, controller)

	void (async () => {
		const { threadId } = options
		try {
			const thread = threadManager.getThread(threadId)
			if (!thread || thread.type !== 'editor' || !thread.editor) throw new Error('Not an editor project')
			if (!hasPromptableContent(thread.editor)) throw new Error('Import media or add a layer before prompting')
			await persistTurn(threadId, turn)
			emitTurnUpdate({ threadId, turn })

			const located = await locate(id)
			if (!located) throw new Error(`${label} is not installed, or FrameFlow cannot find it. Pick another engine, or install it and press Detect again in Settings.`)

			// Empty means the CLI's own default: no model flag at all.
			const model = settings.models[id] || undefined
			// Same for effort: unset passes no flag.
			const effort = settings.efforts[id] || undefined
			let latest: PromptTurn = turn
			// The project's earlier conversation with this CLI, so a follow-up has its memory.
			const resumeId = resumableSessionId(thread.editor.turns, id, turnId)
			const workDir = sessionDir(threadId)
			const run = (resumeSessionId?: string) => runEngineTurn({
				engine: id,
				located,
				prompt: buildEngineUserPrompt({ ...options, resuming: !!resumeSessionId }),
				systemPrompt: buildEngineSystemPrompt({ maxSteps: settings.maxSteps, engineLabel: label }),
				model,
				effort,
				workDir,
				keepSession: true,
				resumeSessionId,
				maxSteps: settings.maxSteps,
				// The user's "Write custom HTML motion layers" switch, read per call.
				permissions: () => enginePermissions(settingsManager.getAgentAccess().permissions.html),
				probeMotion: probeMotionPage,
				bridge: { ...rendererBridge, switchRevision: (revisionId) => switchRevisionFor(revisionId, turnId) },
				turnId,
				version: app.getVersion(),
				signal: controller.signal,
				onSteps: (steps, reported) => {
					latest = { ...latest, engine: { ...engine, steps, model: reported } }
					emitTurnUpdate({ threadId, turn: latest })
				},
				// The monitor and media list follow what the engine looks at.
				onActivity: (activity) => broadcast('engine-activity', { ...activity, turnId })
			})
			let result = await run(resumeId)
			let continued = resumeId
			// The CLI may no longer hold that conversation: start a new one rather than fail.
			if (shouldRestartFresh(!!resumeId, result)) {
				result = await run(undefined)
				continued = undefined
			}

			if (result.note) recordRunFailure(id, result.note)
			else if (result.ok) recordRunFailure(id, null)
			if (result.note) void detectAll()

			const commits = result.commits
			const last = commits[commits.length - 1]
			const finalEngine: PromptTurnEngine = {
				...engine,
				steps: result.steps,
				model: result.model,
				sessionId: result.sessionId ?? continued,
				revisionIds: commits.map((c) => c.revisionId),
				finalRevisionId: result.finalRevisionId,
				parentRevisionId: commits[0]?.parentRevisionId ?? null,
				counts: commits.reduce(
					(sum, c) => ({
						added: sum.added + c.counts.added, removed: sum.removed + c.counts.removed,
						updated: sum.updated + c.counts.updated, markers: sum.markers + c.counts.markers
					}),
					{ added: 0, removed: 0, updated: 0, markers: 0 }
				)
			}

			// Edits that landed stay landed: a run stopped half way still shows them.
			if (!result.ok && !commits.length) {
				const end = result.cancelled ? 'cancelled' : 'failed'
				const failed: PromptTurn = { ...turn, status: 'error', error: result.error || `${label} failed`, engine: { ...finalEngine, end } }
				await persistTurn(threadId, failed)
				emitTurnUpdate({ threadId, turn: failed })
				return
			}
			const notes = result.ok ? undefined : [result.cancelled ? 'Stopped before it finished.' : result.error || `${label} did not finish.`]
			const completed: PromptTurn = {
				...turn,
				status: 'completed',
				engine: result.ok ? finalEngine : { ...finalEngine, end: result.cancelled ? 'cancelled' : 'failed' },
				revisionId: result.finalRevisionId ?? last?.revisionId,
				rationale: commits.length ? result.answer || undefined : undefined,
				answer: commits.length ? undefined : result.answer || `${label} finished without changing anything.`,
				notes
			}
			await persistTurn(threadId, completed)
			emitTurnUpdate({ threadId, turn: completed })
		} catch (error: any) {
			const failed: PromptTurn = {
				...turn,
				status: 'error',
				error: controller.signal.aborted ? 'Cancelled' : error?.message || `${label} failed`,
				engine: { ...engine, end: controller.signal.aborted ? 'cancelled' : 'failed' }
			}
			try { await persistTurn(threadId, failed) } catch { /* best effort */ }
			emitTurnUpdate({ threadId, turn: failed })
		} finally {
			controllers.delete(turnId)
		}
	})()

	return { turnId }
}

// ===== IPC =====

export function initEngines(): void {
	ipcMain.handle('get-engines', async () => {
		if (!detections.length) await detectAll()
		return state()
	})

	ipcMain.handle('detect-engines', async () => {
		await detectAll()
		return state()
	})

	ipcMain.handle('set-engine-settings', (_event, patch: Partial<EngineSettings>) => {
		settingsManager.updateEngineSettings(patch || {})
		const next = state()
		broadcast('engine-state', next)
		return next
	})

	app.on('before-quit', () => {
		for (const controller of controllers.values()) controller.abort()
	})
}
