import { randomBytes } from 'node:crypto'
import type { AgentActivity } from '@shared/agentFeed'
import type { AgentPermissions } from '@shared/agent'
import type { MotionProbe } from '../editor/vetHtml'
import { AgentServer } from '../mcp/server'
import { TOOLS } from '../mcp/tools'
import type { ApplyOutcome, EditorBridge } from '../mcp/bridge'

/**
 * What every engine turn shares, whoever drives the model.
 *
 * FrameFlow starts a private MCP server for the turn: its own port, a token made
 * for this run and never stored or shown, edit rights but no export, and the
 * step budget. It works whether or not the user lets external agents in, and
 * never touches that switch. A CLI is pointed at it from a spawned process; the
 * in-process loop connects to it with an MCP client. Either way the edits land
 * through apply_ops, so each is already a revision labelled with the engine, and
 * this records which revisions the turn made.
 *
 * No Electron here: the tests that really spawn a CLI run this as is.
 */

/** Calls past the step limit are refused; this many more and the run is stopped. */
export const OVERRUN_GRACE = 5

export interface CommitRecord {
	revisionId: string
	revisionSeq: number
	parentRevisionId: string | null
	counts: { added: number; removed: number; updated: number; markers: number }
}

export interface TurnSessionOptions {
	bridge: EditorBridge
	maxSteps: number
	/** The chat turn: apply_ops links its revisions to it. */
	turnId: string
	version: string
	/** Read per call, so flipping the setting mid-turn takes effect. */
	permissions: () => AgentPermissions
	/** Draws a page in the hidden window: the engine's pages get the same check as everyone's. */
	probeMotion?: MotionProbe
	onActivity?: (activity: AgentActivity) => void
	/** Called once when the run has made more calls than the budget and the grace allow. */
	onOverrun: () => void
}

export interface TurnSession {
	server: AgentServer
	/** The bearer token of this run's server. */
	token: string
	commits: CommitRecord[]
	/** The revision the run left current: its last edit, or a later revert_to_version. */
	finalRevisionId(): string | undefined
	overrun(): boolean
}

export function createTurnSession(options: TurnSessionOptions): TurnSession {
	const commits: CommitRecord[] = []
	let finalRevisionId: string | undefined
	let overrun = false
	let toolCalls = 0

	// Records what each apply_ops made, so the turn can say "V7" at the end.
	const bridge: EditorBridge = {
		...options.bridge,
		getLiveProject: () => options.bridge.getLiveProject(),
		readTranscripts: (p, ids) => options.bridge.readTranscripts(p, ids),
		renderFrame: (p, t) => options.bridge.renderFrame(p, t),
		async switchRevision(id) {
			const result = await options.bridge.switchRevision(id)
			if (result.ok) finalRevisionId = id
			return result
		},
		startExport: (p, o) => options.bridge.startExport(p, o),
		// Spelled out: a class instance's methods do not survive the spread above.
		exportStatus: (q) => options.bridge.exportStatus(q),
		inspectExport: (f, o) => options.bridge.inspectExport(f, o),
		mediaSheet: (p, id, o) => options.bridge.mediaSheet(p, id, o),
		findSilences: (p, id, o) => options.bridge.findSilences(p, id, o),
		isPreparing: (p, id) => options.bridge.isPreparing(p, id),
		preparingLanes: (p, id) => options.bridge.preparingLanes?.(p, id) ?? [],
		timelineSheet: (p, t, o) => options.bridge.timelineSheet(p, t, o),
		listProjects: () => options.bridge.listProjects(),
		createProject: (t) => options.bridge.createProject(t),
		openProject: (id) => options.bridge.openProject(id),
		importMedia: (p, src, cb) => options.bridge.importMedia(p, src, cb),
		async commitTurn(commit) {
			const outcome: ApplyOutcome = await options.bridge.commitTurn(commit)
			if (outcome.ok) {
				finalRevisionId = outcome.revisionId
				commits.push({
					revisionId: outcome.revisionId, revisionSeq: outcome.revisionSeq,
					parentRevisionId: outcome.parentRevisionId ?? null, counts: outcome.counts
				})
			}
			return outcome
		}
	}

	const token = `ff_run_${randomBytes(24).toString('hex')}`
	const server = new AgentServer({
		bridge,
		// An engine's turn is the round: begin_round and end_round are for outside agents,
		// and a model that is offered them calls them and is told they are not for it.
		tools: TOOLS.filter((tool) => !tool.roundTool),
		token: () => token,
		permissions: options.permissions,
		probeMotion: options.probeMotion,
		version: options.version,
		engineTurnId: options.turnId,
		// The engine's system prompt already carries the baseline: sending it again would double it.
		instructions: null,
		maxToolCalls: options.maxSteps,
		onEvent: (event) => {
			if (event.type !== 'activity') return
			if (event.activity.status === 'running' && ++toolCalls > options.maxSteps + OVERRUN_GRACE && !overrun) {
				overrun = true
				options.onOverrun()
			}
			options.onActivity?.(event.activity)
		}
	})

	return { server, token, commits, finalRevisionId: () => finalRevisionId, overrun: () => overrun }
}
