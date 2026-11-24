import { describe, expect, it } from 'vitest'
import type { MediaAsset } from '../../shared/types'
import type { GenerateRequest } from '../../shared/audioProviders'
import type { AudioProposal } from '../../shared/audioProposals'
import { createProposalBook } from './proposals'

const speech: GenerateRequest = { provider: 'elevenlabs', capability: 'speech', prompt: 'Welcome back.', voice: 'v1' }
const music: GenerateRequest = { provider: 'elevenlabs', capability: 'music', prompt: 'calm piano', durationSec: 10 }

/** A book over a fake provider: it records what it made and every state the card was shown in. */
function setup(fail: (req: GenerateRequest) => string | null = () => null) {
	const shown: AudioProposal[] = []
	const made: GenerateRequest[] = []
	const remembered: string[] = []
	const book = createProposalBook({
		publish: (p) => { shown.push(p) },
		async generate(_threadId, req) {
			const why = fail(req)
			if (why) throw new Error(why)
			made.push(req)
			const asset = { id: `gen-${made.length}`, name: `${req.capability} ${made.length}`, metadata: { duration: 2.5 } } as MediaAsset
			return { asset, provenance: { provider: req.provider, capability: req.capability, prompt: req.prompt, model: req.model ?? 'm', costUsd: null, credits: 12, madeAt: 0 } }
		},
		catalog: async () => null,
		rememberAuto: (threadId) => { remembered.push(threadId) },
		now: () => 1000
	})
	const open = () => book.open({ threadId: 't1', agent: 'Claude Code', items: [{ request: speech, purpose: 'Intro' }, { request: music }] })
	return { book, shown, made, remembered, open }
}

describe('the proposal book', () => {
	it('shows a new proposal at once, open', () => {
		const { shown, open } = setup()
		const p = open()
		expect(p).toMatchObject({ status: 'open', createdAt: 1000, agent: 'Claude Code' })
		expect(p.id).toMatch(/^prop-/)
		expect(shown).toEqual([p])
	})

	it('makes each item as answered, showing every step, and says what each made', async () => {
		const { book, shown, made, open } = setup()
		const p = open()
		const edited = { ...speech, prompt: 'Welcome back, everyone.' }
		const done = await book.answer(p.id, { action: 'make', chosenBy: 'person', items: [edited, music] })
		expect(made).toEqual([edited, music])
		expect(done.status).toBe('made')
		expect(done.items[0]).toMatchObject({ purpose: 'Intro', request: edited, result: { assetId: 'gen-1', lengthSec: 2.5, credits: 12 } })
		expect(shown.map((s) => s.status)).toEqual(['open', 'making', 'making', 'making', 'made'])
		// The first item is shown made while the second is still being made.
		expect(shown[2].items[0].result).toBeDefined()
		expect(shown[2].items[1].result).toBeUndefined()
	})

	it('keeps what was made when a later item fails, and fails only when nothing was made', async () => {
		const half = setup((req) => (req.capability === 'music' ? 'ElevenLabs refused this on your plan.' : null))
		const p = half.open()
		const done = await half.book.answer(p.id, { action: 'make', chosenBy: 'person', items: [speech, music] })
		expect(done.status).toBe('made')
		expect(done.items[1].error).toMatch(/refused/)

		const none = setup(() => 'out of credits')
		const q = none.open()
		expect((await none.book.answer(q.id, { action: 'make', chosenBy: 'person', items: [speech, music] })).status).toBe('failed')
	})

	it('wakes a waiting assistant once it is settled, and a later answer is marked late', async () => {
		const { book, open } = setup()
		const p = open()
		const waiting = book.wait(p.id, 5000)
		await book.answer(p.id, { action: 'make', chosenBy: 'assistant', items: [speech, music] })
		const settled = await waiting
		expect(settled).toMatchObject({ status: 'made', chosenBy: 'assistant', late: false })

		const q = open()
		expect((await book.wait(q.id, 10))!.status).toBe('open')
		const late = await book.answer(q.id, { action: 'decline', note: 'No.' })
		expect(late).toMatchObject({ status: 'declined', late: true, note: 'No.' })
	})

	it('ticks while it waits, so a client hears it is still alive', async () => {
		const { book, open } = setup()
		const p = open()
		const ticks: number[] = []
		await book.wait(p.id, 1100, (ms) => ticks.push(ms))
		expect(ticks.length).toBeGreaterThanOrEqual(1)
	})

	it('remembers "Don’t ask again" for the project', async () => {
		const { book, remembered, open } = setup()
		const p = open()
		await book.answer(p.id, { action: 'make', chosenBy: 'person', items: [speech, music], remember: true })
		expect(remembered).toEqual(['t1'])
	})

	it('refuses a second answer, an answer that does not match, and a proposal it does not know', async () => {
		const { book, made, open } = setup()
		const p = open()
		await expect(book.answer(p.id, { action: 'make', chosenBy: 'person', items: [speech] })).rejects.toThrow(/does not match/)
		await expect(book.answer(p.id, { action: 'make', chosenBy: 'person', items: [music, speech] })).rejects.toThrow(/does not match/)
		await book.answer(p.id, { action: 'decline' })
		await expect(book.answer(p.id, { action: 'make', chosenBy: 'person', items: [speech, music] })).rejects.toThrow(/already answered/)
		await expect(book.answer('prop-gone', { action: 'decline' })).rejects.toThrow(/gone/)
		expect(made).toEqual([])
	})

	it('marks one made under Auto as such, never late', async () => {
		const { book, open } = setup()
		const p = open()
		const done = await book.answer(p.id, { action: 'make', chosenBy: 'assistant', items: [speech, music] }, { auto: true })
		expect(done).toMatchObject({ auto: true, late: false })
	})
})
