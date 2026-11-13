import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import {
	buildEngineSystemPrompt, buildEngineUserPrompt, CLI_ENGINE_IDS, ENGINES, isCliEngine, latestEngineTurn, resumableSessionId, shouldRestartFresh,
	type EngineDetection, type EngineId, type EngineSettings
} from '@shared/engines'
import type { PromptAttachmentInput, PromptTurn, PromptTurnEngine, Usage, UsageRecord } from '@shared/types'
import { describeReferences } from '@shared/promptRefs'
import { storeAttachments } from './attachments'
import { settingsManager } from '../settings'
import { threadManager } from '../threads'
import { emitTurnUpdate, persistTurn } from '../editor/prompt'
import { rendererBridge, switchRevisionFor } from '../mcp/rendererBridge'
import { detectCli, locate, recordRunFailure } from './detect'
import { enginePermissions, runEngineTurn, type EngineRunResult } from './runner'
import { runLoopEngineTurn } from './loopEngine'
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
 * "New conversation": the next run starts a fresh conversation, a CLI's or the
 * loop's own. The newest
 * chat turn decides which one continues, so clearing its id is the whole reset.
 * The project, its revisions and the chat stay as they are.
 */
export async function resetEngineConversation(threadId: string): Promise<boolean> {
	const id = settingsManager.getEngineSettings().engine
	const thread = threadManager.getThread(threadId)
	const turn = latestEngineTurn(thread?.editor?.turns, id)
	if (!turn?.engine?.sessionId) return false
	const cleared: PromptTurn = { ...turn, engine: { ...turn.engine, sessionId: undefined } }
	await persistTurn(threadId, cleared)
	emitTurnUpdate({ threadId, turn: cleared })
	return true
}

/**
 * A chat turn run by the selected engine: a CLI spawned against FrameFlow's MCP
 * server, or the loop running inside FrameFlow against the same server.
 */
export function runEnginePrompt(options: {
	threadId: string
	prompt: string
	baseStepId: string
	selectedItemIds: string[]
	playheadSec: number
	widen?: 'chapter' | 'full'
	/** Retry names the engine the failed run used, whatever is selected now. */
	engine?: EngineId
	/** Frames attached to the message: pictures from the composer, or (Retry) the files a turn kept. */
	attachments?: PromptAttachmentInput[]
}): { turnId: string } {
	const settings = settingsManager.getEngineSettings()
	const id: EngineId = options.engine ?? settings.engine
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
			// The composer will not send pictures to an engine that cannot see them;
			// if one gets here anyway it is refused, never sent without them.
			if (options.attachments?.length && !ENGINES[id].images) throw new Error(`${label} cannot be sent pictures. Remove the attached frames, or pick another engine.`)
			const stored = await storeAttachments(thread.tempDir, turnId, options.attachments)
			if (stored.attachments.length) turn.attachments = stored.attachments
			// What each @time and frame is, against the project as it is now.
			const references = describeReferences(options.prompt, stored.attachments, {
				timeline: thread.editor.timeline, tracks: thread.editor.tracks, media: thread.editor.media, markers: thread.editor.markers
			}) || undefined
			const images = stored.images.length ? stored.images : undefined
			await persistTurn(threadId, turn)
			emitTurnUpdate({ threadId, turn })

			let latest: PromptTurn = turn
			const onSteps = (steps: PromptTurnEngine['steps'], reported?: string) => {
				latest = { ...latest, engine: { ...engine, steps, model: reported } }
				emitTurnUpdate({ threadId, turn: latest })
			}
			// The monitor and media list follow what the engine looks at.
			const onActivity = (activity: Parameters<typeof broadcast>[1]) => broadcast('engine-activity', { ...(activity as object), turnId })
			// The project's earlier conversation with this engine, so a follow-up has its memory.
			const resumeId = resumableSessionId(thread.editor.turns, id, turnId)
			const dir = sessionDir(threadId)

			let result: EngineRunResult
			let continued: string | undefined
			let spend: { usage: Usage; records: UsageRecord[] } | undefined

			if (isCliEngine(id)) {
				const located = await locate(id)
				if (!located) throw new Error(`${label} is not installed, or FrameFlow cannot find it. Pick another engine, or install it and press Detect again in Settings.`)

				// Empty means the CLI's own default: no model flag at all.
				const model = settings.models[id] || undefined
				// Same for effort: unset passes no flag.
				const effort = settings.efforts[id] || undefined
				const run = (resumeSessionId?: string) => runEngineTurn({
					engine: id,
					located,
					prompt: buildEngineUserPrompt({ ...options, resuming: !!resumeSessionId, references }),
					images,
					systemPrompt: buildEngineSystemPrompt({ maxSteps: settings.maxSteps, engineLabel: label }),
					model,
					effort,
					workDir: dir,
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
					onSteps,
					onActivity
				})
				let cli = await run(resumeId)
				continued = resumeId
				// The CLI may no longer hold that conversation: start a new one rather than fail.
				if (shouldRestartFresh(!!resumeId, cli)) {
					cli = await run(undefined)
					continued = undefined
				}
				result = cli
				continued = cli.sessionId ?? continued

				if (cli.note) recordRunFailure(id, cli.note)
				else if (cli.ok) recordRunFailure(id, null)
				if (cli.note) void detectAll()
			} else {
				const looped = await runLoopEngineTurn({
					id, turnId, prompt: options.prompt, references, images, playheadSec: options.playheadSec, selectedItemIds: options.selectedItemIds,
					widen: options.widen, maxSteps: settings.maxSteps, resumeId, dir, signal: controller.signal, onSteps, onActivity
				})
				result = looped.result
				continued = looped.sessionId
				spend = { usage: looped.result.usage, records: looped.records }
			}

			// Spend is recorded for every model call, even one that failed or was stopped.
			if (spend?.records.length) {
				const records = spend.records.map((r) => ({ ...r, timestamp: Date.now() }))
				void threadManager.updateThreadWith(threadId, (t) => ({ usageHistory: [...(t.usageHistory || []), ...records] }))
			}
			const cost = spend ? spend.records.reduce((sum, r) => sum + r.cost, 0) : undefined

			const commits = result.commits
			const last = commits[commits.length - 1]
			const finalEngine: PromptTurnEngine = {
				...engine,
				steps: result.steps,
				model: result.model,
				sessionId: continued,
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
				const failed: PromptTurn = { ...turn, status: 'error', error: result.error || `${label} failed`, engine: { ...finalEngine, end }, usage: spend?.usage, cost }
				await persistTurn(threadId, failed)
				emitTurnUpdate({ threadId, turn: failed })
				return
			}
			const loopNotes = (result as { notes?: string[] }).notes ?? []
			const ended = result.ok ? [] : [result.cancelled ? 'Stopped before it finished.' : result.error || `${label} did not finish.`]
			const notes = [...ended, ...loopNotes].length ? [...ended, ...loopNotes] : undefined
			const completed: PromptTurn = {
				...turn,
				status: 'completed',
				engine: result.ok ? finalEngine : { ...finalEngine, end: result.cancelled ? 'cancelled' : 'failed' },
				revisionId: result.finalRevisionId ?? last?.revisionId,
				rationale: commits.length ? result.answer || undefined : undefined,
				answer: commits.length ? undefined : result.answer || `${label} finished without changing anything.`,
				notes,
				usage: spend?.usage,
				cost
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
