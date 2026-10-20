import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join, sep } from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import {
	buildCommand, engineFailureNote, ENGINES, lineSplitter, parseStreamLine, StepTracker, TOKEN_ENV, unexpectedTools,
	type CliEngineId, type EngineStep
} from '@shared/engines'
import type { AgentActivity } from '@shared/agentFeed'
import type { AgentPermissions } from '@shared/agent'
import { AgentServer } from '../mcp/server'
import type { ApplyOutcome, EditorBridge } from '../mcp/bridge'
import { killTree, spawnTree } from './proc'
import type { Located } from './detect'

/**
 * One chat turn run by a CLI engine.
 *
 * FrameFlow starts a private MCP server for the turn — its own port, a token
 * made for this run and never stored or shown, edit rights but no export — so
 * it works whether or not the user lets external agents in, and never touches
 * that switch. The CLI is spawned in an empty scratch folder, pointed at that
 * server and nothing else; its JSONL stream becomes the turn's steps. Edits
 * land through apply_ops, so each is already a revision, labelled with the
 * engine. Abort kills the whole process tree.
 *
 * No Electron here: the test that really spawns each CLI runs this as is.
 */

/** The engine may edit; exporting stays the user's button. */
const ENGINE_PERMISSIONS: AgentPermissions = { edit: true, html: true, export: false }

/** Calls past the step limit are refused; this many more and the run is stopped. */
const OVERRUN_GRACE = 5

export interface CommitRecord {
	revisionId: string
	revisionSeq: number
	parentRevisionId: string | null
	counts: { added: number; removed: number; updated: number; markers: number }
}

export interface EngineRunOptions {
	engine: CliEngineId
	located: Located
	prompt: string
	systemPrompt: string
	model?: string
	maxSteps: number
	bridge: EditorBridge
	/** The chat turn: apply_ops links its revisions to it. */
	turnId: string
	version: string
	signal: AbortSignal
	/** Throttled by the caller if it wants; called on every step change. */
	onSteps?: (steps: EngineStep[], model?: string) => void
	onActivity?: (activity: AgentActivity) => void
	/** Whole-run cap. Default 20 minutes. */
	timeoutMs?: number
	/** Tests: run in this folder and leave it, to check nothing was written. */
	workDir?: string
}

export interface EngineRunResult {
	ok: boolean
	cancelled: boolean
	answer: string
	error?: string
	/** A failure the user must fix outside FrameFlow (sign-in), recognised from the output. */
	note?: string | null
	steps: EngineStep[]
	model?: string
	commits: CommitRecord[]
	exitCode: number | null
	stderr: string
}

const tail = (text: string, chars = 1200) => (text.length > chars ? `…${text.slice(-chars)}` : text)

/** The last line that reads like an error, for the turn card. */
function errorLine(stderr: string): string | undefined {
	const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean)
	return [...lines].reverse().find((l) => /error|failed|denied|invalid|not /i.test(l)) || lines[lines.length - 1]
}

export async function runEngineTurn(options: EngineRunOptions): Promise<EngineRunResult> {
	const { engine, located } = options
	const label = ENGINES[engine].label
	const commits: CommitRecord[] = []

	// Records what each apply_ops made, so the turn can say "V7" at the end.
	const bridge: EditorBridge = {
		...options.bridge,
		getLiveProject: () => options.bridge.getLiveProject(),
		readTranscripts: (p, ids) => options.bridge.readTranscripts(p, ids),
		renderFrame: (p, t) => options.bridge.renderFrame(p, t),
		switchRevision: (id) => options.bridge.switchRevision(id),
		startExport: () => options.bridge.startExport(),
		async commitTurn(commit) {
			const outcome: ApplyOutcome = await options.bridge.commitTurn(commit)
			if (outcome.ok) {
				commits.push({
					revisionId: outcome.revisionId, revisionSeq: outcome.revisionSeq,
					parentRevisionId: outcome.parentRevisionId ?? null, counts: outcome.counts
				})
			}
			return outcome
		}
	}

	const token = `ff_run_${randomBytes(24).toString('hex')}`
	let toolCalls = 0
	let overrun = false
	const server = new AgentServer({
		bridge,
		token: () => token,
		permissions: () => ENGINE_PERMISSIONS,
		version: options.version,
		engineTurnId: options.turnId,
		maxToolCalls: options.maxSteps,
		onEvent: (event) => {
			if (event.type !== 'activity') return
			if (event.activity.status === 'running' && ++toolCalls > options.maxSteps + OVERRUN_GRACE) {
				overrun = true
				stop('overrun')
			}
			options.onActivity?.(event.activity)
		}
	})

	const workDir = options.workDir || mkdtempSync(join(os.tmpdir(), 'frameflow-engine-'))
	try { chmodSync(workDir, 0o700) } catch { /* best effort */ }
	const tracker = new StepTracker()
	let stderr = ''
	let child: ReturnType<typeof spawnTree> | null = null
	let stopReason: 'abort' | 'timeout' | 'restricted' | 'overrun' | null = null
	let restrictedDetail = ''

	const stop = (reason: NonNullable<typeof stopReason>) => {
		if (!stopReason) stopReason = reason
		if (child) killTree(child)
	}

	try {
		const port = await server.start(0)
		if (options.signal.aborted) stopReason = 'abort'
		const spec = buildCommand({
			engine,
			prompt: options.prompt,
			systemPrompt: options.systemPrompt,
			mcpUrl: `http://127.0.0.1:${port}/mcp`,
			model: options.model,
			workDir,
			pathSep: sep === '\\' ? '\\' : '/'
		})
		for (const file of spec.files) writeFileSync(join(workDir, file.name), file.content, { mode: 0o600 })

		const exitCode = stopReason ? null : await new Promise<number | null>((resolve) => {
			const proc = spawnTree(located.path, spec.args, {
				cwd: workDir,
				env: { ...located.env, ...spec.env, [TOKEN_ENV]: token }
			})
			child = proc
			const onAbort = () => stop('abort')
			options.signal.addEventListener('abort', onAbort, { once: true })
			const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 20 * 60_000)

			const lines = lineSplitter((line) => {
				let changed = false
				for (const event of parseStreamLine(engine, line)) {
					if (tracker.apply(event)) changed = true
					if (event.type === 'init') {
						// Claude Code lists its tools up front: anything but FrameFlow's
						// means the restriction did not hold, and nothing may run.
						const extra = unexpectedTools(event.tools)
						if (extra.length) {
							restrictedDetail = `${label} offered tools FrameFlow did not allow (${extra.slice(0, 5).join(', ')}).`
							stop('restricted')
						}
					}
				}
				// A step outside FrameFlow that SUCCEEDED means the lock failed.
				const escaped = tracker.steps.find((s) => s.foreign && s.status === 'done')
				if (escaped) {
					restrictedDetail = `${label} ran ${escaped.tool}, which FrameFlow does not allow.`
					stop('restricted')
				}
				if (changed) options.onSteps?.(tracker.steps.map((s) => ({ ...s })), tracker.model)
			})
			proc.stdout!.setEncoding('utf-8')
			proc.stdout!.on('data', (chunk: string) => lines.push(chunk))
			proc.stderr!.setEncoding('utf-8')
			proc.stderr!.on('data', (chunk: string) => { stderr = tail(stderr + chunk, 20_000) })
			proc.on('error', (error) => {
				stderr += `\n${error.message}`
			})
			proc.on('close', (code) => {
				lines.end()
				clearTimeout(timer)
				options.signal.removeEventListener('abort', onAbort)
				resolve(code)
			})
		})

		tracker.settle(stopReason === 'abort' ? 'Stopped' : 'Did not finish')
		options.onSteps?.(tracker.steps.map((s) => ({ ...s })), tracker.model)

		const base = { steps: tracker.steps, model: tracker.model, commits, exitCode, stderr: tail(stderr) }
		if (stopReason === 'abort') return { ...base, ok: false, cancelled: true, answer: tracker.answer, error: 'Cancelled' }
		if (stopReason === 'restricted') {
			return { ...base, ok: false, cancelled: false, answer: '', error: `Stopped: ${restrictedDetail} Nothing outside FrameFlow’s tools may run.` }
		}
		if (stopReason === 'timeout') return { ...base, ok: false, cancelled: false, answer: tracker.answer, error: `${label} took too long and was stopped.` }
		if (stopReason === 'overrun' || overrun) {
			return { ...base, ok: false, cancelled: false, answer: tracker.answer, error: `${label} kept calling tools past the ${options.maxSteps}-step limit and was stopped.` }
		}

		const output = [stderr, tracker.done?.error || '', ...tracker.errors].join('\n')
		const note = engineFailureNote(engine, output)
		const ok = tracker.done ? tracker.done.ok : exitCode === 0
		if (ok && exitCode !== 0 && !tracker.done) {
			return { ...base, ok: false, cancelled: false, answer: tracker.answer, note, error: note || errorLine(stderr) || `${label} exited with code ${exitCode}.` }
		}
		if (!ok) {
			return {
				...base, ok: false, cancelled: false, answer: tracker.answer, note,
				error: note || tracker.done?.error || errorLine(stderr) || `${label} exited with code ${exitCode}.`
			}
		}
		return { ...base, ok: true, cancelled: false, answer: tracker.answer, note: null }
	} finally {
		if (child) killTree(child as ReturnType<typeof spawnTree>, 500)
		await server.stop().catch(() => { /* already down */ })
		if (!options.workDir) {
			try { rmSync(workDir, { recursive: true, force: true }) } catch { /* temp dir */ }
		}
	}
}
