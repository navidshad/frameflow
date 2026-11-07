import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { loadConversation, pruneConversations, saveConversation } from './conversation'

const messages = (n: number): ModelMessage[] => [{ role: 'user', content: `request ${n}` }, { role: 'assistant', content: [{ type: 'text', text: `answer ${n}` }] } as ModelMessage]

describe('saved conversations', () => {
	let dir: string
	beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ff-conv-')) })
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('round-trips a conversation', async () => {
		await saveConversation(dir, 'abc-123', messages(1))
		expect(await loadConversation(dir, 'abc-123')).toEqual(messages(1))
	})

	it('a conversation that is gone, damaged or never named is a fresh start', async () => {
		expect(await loadConversation(dir, 'missing')).toEqual([])
		expect(await loadConversation(dir, undefined)).toEqual([])
		writeFileSync(join(dir, 'broken.conversation.json'), '{not json')
		expect(await loadConversation(dir, 'broken')).toEqual([])
	})

	it('cannot be pointed outside its folder by an id', async () => {
		await saveConversation(dir, '../../escape', messages(1))
		expect(readdirSync(dir).every((n) => n.endsWith('.conversation.json'))).toBe(true)
		expect(readdirSync(dir)).toHaveLength(1)
	})

	it('leaves no temporary file behind', async () => {
		await saveConversation(dir, 'one', messages(1))
		expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
	})

	it('prunes every other conversation of the project', async () => {
		await saveConversation(dir, 'keep', messages(1))
		await saveConversation(dir, 'old-1', messages(2))
		await saveConversation(dir, 'old-2', messages(3))
		await pruneConversations(dir, ['keep'])
		expect(readdirSync(dir)).toEqual(['keep.conversation.json'])
		await pruneConversations(join(dir, 'nowhere'), ['x'])
	})
})
