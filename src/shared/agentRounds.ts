import type { AgentActivityStatus, AgentChip } from './agentFeed'

/**
 * Agent rounds: who may edit a project right now, and the record of what an
 * outside agent asked FrameFlow over MCP and what FrameFlow answered.
 *
 * One agent per project. An MCP agent marks the start and end of each working
 * round (begin_round / end_round); while a round is open it holds the project,
 * the built-in chat is locked and the editor shows that someone is working.
 * FrameFlow's own chat holds it the other way: an agent cannot start a round
 * while a chat prompt is running.
 *
 * Pure, so the server, the persistence in main and the chat panel all apply
 * the same rules and the same events, and all of it is testable without
 * Electron.
 */

// ===== Wire types =====

export type RoundStatus =
	/** Open: the agent holds the project. */
	| 'working'
	/** The agent called end_round. */
	| 'done'
	/** Its connection closed with the round still open. */
	| 'disconnected'
	/** It went quiet for longer than a round may idle. */
	| 'timed-out'
	/** The user stopped it from the editor. */
	| 'stopped'
	/** It opened another project, which ends a round on this one. */
	| 'left'

/** One tool call, as the chat shows it: the agent's request and FrameFlow's answer. */
export interface AgentCallRecord {
	id: string
	tool: string
	/** What the agent asked: its arguments, with page sources and long text cut down. */
	ask: string
	/** Tool name plus its key argument: "render_frame 0:27.5". */
	title: string
	status: AgentActivityStatus
	/** What FrameFlow answered, shortened. */
	answer?: string
	detail?: string
	quote?: string
	chips?: AgentChip[]
	/**
	 * A picture the answer carried (render_frame, inspect_export). A data URL on
	 * the wire from the server; a file path once main has stored it.
	 */
	image?: string
	startedAt: number
	endedAt?: number
}

export interface AgentRound {
	id: string
	threadId: string
	sessionId: string
	clientName: string
	/**
	 * 'round': opened with begin_round (or by FrameFlow when the agent edited
	 * without one). 'loose': calls the agent made outside any round, grouped so
	 * the chat can still show them.
	 */
	kind: 'round' | 'loose'
	/** 1, 2, 3… per project, for rounds; 0 for loose groups. */
	seq: number
	goal?: string
	/** FrameFlow opened it because the agent wrote without begin_round. */
	implicit?: boolean
	summary?: string
	/** A loose group is 'working' while its session is, then 'done'. */
	status: RoundStatus
	startedAt: number
	endedAt?: number
	calls: AgentCallRecord[]
}

/** Who holds the project. Null when nobody does (the chat may run, an agent may begin). */
export interface AgentLock {
	threadId: string
	roundId: string
	sessionId: string
	clientName: string
	seq: number
	goal?: string
	startedAt: number
	lastCallAt: number
	steps: number
}

/** What main sends the renderer as rounds change. Applied with `applyRoundEvent`. */
export type RoundEvent =
	| { type: 'round'; round: Omit<AgentRound, 'calls'> }
	| { type: 'call'; threadId: string; roundId: string; call: AgentCallRecord }
	| { type: 'lock'; lock: AgentLock | null }

// ===== What the agent asked, what FrameFlow answered =====

const ASK_MAX = 700
const ANSWER_MAX = 900
const STRING_MAX = 160

const kb = (chars: number) => `${(chars / 1024).toFixed(chars < 10_240 ? 1 : 0)} KB`

/**
 * An agent's arguments, short enough to read in a chat bubble: page sources
 * and kit CSS become their size, other long strings are cut, and the whole is
 * capped. Never throws: a request that cannot be summarised is still shown.
 */
export function summariseAsk(args: Record<string, unknown> | undefined): string {
	if (!args || !Object.keys(args).length) return ''
	try {
		const text = JSON.stringify(args, (key, value) => {
			if (typeof value !== 'string') return value
			if (key === 'html') return `‹page ${kb(value.length)}›`
			if (key === 'css' || key === 'js') return `‹${key} ${kb(value.length)}›`
			if (value.length > STRING_MAX) return `${value.slice(0, STRING_MAX - 1)}…`
			return value
		})
		return text.length > ASK_MAX ? `${text.slice(0, ASK_MAX - 1)}…` : text
	} catch {
		return '‹arguments could not be shown›'
	}
}

type Content = { type: string; text?: string; data?: string; mimeType?: string }

/**
 * FrameFlow's reply, as text for the chat: every text part joined with
 * whitespace collapsed, pictures counted (the first one travels separately as
 * the call's image), and the whole capped.
 */
export function summariseAnswer(content: Content[] | undefined): string {
	if (!content?.length) return ''
	const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text!.replace(/\s+/g, ' ').trim())
	const images = content.filter((c) => c.type === 'image').length
	const joined = [...texts, images ? `‹${images} image${images === 1 ? '' : 's'}›` : ''].filter(Boolean).join(' · ')
	return joined.length > ANSWER_MAX ? `${joined.slice(0, ANSWER_MAX - 1)}…` : joined
}

// ===== The round book =====

export interface SessionRef {
	id: string
	clientName: string
}

export type BeginResult =
	| { ok: true; round: AgentRound; already: boolean }
	| { ok: false; reason: string; holder?: AgentLock }

export interface RoundBookOptions {
	now?: () => number
	newId?: () => string
	/** The next round number for a project (main counts what is on disk). */
	nextSeq?: (threadId: string) => number
	onEvent?: (event: RoundEvent) => void
}

/** A round with no tool call for this long ends on its own: nobody is holding the project any more. */
export const ROUND_IDLE_MS = 10 * 60_000

const describeHolder = (lock: AgentLock) =>
	`${lock.clientName} is working on this project (round ${lock.seq}${lock.goal ? `: ${lock.goal}` : ''})`

/**
 * Rounds and the lock, in memory. The lock is app-wide: FrameFlow has one
 * editor, so whoever holds it holds the project that editor shows; the
 * project is recorded so a write can be refused when the editor has since
 * moved to another one.
 */
export class RoundBook {
	private readonly now: () => number
	private readonly newId: () => string
	private readonly nextSeq: (threadId: string) => number
	private readonly onEvent?: (event: RoundEvent) => void
	/** Every round still open (working rounds and loose groups), by id. */
	private open = new Map<string, AgentRound>()
	/** Rounds that ended with a call still running, so its answer still lands. */
	private closing = new Map<string, AgentRound>()
	/** session → its open round / its open loose group. */
	private roundOf = new Map<string, string>()
	private looseOf = new Map<string, string>()
	private seqs = new Map<string, number>()
	private holder: AgentLock | null = null

	constructor(options: RoundBookOptions = {}) {
		this.now = options.now ?? Date.now
		let n = 0
		this.newId = options.newId ?? (() => `round-${Date.now().toString(36)}-${(n++).toString(36)}`)
		this.nextSeq = options.nextSeq ?? ((threadId) => (this.seqs.get(threadId) ?? 0) + 1)
		this.onEvent = options.onEvent
	}

	lock(): AgentLock | null {
		return this.holder ? { ...this.holder } : null
	}

	/** The round this session has open, if any. */
	roundFor(sessionId: string): AgentRound | null {
		const id = this.roundOf.get(sessionId)
		return id ? this.open.get(id) ?? null : null
	}

	/**
	 * Why this session may not change the project now, or null when it may.
	 * Another agent's round blocks it; so does its own round on a project the
	 * editor no longer shows.
	 */
	blockedFor(sessionId: string, threadId: string | null): string | null {
		const lock = this.holder
		if (lock && lock.sessionId !== sessionId) {
			return `${describeHolder(lock)}. One agent at a time: wait until it ends its round, then begin your own.`
		}
		if (lock && threadId && lock.threadId !== threadId) {
			return 'The editor now shows a different project from the one your round is on (the user switched). ' +
				'Call end_round, then open_project the one you mean to edit and begin_round again.'
		}
		return null
	}

	/**
	 * Open a round for this session on this project. A session that already
	 * has one gets it back (`already`), so a retried begin_round is harmless.
	 * Refused while another agent holds the project.
	 */
	begin(session: SessionRef, threadId: string, goal: string | undefined, options: { implicit?: boolean } = {}): BeginResult {
		const mine = this.roundFor(session.id)
		if (mine) {
			if (mine.threadId === threadId) return { ok: true, round: mine, already: true }
			this.finish(mine, 'left', 'Moved to another project.')
		}
		if (this.holder && this.holder.sessionId !== session.id) {
			return { ok: false, reason: `${describeHolder(this.holder)}. One agent at a time: try again when it ends its round.`, holder: this.lock()! }
		}
		this.closeLoose(session.id)
		const seq = Math.max(this.nextSeq(threadId), (this.seqs.get(threadId) ?? 0) + 1)
		this.seqs.set(threadId, seq)
		const now = this.now()
		const round: AgentRound = {
			id: this.newId(), threadId, sessionId: session.id, clientName: session.clientName,
			kind: 'round', seq, goal: cleanText(goal, 200), implicit: options.implicit || undefined,
			status: 'working', startedAt: now, calls: []
		}
		this.open.set(round.id, round)
		this.roundOf.set(session.id, round.id)
		this.holder = {
			threadId, roundId: round.id, sessionId: session.id, clientName: session.clientName,
			seq, goal: round.goal, startedAt: now, lastCallAt: now, steps: 0
		}
		this.emitRound(round)
		this.emitLock()
		return { ok: true, round, already: false }
	}

	/** End this session's round. Returns it, or null when it had none open. */
	end(sessionId: string, summary?: string, status: Exclude<RoundStatus, 'working'> = 'done'): AgentRound | null {
		const round = this.roundFor(sessionId)
		if (!round) return null
		this.finish(round, status, summary)
		return round
	}

	/**
	 * A tool call began. It joins the session's round, or its loose group
	 * (opened here) when there is no round. A call before the agent has seen any
	 * project has nowhere to go: it shows only in the Agent tab.
	 */
	callStarted(session: SessionRef, threadId: string | null, call: AgentCallRecord): AgentRound | null {
		let round = this.roundFor(session.id)
		if (!round) {
			if (!threadId) return null
			const looseId = this.looseOf.get(session.id)
			round = looseId ? this.open.get(looseId) ?? null : null
			if (round && round.threadId !== threadId) {
				this.finish(round, 'done')
				round = null
			}
			if (!round) {
				round = {
					id: this.newId(), threadId, sessionId: session.id, clientName: session.clientName,
					kind: 'loose', seq: 0, status: 'working', startedAt: this.now(), calls: []
				}
				this.open.set(round.id, round)
				this.looseOf.set(session.id, round.id)
				this.emitRound(round)
			}
		}
		round.calls.push(call)
		if (this.holder && this.holder.roundId === round.id) {
			this.holder.steps++
			this.holder.lastCallAt = this.now()
			this.emitLock()
		}
		this.onEvent?.({ type: 'call', threadId: round.threadId, roundId: round.id, call: { ...call } })
		return round
	}

	/** The call finished: its answer, status and any picture. */
	callFinished(roundId: string, callId: string, patch: Partial<AgentCallRecord>): void {
		const round = this.open.get(roundId) ?? this.closing.get(roundId)
		const call = round?.calls.find((c) => c.id === callId)
		if (!round || !call) return
		Object.assign(call, patch, { endedAt: patch.endedAt ?? this.now() })
		if (call.status === 'running') call.status = 'done'
		this.onEvent?.({ type: 'call', threadId: round.threadId, roundId: round.id, call: { ...call } })
		// A call does not stay in memory once it is told: main keeps the record.
		round.calls = round.calls.filter((c) => c.status === 'running')
		if (!round.calls.length) this.closing.delete(round.id)
	}

	/** The session's connection closed: its round ends, its loose group closes. */
	sessionClosed(sessionId: string): void {
		const round = this.roundFor(sessionId)
		if (round) this.finish(round, 'disconnected')
		this.closeLoose(sessionId)
	}

	/** The user pressed Stop in the editor: the round ends at once. */
	stop(): AgentRound | null {
		if (!this.holder) return null
		const round = this.open.get(this.holder.roundId)
		if (round) this.finish(round, 'stopped', 'Stopped by the user.')
		return round ?? null
	}

	/** Ends a round that has had no call for `idleMs`. */
	sweep(idleMs = ROUND_IDLE_MS): AgentRound[] {
		const now = this.now()
		const ended: AgentRound[] = []
		if (this.holder && now - this.holder.lastCallAt > idleMs) {
			const round = this.open.get(this.holder.roundId)
			if (round) {
				this.finish(round, 'timed-out', `No request for ${Math.round(idleMs / 60_000)} minutes.`)
				ended.push(round)
			}
		}
		return ended
	}

	// ===== Internals =====

	private closeLoose(sessionId: string): void {
		const id = this.looseOf.get(sessionId)
		const loose = id ? this.open.get(id) : undefined
		if (loose) this.finish(loose, 'done')
	}

	private finish(round: AgentRound, status: Exclude<RoundStatus, 'working'>, summary?: string): void {
		round.status = status
		round.endedAt = this.now()
		if (summary !== undefined) round.summary = cleanText(summary, 2000)
		this.open.delete(round.id)
		if (round.calls.some((c) => c.status === 'running')) this.closing.set(round.id, round)
		if (this.roundOf.get(round.sessionId) === round.id) this.roundOf.delete(round.sessionId)
		if (this.looseOf.get(round.sessionId) === round.id) this.looseOf.delete(round.sessionId)
		this.emitRound(round)
		if (this.holder?.roundId === round.id) {
			this.holder = null
			this.emitLock()
		}
	}

	private emitRound(round: AgentRound): void {
		const { calls: _calls, ...meta } = round
		this.onEvent?.({ type: 'round', round: { ...meta } })
	}

	private emitLock(): void {
		this.onEvent?.({ type: 'lock', lock: this.lock() })
	}
}

function cleanText(text: string | undefined, max: number): string | undefined {
	const clean = String(text ?? '').trim()
	if (!clean) return undefined
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

// ===== Applying events (main's store and the renderer alike) =====

/** Rounds kept per project; the oldest drop off. */
export const MAX_ROUNDS = 200
/** Calls kept per round. A round longer than this keeps its newest. */
export const MAX_CALLS = 600

/**
 * Apply one event to a project's rounds, returning a new array. Rounds come in
 * start order. A call for a round not seen yet is kept by creating a stub, so
 * events may arrive in any order.
 */
export function applyRoundEvent(rounds: AgentRound[], event: RoundEvent): AgentRound[] {
	if (event.type === 'lock') return rounds
	if (event.type === 'round') {
		const index = rounds.findIndex((r) => r.id === event.round.id)
		if (index === -1) {
			const next = [...rounds, { ...event.round, calls: [] }].sort((a, b) => a.startedAt - b.startedAt)
			return next.length > MAX_ROUNDS ? next.slice(-MAX_ROUNDS) : next
		}
		return rounds.map((r, i) => (i === index ? { ...r, ...event.round, calls: r.calls } : r))
	}
	const index = rounds.findIndex((r) => r.id === event.roundId)
	if (index === -1) return rounds
	return rounds.map((r, i) => {
		if (i !== index) return r
		const at = r.calls.findIndex((c) => c.id === event.call.id)
		const calls = at === -1 ? [...r.calls, event.call] : r.calls.map((c, j) => (j === at ? { ...c, ...event.call } : c))
		return { ...r, calls: calls.length > MAX_CALLS ? calls.slice(-MAX_CALLS) : calls }
	})
}

/**
 * Rounds left 'working' in a file from a run that ended (the app quit with an
 * agent mid-round) are not working any more.
 */
export function settleStaleRounds(rounds: AgentRound[], liveRoundIds: Set<string>): AgentRound[] {
	return rounds.map((r) =>
		r.status === 'working' && !liveRoundIds.has(r.id)
			? { ...r, status: r.kind === 'loose' ? 'done' : 'disconnected', endedAt: r.endedAt ?? r.calls.at(-1)?.endedAt ?? r.startedAt }
			: r
	)
}

// ===== What the chat shows =====

export interface RoundStats {
	steps: number
	edits: number
	errors: number
	/** The V numbers its edits made, first and last ("V12", "V19"). */
	firstRevision?: string
	lastRevision?: string
	durationMs: number
}

export function roundStats(round: AgentRound, now = Date.now()): RoundStats {
	const versions = round.calls.flatMap((c) => (c.chips ?? []).filter((chip) => /^V\d+$/.test(chip.text)).map((chip) => chip.text))
	return {
		steps: round.calls.length,
		edits: round.calls.filter((c) => c.tool === 'apply_ops' && c.status === 'done').length,
		errors: round.calls.filter((c) => c.status === 'error' || c.status === 'refused').length,
		firstRevision: versions[0],
		lastRevision: versions.at(-1),
		durationMs: Math.max(0, (round.endedAt ?? now) - round.startedAt)
	}
}

export const ROUND_STATUS_LABEL: Record<RoundStatus, string> = {
	working: 'Working',
	done: 'Round ended',
	disconnected: 'Disconnected mid-round',
	'timed-out': 'Timed out',
	stopped: 'Stopped by you',
	left: 'Moved to another project'
}

export type ChatEntry<T> =
	| { kind: 'turn'; at: number; turn: T }
	| { kind: 'round'; at: number; round: AgentRound }

/**
 * The chat's history in time order: the user's own turns and the agents'
 * rounds. A turn an outside agent's apply_ops made is shown inside its round,
 * so it is left out here when a round recorded it.
 */
export function chatEntries<T extends { id: string; createdAt: number; agent?: { sessionId?: string; engineTurnId?: string } }>(
	turns: T[],
	rounds: AgentRound[]
): ChatEntry<T>[] {
	const sessionsWithRounds = new Set(rounds.map((r) => r.sessionId))
	const entries: ChatEntry<T>[] = [
		...turns
			.filter((t) => !t.agent?.engineTurnId)
			.filter((t) => !(t.agent?.sessionId && sessionsWithRounds.has(t.agent.sessionId)))
			.map((turn) => ({ kind: 'turn' as const, at: turn.createdAt, turn })),
		...rounds.filter((r) => r.calls.length || r.kind === 'round').map((round) => ({ kind: 'round' as const, at: round.startedAt, round }))
	]
	return entries.sort((a, b) => a.at - b.at)
}

/** "m:ss", or "h:mm:ss" past an hour. */
export function elapsedClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000))
	const minutes = Math.floor(total / 60)
	return minutes >= 60
		? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
		: `${minutes}:${String(total % 60).padStart(2, '0')}`
}
