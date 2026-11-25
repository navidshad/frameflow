import { describe, expect, it } from 'vitest'
import { cleanVersionName, requestKeyOf, requestRevisionLabel, rewritesRequestRevision, VERSION_NAME_MAX } from './requestRevision'

describe('which request an edit belongs to', () => {
	it('is the outside agent’s round, else the assistant’s chat turn, else none', () => {
		expect(requestKeyOf({ agent: { name: 'Claude Code', sessionId: 's' } }, 'round-1')).toBe('round-1')
		expect(requestKeyOf({ agent: { name: 'The assistant', sessionId: 's', engineTurnId: 'turn-9' } }, null)).toBe('turn-9')
		expect(requestKeyOf({ agent: { name: 'Claude Code', sessionId: 's' } }, null)).toBeUndefined()
		expect(requestKeyOf({}, undefined)).toBeUndefined()
	})
})

describe('one revision per request', () => {
	const kept = { id: 'r5', parentId: 'r4' }

	it('rewrites the request’s revision while it is the one being worked on', () => {
		expect(rewritesRequestRevision(kept, 'r5')).toBe(true)
	})

	it('rewrites it too when the agent went back to where the request started and tries again', () => {
		expect(rewritesRequestRevision(kept, 'r4')).toBe(true)
	})

	it('adds a revision when the agent switched to another version on purpose, or the request has none yet', () => {
		expect(rewritesRequestRevision(kept, 'r2')).toBe(false)
		expect(rewritesRequestRevision(undefined, 'r5')).toBe(false)
		expect(rewritesRequestRevision(kept, null)).toBe(false)
	})
})

describe('the revision’s name', () => {
	it('is the agent’s name for it, on one line and not too long', () => {
		expect(cleanVersionName('  Tighter intro,\n music under ')).toBe('Tighter intro, music under')
		expect(cleanVersionName('x'.repeat(200))!.length).toBe(VERSION_NAME_MAX)
		expect(cleanVersionName('   ')).toBeUndefined()
		expect(cleanVersionName(42)).toBeUndefined()
	})

	it('falls back to who made it, with the round’s goal', () => {
		expect(requestRevisionLabel({ name: 'Tighter intro', agent: 'Claude Code' })).toBe('Tighter intro')
		expect(requestRevisionLabel({ agent: 'Claude Code', goal: 'cut the pauses' })).toBe('Claude Code: cut the pauses')
		expect(requestRevisionLabel({ agent: 'The assistant' })).toBe('The assistant')
		expect(requestRevisionLabel({})).toBe('AI edit')
	})
})
