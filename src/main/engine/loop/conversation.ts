import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { compactMessages, STORAGE_COMPACT, trimHistory } from './compaction'

/**
 * A loop engine's conversation with one project, kept between chat turns so a
 * follow-up ("make that shorter") has the earlier messages, as a resumed CLI
 * session does. One file per conversation, named by the id the chat turn
 * carries; "New conversation" simply stops pointing at it.
 *
 * What is saved is what the next turn would be sent anyway: the messages, with
 * old big results and every picture cleared (the model can look again), and cut
 * to the newest whole turns when it still grows past `MAX_SAVED_CHARS`.
 */

export const MAX_SAVED_CHARS = 600_000

const file = (dir: string, sessionId: string) => join(dir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '')}.conversation.json`)

export async function loadConversation(dir: string, sessionId: string | undefined): Promise<ModelMessage[]> {
	if (!sessionId) return []
	try {
		const parsed = JSON.parse(await readFile(file(dir, sessionId), 'utf8'))
		return Array.isArray(parsed) ? (parsed as ModelMessage[]) : []
	} catch {
		// Gone or unreadable: a fresh conversation, which is always a valid start.
		return []
	}
}

export async function saveConversation(dir: string, sessionId: string, messages: ModelMessage[]): Promise<void> {
	const saved = trimHistory(compactMessages(messages, STORAGE_COMPACT), MAX_SAVED_CHARS)
	await mkdir(dir, { recursive: true, mode: 0o700 })
	const target = file(dir, sessionId)
	// Written beside and renamed over, so a crash never leaves half a conversation.
	const temp = `${target}.${process.pid}.tmp`
	await writeFile(temp, JSON.stringify(saved), { mode: 0o600 })
	await rename(temp, target)
}

/** Deletes every saved conversation of this project except the ones to keep. */
export async function pruneConversations(dir: string, keep: string[]): Promise<void> {
	const wanted = new Set(keep.filter(Boolean).map((id) => file(dir, id)))
	let names: string[] = []
	try { names = await readdir(dir) } catch { return }
	await Promise.all(names
		.filter((name) => name.endsWith('.conversation.json'))
		.map((name) => join(dir, name))
		.filter((path) => !wanted.has(path))
		.map((path) => rm(path, { force: true })))
}
