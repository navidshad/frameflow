import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, ipcMain, nativeImage } from 'electron'
import {
	applyRoundEvent, RoundBook, settleStaleRounds, type AgentRound, type RoundEvent
} from '@shared/agentRounds'
import { threadManager } from '../threads'

/**
 * The rounds' home in the app: the one RoundBook every outside agent's call
 * goes through, each project's round history on disk beside its thread.json
 * (`agent-rounds.json`, pictures in `agent-log/`), and the events the editor
 * draws the lock and the chat's MCP conversation from.
 */

const FILE = 'agent-rounds.json'
const IMAGE_DIR = 'agent-log'
/** Pictures in the chat are small; a contact sheet is stored at this width. */
const IMAGE_MAX_WIDTH = 640

interface Stored {
	v: 1
	rounds: AgentRound[]
}

const cache = new Map<string, AgentRound[]>()
const saveTimers = new Map<string, NodeJS.Timeout>()

function threadDir(threadId: string): string | null {
	const thread = threadManager.getThread(threadId)
	return thread?.type === 'editor' ? thread.tempDir : null
}

/** A project's rounds, read once per run. Rounds a previous run left open are closed. */
export function roundsFor(threadId: string): AgentRound[] {
	const cached = cache.get(threadId)
	if (cached) return cached
	let rounds: AgentRound[] = []
	const dir = threadDir(threadId)
	if (dir) {
		try {
			const stored = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf-8')) as Stored
			if (Array.isArray(stored?.rounds)) rounds = stored.rounds
		} catch { /* none yet, or unreadable: start a fresh history */ }
	}
	const live = roundBook.lock()
	rounds = settleStaleRounds(rounds, new Set(live ? [live.roundId] : []))
	cache.set(threadId, rounds)
	return rounds
}

function scheduleSave(threadId: string): void {
	clearTimeout(saveTimers.get(threadId))
	saveTimers.set(threadId, setTimeout(() => {
		saveTimers.delete(threadId)
		const dir = threadDir(threadId)
		const rounds = cache.get(threadId)
		if (!dir || !rounds) return
		try {
			const file = path.join(dir, FILE)
			fs.writeFileSync(`${file}.tmp`, JSON.stringify({ v: 1, rounds } satisfies Stored))
			fs.renameSync(`${file}.tmp`, file)
		} catch (error) {
			console.error('[mcp] could not save the agent rounds:', error)
		}
	}, 500))
}

/** A picture arrives as a data URL; it is kept as a small JPEG in the project and named by path. */
function storeImage(threadId: string, callId: string, dataUrl: string): string | undefined {
	const dir = threadDir(threadId)
	if (!dir) return undefined
	try {
		let image = nativeImage.createFromDataURL(dataUrl)
		if (image.isEmpty()) return undefined
		if (image.getSize().width > IMAGE_MAX_WIDTH) image = image.resize({ width: IMAGE_MAX_WIDTH, quality: 'good' })
		const folder = path.join(dir, IMAGE_DIR)
		fs.mkdirSync(folder, { recursive: true })
		const file = path.join(folder, `${callId.replace(/[^a-z0-9-]/gi, '')}.jpg`)
		fs.writeFileSync(file, image.toJPEG(80))
		return file
	} catch {
		return undefined
	}
}

function broadcast(event: RoundEvent): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) win.webContents.send('agent-rounds-event', event)
	}
}

function onEvent(event: RoundEvent): void {
	if (event.type === 'lock') {
		broadcast(event)
		return
	}
	const threadId = event.type === 'round' ? event.round.threadId : event.threadId
	let out = event
	if (event.type === 'call' && event.call.image?.startsWith('data:')) {
		out = { ...event, call: { ...event.call, image: storeImage(threadId, event.call.id, event.call.image) } }
	}
	cache.set(threadId, applyRoundEvent(roundsFor(threadId), out))
	scheduleSave(threadId)
	broadcast(out)
}

/** The app's one book: every outside agent's server shares it. */
export const roundBook = new RoundBook({
	onEvent: (event) => {
		try {
			onEvent(event)
		} catch (error) {
			console.error('[mcp] round event failed:', error)
		}
	},
	nextSeq: (threadId) => roundsFor(threadId).reduce((n, r) => Math.max(n, r.seq), 0) + 1
})

/**
 * Who holds the project, for the chat: the built-in prompt is refused while an
 * agent's round is open on it.
 */
export function agentHolding(threadId: string): string | null {
	const lock = roundBook.lock()
	if (!lock || lock.threadId !== threadId) return null
	return `${lock.clientName} is working on this project over MCP (round ${lock.seq}${lock.goal ? `: ${lock.goal}` : ''}). The chat unlocks when its round ends.`
}

export function initRoundIpc(options: { disconnect: (sessionId: string) => Promise<boolean> }): void {
	ipcMain.handle('get-agent-rounds', (_event, threadId: string) => ({
		rounds: threadId ? roundsFor(threadId) : [],
		lock: roundBook.lock()
	}))
	// Stop in the editor: the round ends and its agent is disconnected, so the
	// project is the user's again at once.
	ipcMain.handle('stop-agent-round', async () => {
		const lock = roundBook.lock()
		if (!lock) return false
		roundBook.stop()
		await options.disconnect(lock.sessionId)
		return true
	})
}
