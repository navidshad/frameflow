import { describe, expect, it } from 'vitest'
import {
	applyRoundEvent, chatEntries, elapsedClock, RoundBook, roundStats, settleStaleRounds, summariseAnswer, summariseAsk,
	type AgentCallRecord, type AgentRound, type RoundEvent
} from './agentRounds'

const A = { id: 's-a', clientName: 'Claude Code' }
const B = { id: 's-b', clientName: 'Codex' }

function book(start = 1_000) {
	let now = start
	let n = 0
	const events: RoundEvent[] = []
	const rounds = new RoundBook({ now: () => now, newId: () => `id${n++}`, onEvent: (e) => events.push(e) })
	return { rounds, events, tick: (ms: number) => { now += ms }, at: () => now }
}

const call = (id: string, tool = 'get_project'): AgentCallRecord =>
	({ id, tool, ask: '', title: tool, status: 'running', startedAt: 0 })

describe('RoundBook', () => {
	it('gives the project to one agent at a time', () => {
		const { rounds } = book()
		const first = rounds.begin(A, 'p1', 'Rough cut')
		expect(first.ok).toBe(true)
		expect(rounds.lock()).toMatchObject({ sessionId: 's-a', clientName: 'Claude Code', seq: 1, goal: 'Rough cut', threadId: 'p1' })

		const second = rounds.begin(B, 'p1', 'Titles')
		expect(second.ok).toBe(false)
		if (!second.ok) expect(second.reason).toMatch(/Claude Code is working on this project \(round 1: Rough cut\)/)
		expect(rounds.blockedFor('s-b', 'p1')).toMatch(/One agent at a time/)
		expect(rounds.blockedFor('s-a', 'p1')).toBeNull()

		rounds.end('s-a', 'Cut done')
		expect(rounds.lock()).toBeNull()
		expect(rounds.begin(B, 'p1', 'Titles').ok).toBe(true)
		expect(rounds.lock()?.seq).toBe(2)
	})

	it('hands a retried begin_round the round already open', () => {
		const { rounds } = book()
		const first = rounds.begin(A, 'p1', 'Cut')
		const again = rounds.begin(A, 'p1', 'Cut')
		expect(again.ok && again.already).toBe(true)
		expect(again.ok && first.ok && again.round.id === first.round.id).toBe(true)
	})

	it('refuses a write when the editor moved to another project under the round', () => {
		const { rounds } = book()
		rounds.begin(A, 'p1', 'Cut')
		expect(rounds.blockedFor('s-a', 'p2')).toMatch(/different project/)
	})

	it('ends the round when the agent disconnects, stops, or goes quiet', () => {
		const { rounds, tick } = book()
		rounds.begin(A, 'p1', 'Cut')
		rounds.sessionClosed('s-a')
		expect(rounds.lock()).toBeNull()

		rounds.begin(A, 'p1', 'Again')
		expect(rounds.stop()?.status).toBe('stopped')
		expect(rounds.lock()).toBeNull()

		rounds.begin(A, 'p1', 'Third')
		tick(5 * 60_000)
		expect(rounds.sweep(10 * 60_000)).toHaveLength(0)
		tick(6 * 60_000)
		const ended = rounds.sweep(10 * 60_000)
		expect(ended.map((r) => r.status)).toEqual(['timed-out'])
		expect(rounds.lock()).toBeNull()
	})

	it('keeps a round alive while the agent keeps calling', () => {
		const { rounds, tick } = book()
		rounds.begin(A, 'p1', 'Cut')
		for (let i = 0; i < 5; i++) {
			tick(4 * 60_000)
			rounds.callStarted(A, 'p1', call(`c${i}`))
		}
		expect(rounds.sweep(10 * 60_000)).toHaveLength(0)
		expect(rounds.lock()?.steps).toBe(5)
	})

	it('groups calls outside a round, and closes the group when a round begins', () => {
		const { rounds, events } = book()
		expect(rounds.callStarted(A, null, call('c0', 'list_projects'))).toBeNull()
		const loose = rounds.callStarted(A, 'p1', call('c1'))!
		expect(loose.kind).toBe('loose')
		expect(rounds.callStarted(A, 'p1', call('c2'))!.id).toBe(loose.id)
		rounds.begin(A, 'p1', 'Cut')
		const closed = events.filter((e) => e.type === 'round' && e.round.id === loose.id).at(-1)
		expect(closed?.type === 'round' && closed.round.status).toBe('done')
		const inRound = rounds.callStarted(A, 'p1', call('c3'))!
		expect(inRound.kind).toBe('round')
	})

	it('still records the answer of a call that finishes after its round ended', () => {
		const { rounds, events } = book()
		const begun = rounds.begin(A, 'p1', 'Cut')
		const round = rounds.callStarted(A, 'p1', call('c1', 'apply_ops'))!
		rounds.sessionClosed('s-a')
		rounds.callFinished(round.id, 'c1', { status: 'done', answer: 'V3' })
		const last = events.filter((e) => e.type === 'call').at(-1)
		expect(last).toMatchObject({ type: 'call', roundId: begun.ok ? begun.round.id : '', call: { id: 'c1', status: 'done', answer: 'V3' } })
	})

	it('lets the same agent take its round back after reconnecting, with the round id', () => {
		const { rounds } = book()
		const begun = rounds.begin(A, 'p1', 'Cut')
		const again = { id: 's-a2', clientName: 'Claude Code' }
		expect(rounds.blockedFor(again.id, 'p1')).toMatch(/One agent at a time/)
		expect(rounds.resume(again, 'nope').ok).toBe(false)
		const resumed = rounds.resume(again, begun.ok ? begun.round.id : '')
		expect(resumed.ok).toBe(true)
		expect(rounds.lock()?.sessionId).toBe('s-a2')
		expect(rounds.blockedFor(again.id, 'p1')).toBeNull()
		// The old session's connection closing later does not end the round any more.
		rounds.sessionClosed('s-a')
		expect(rounds.lock()?.sessionId).toBe('s-a2')
	})

	it('numbers rounds after what is already on disk', () => {
		const rounds = new RoundBook({ nextSeq: () => 7 })
		const begun = rounds.begin(A, 'p1', 'x')
		expect(begun.ok && begun.round.seq).toBe(7)
	})
})

describe('applyRoundEvent', () => {
	it('builds the same history main stores and the chat shows', () => {
		const { rounds, events } = book()
		rounds.callStarted(A, 'p1', call('c0'))
		const begun = rounds.begin(A, 'p1', 'Cut')
		const r = rounds.callStarted(A, 'p1', call('c1', 'apply_ops'))!
		rounds.callFinished(r.id, 'c1', { status: 'done', answer: '{"revision":"V2"}', chips: [{ text: 'V2', tone: 'violet' }] })
		rounds.end('s-a', 'Done')

		let history: AgentRound[] = []
		for (const event of events) history = applyRoundEvent(history, event)
		expect(history.map((h) => [h.kind, h.status, h.calls.length])).toEqual([['loose', 'done', 1], ['round', 'done', 1]])
		const round = history[1]
		expect(round.id).toBe(begun.ok ? begun.round.id : '')
		expect(round.summary).toBe('Done')
		expect(round.calls[0]).toMatchObject({ status: 'done', answer: '{"revision":"V2"}' })
		expect(roundStats(round)).toMatchObject({ steps: 1, edits: 1, errors: 0, firstRevision: 'V2', lastRevision: 'V2' })
	})

	it('marks rounds a previous run left open as ended', () => {
		const open: AgentRound = { id: 'r', threadId: 'p', sessionId: 's', clientName: 'x', kind: 'round', seq: 1, status: 'working', startedAt: 5, calls: [] }
		expect(settleStaleRounds([open], new Set())[0]).toMatchObject({ status: 'disconnected', endedAt: 5 })
		expect(settleStaleRounds([open], new Set(['r']))[0].status).toBe('working')
	})
})

describe('summaries', () => {
	it('shows page sources by size and cuts long text', () => {
		const ask = summariseAsk({ addMotion: [{ template: 'custom', html: 'x'.repeat(20_000), atSec: 3 }], rationale: 'y'.repeat(400) })
		expect(ask).toContain('‹page 20 KB›')
		expect(ask).not.toContain('xxxx')
		expect(ask.length).toBeLessThanOrEqual(700)
		expect(summariseAsk({})).toBe('')
	})

	it('joins text answers and counts pictures', () => {
		expect(summariseAnswer([{ type: 'image', data: 'x' }, { type: 'text', text: 'Frame at\n0:03' }])).toBe('Frame at 0:03 · ‹1 image›')
	})

	it('elapsed clock', () => {
		expect(elapsedClock(61_000)).toBe('1:01')
		expect(elapsedClock(3_725_000)).toBe('1:02:05')
	})
})

describe('chatEntries', () => {
	it('puts rounds between turns and drops the turns a round already shows', () => {
		const turns = [
			{ id: 't1', createdAt: 10 },
			{ id: 't2', createdAt: 30, agent: { sessionId: 's-a' } },
			{ id: 't3', createdAt: 40, agent: { sessionId: 'engine', engineTurnId: 't1' } }
		]
		const round: AgentRound = { id: 'r', threadId: 'p', sessionId: 's-a', clientName: 'x', kind: 'round', seq: 1, status: 'done', startedAt: 20, calls: [] }
		expect(chatEntries(turns, [round]).map((e) => (e.kind === 'turn' ? e.turn.id : e.round.id))).toEqual(['t1', 'r'])
	})
})
