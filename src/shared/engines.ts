import { clock } from './agentFeed'
import { opKeys } from './agent'
import type { PromptTurn } from './types'

/**
 * AI engines: which AI edits when the user chats in FrameFlow.
 *
 * The Gemini API engine is today's single-shot structured call. A CLI engine
 * runs the user's own AI CLI agentically, pointed at FrameFlow's MCP server and
 * allowed nothing else. Claude Code is the one shipped; the tables below
 * (ENGINES, CLI_MODELS, LINE_PARSERS, buildCommand) are where another CLI plugs in.
 *
 * Everything decidable lives here, with tests: the command line for each CLI,
 * what each CLI's version and sign-in output means, and how each CLI's JSONL
 * stream becomes one common list of steps. main/engine/* only spawns.
 */

export type EngineId = 'claude-code' | 'gemini-api'
export type CliEngineId = Exclude<EngineId, 'gemini-api'>

export const ENGINE_IDS: EngineId[] = ['claude-code', 'gemini-api']
export const CLI_ENGINE_IDS: CliEngineId[] = ['claude-code']

export const isCliEngine = (id: EngineId | string | undefined): id is CliEngineId =>
	id === 'claude-code'

export interface EngineMeta {
	id: EngineId
	/** "Claude Code" — the chip, the radio card, the revision label. */
	label: string
	/** The executable looked up on PATH. */
	bin?: string
	/** The radio card's line under the version. */
	blurb: string
	/** The turn card's footer: "Claude Code · subscription". */
	footer: string
}

export const ENGINES: Record<EngineId, EngineMeta> = {
	'claude-code': {
		id: 'claude-code', label: 'Claude Code', bin: 'claude',
		blurb: 'Uses your Claude plan. Looks at frames while it edits, and drives FrameFlow through its own tools.',
		footer: 'Claude Code · subscription'
	},
	'gemini-api': {
		id: 'gemini-api', label: 'Gemini API',
		blurb: 'One reply per turn. Costs show in the project header.',
		footer: 'Gemini API'
	}
}

// ===== Settings =====

export const STEPS_MIN = 1
export const STEPS_MAX = 50
export const STEPS_DEFAULT = 20

export interface EngineSettings {
	engine: EngineId
	/** Per CLI; empty means "as set in the CLI". */
	models: Partial<Record<CliEngineId, string>>
	/** Tool calls a CLI engine may make in one turn. */
	maxSteps: number
}

/** Today's engine stays the default: nothing changes until the user picks a CLI. */
export const DEFAULT_ENGINE_SETTINGS: EngineSettings = { engine: 'gemini-api', models: {}, maxSteps: STEPS_DEFAULT }

export function normalizeEngineSettings(raw: Partial<EngineSettings> | undefined | null): EngineSettings {
	const engine = ENGINE_IDS.includes(raw?.engine as EngineId) ? raw!.engine! : DEFAULT_ENGINE_SETTINGS.engine
	const models: EngineSettings['models'] = {}
	for (const id of CLI_ENGINE_IDS) {
		const value = raw?.models?.[id]
		if (typeof value === 'string' && value.trim()) models[id] = value.trim()
	}
	const steps = Math.round(Number(raw?.maxSteps))
	const maxSteps = Number.isFinite(steps) ? Math.min(STEPS_MAX, Math.max(STEPS_MIN, steps)) : STEPS_DEFAULT
	return { engine, models, maxSteps }
}

export interface ModelOption { value: string; label: string }

/**
 * Models each CLI accepts by name. Claude Code takes aliases that follow the
 * latest model. A CLI that reports its own catalogue at run time can fill
 * `EngineDetection.models` instead.
 */
export const CLI_MODELS: Record<CliEngineId, ModelOption[]> = {
	'claude-code': [
		{ value: 'fable', label: 'Fable' },
		{ value: 'opus', label: 'Opus' },
		{ value: 'sonnet', label: 'Sonnet' },
		{ value: 'haiku', label: 'Haiku' }
	],
}

/** The default option, which passes no model flag: the CLI uses its own setting. */
export const asSetIn = (id: CliEngineId) => `As set in ${ENGINES[id].label}`

/**
 * CLIs often print an API error as raw JSON. The turn card wants its message:
 * `{"error":{"message":"The 'x' model is not supported…"}}` → that sentence.
 */
export function readableError(text: string): string {
	const trimmed = (text || '').trim()
	const quoted = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(trimmed)
	if (quoted && /^[[{]|\{"/.test(trimmed)) {
		try { return JSON.parse(`"${quoted[1]}"`) } catch { return quoted[1] }
	}
	return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed
}

// ===== Detection =====

export type EngineStatus =
	| 'signed-in'   // the CLI says so
	| 'found'       // installed; it cannot tell us whether it is signed in
	| 'signed-out'  // the CLI says it is not
	| 'missing'     // not on PATH
	| 'unusable'    // installed, but its last run failed in a way the user must fix
	| 'per-token'   // Gemini API with a key saved
	| 'no-key'      // Gemini API without one

export interface EngineDetection {
	id: EngineId
	status: EngineStatus
	version?: string
	path?: string
	/** "/opt/homebrew/bin/claude", with the home folder shown as ~. */
	displayPath?: string
	/** Why it is unusable, or how to sign in. */
	note?: string
	/** Extra models the CLI reported, when it can. */
	models?: ModelOption[]
}

export const STATUS_LABEL: Record<EngineStatus, string> = {
	'signed-in': 'Signed in', found: 'Found', 'signed-out': 'Signed out', missing: 'Not found',
	unusable: 'Needs attention', 'per-token': 'Per token', 'no-key': 'No key'
}

export type StatusTone = 'green' | 'zinc' | 'amber' | 'red'
export const STATUS_TONE: Record<EngineStatus, StatusTone> = {
	'signed-in': 'green', found: 'zinc', 'signed-out': 'amber', missing: 'zinc',
	unusable: 'red', 'per-token': 'amber', 'no-key': 'red'
}

/** Whether a run can be attempted at all. */
export const engineRunnable = (d: EngineDetection | undefined): boolean =>
	!!d && (d.status === 'signed-in' || d.status === 'found' || d.status === 'per-token' || d.status === 'unusable')

/** The first x.y.z in `--version` output: "2.1.231 (Claude Code)". */
export function parseVersion(output: string): string | undefined {
	return /(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(output || '')?.[1]
}

/** `claude auth status` prints JSON with `loggedIn`. */
export function parseClaudeAuth(output: string): boolean | null {
	try {
		const data = JSON.parse(output)
		return typeof data?.loggedIn === 'boolean' ? data.loggedIn : null
	} catch {
		return null
	}
}

/** "/Users/me/.local/bin/claude" → "~/.local/bin/claude". */
export function displayPath(path: string, home: string | undefined): string {
	if (home && (path === home || path.startsWith(home.endsWith('/') ? home : `${home}/`))) return `~${path.slice(home.replace(/\/$/, '').length)}`
	return path
}

/**
 * A failure the user has to fix outside FrameFlow, recognised from what the
 * CLI printed. Null when it is an ordinary error.
 */
export function engineFailureNote(id: CliEngineId, output: string): string | null {
	const text = output || ''
	if (id === 'claude-code' && /not logged in|please run \/login|invalid api key|OAuth token has expired/i.test(text)) {
		return 'Claude Code is not signed in. Run `claude` in a terminal and sign in, then try again.'
	}
	return null
}

// ===== Retry =====

export interface EngineRetry {
	engine: CliEngineId
	prompt: string
	selectedItemIds: string[]
	playheadSec: number
	widen?: 'chapter' | 'full'
}

/**
 * A run that failed can be sent again, on the same engine, with the same
 * prompt and selection, from where the project is now. Only the newest chat
 * turn offers it, and never a run the user stopped. Returns what to re-send,
 * or null when Retry is not offered.
 */
export function engineRetry(turn: PromptTurn | null | undefined, turns: PromptTurn[]): EngineRetry | null {
	const engine = turn?.engine
	if (!turn || !engine || engine.end !== 'failed' || !engine.request) return null
	if (turn.status !== 'error' && turn.status !== 'completed') return null
	// The edits an engine makes are agent turns inside its own chat turn.
	const chat = turns.filter((t) => !t.agent?.engineTurnId)
	const latest = chat.reduce<PromptTurn | undefined>((a, t) => (!a || t.createdAt >= a.createdAt ? t : a), undefined)
	if (latest?.id !== turn.id) return null
	return { engine: engine.id, prompt: turn.prompt, ...engine.request }
}

// ===== The common step model =====

export type EngineEvent =
	| { type: 'init'; model?: string; tools?: string[]; sessionId?: string }
	| { type: 'tool-start'; callId: string; tool: string; server: string | null; args: Record<string, unknown> }
	| { type: 'tool-end'; callId: string; ok: boolean; error?: string }
	| { type: 'text'; text: string; delta?: boolean }
	| { type: 'error'; message: string; fatal?: boolean }
	| { type: 'done'; ok: boolean; text?: string; error?: string }

export type EngineStepStatus = 'running' | 'done' | 'error'

export interface EngineStep {
	id: string
	tool: string
	/** "search_moments “introduces herself”". */
	title: string
	status: EngineStepStatus
	/** Not one of FrameFlow's tools — the CLI tried something it was not given. */
	foreign?: boolean
	error?: string
}

export const MCP_SERVER_KEY = 'frameflow'

/**
 * Each CLI names an MCP tool its own way: Claude Code `mcp__frameflow__get_project`.
 * A CLI that reports the server beside the bare tool passes it as `server`.
 */
export function normalizeToolName(name: string, server?: string | null): { tool: string; server: string | null } {
	if (server) return { tool: name, server }
	const claude = /^mcp__([^_].*?)__(.+)$/.exec(name)
	if (claude) return { server: claude[1], tool: claude[2] }
	return { tool: name, server: null }
}

const FRAMEFLOW_TOOLS = new Set([
	'get_project', 'get_timeline', 'get_media', 'search_moments', 'render_frame', 'apply_ops', 'revert_to_version', 'export'
])

/** Whether a call reached FrameFlow, by server name or, when a CLI drops it, by tool name. */
export const isFrameflowTool = (tool: string, server: string | null): boolean =>
	server === MCP_SERVER_KEY || (server === null && FRAMEFLOW_TOOLS.has(tool))

const stem = (name: unknown) => String(name ?? '').replace(/\.[^.]+$/, '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** One op, in words: "addMarkers ×2". */
function opSummary(args: Record<string, unknown>): string {
	const keys = opKeys(args)
	if (!keys.length) return ''
	const parts = keys.slice(0, 2).map((key) => {
		const value = args[key]
		return Array.isArray(value) && value.length > 1 ? `${key} ×${value.length}` : key
	})
	const at = editTime(args)
	return `${parts.join(' · ')}${keys.length > 2 ? ` +${keys.length - 2}` : ''}${at !== undefined ? ` @ ${clock(at)}` : ''}`
}

/** The title a step shows, from the tool and its arguments. */
export function stepTitle(tool: string, args: Record<string, unknown> = {}, foreign = false): string {
	if (foreign) return `${tool} — not allowed`
	switch (tool) {
		case 'search_moments': return `search_moments “${String(args.query ?? '').slice(0, 60)}”`
		case 'get_media': {
			const from = num(args.fromSec), to = num(args.toSec)
			const range = from !== undefined || to !== undefined ? ` ${clock(from ?? 0)}–${to !== undefined ? clock(to) : 'end'}` : ''
			return `get_media ${stem(args.asset)}${range}`
		}
		case 'get_timeline': {
			const from = num(args.fromSec), to = num(args.toSec)
			return from !== undefined || to !== undefined
				? `get_timeline ${clock(from ?? 0)}–${to !== undefined ? clock(to) : 'end'}`
				: 'get_timeline'
		}
		case 'render_frame': return `render_frame ${clock(num(args.timeSec) ?? 0)}`
		case 'apply_ops': {
			const summary = opSummary(args)
			return summary ? `apply_ops ${summary}` : 'apply_ops'
		}
		case 'revert_to_version': return `revert_to_version V${args.version ?? '?'}`
		default: return tool
	}
}

// ===== What the agent is looking at (board 3) =====

export type AgentFocus =
	| { kind: 'read'; asset: string }
	| { kind: 'look'; timeSec: number }
	| { kind: 'edit'; timeSec: number }

/**
 * The earliest timeline time an edit touches, from the fields FrameFlow's ops
 * use for timeline positions. Source in/out are deliberately not read.
 */
export function editTime(args: Record<string, unknown>): number | undefined {
	let best: number | undefined
	const take = (v: unknown) => {
		const n = num(v)
		if (n !== undefined && n >= 0 && (best === undefined || n < best)) best = n
	}
	for (const key of opKeys(args)) {
		const value = args[key]
		const rows = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []
		for (const row of rows) {
			if (!row || typeof row !== 'object') continue
			const r = row as Record<string, unknown>
			take(r.timelineStart); take(r.atSec); take(r.time)
			if (key === 'removeRanges') take(r.start)
		}
	}
	return best
}

/** Where the agent is acting, for the media chip, the monitor overlay and Follow agent. */
export function agentFocus(tool: string, args: Record<string, unknown> = {}): AgentFocus | null {
	if ((tool === 'get_media' || tool === 'search_moments') && typeof args.asset === 'string' && args.asset) {
		return { kind: 'read', asset: args.asset }
	}
	if (tool === 'render_frame') return { kind: 'look', timeSec: num(args.timeSec) ?? 0 }
	if (tool === 'apply_ops') {
		const at = editTime(args)
		return at === undefined ? null : { kind: 'edit', timeSec: at }
	}
	return null
}

// ===== Stream parsers =====

const asText = (content: unknown): string => {
	if (typeof content === 'string') return content
	if (Array.isArray(content)) {
		return content.map((c) => (c && typeof c === 'object' && typeof (c as any).text === 'string' ? (c as any).text : '')).join('')
	}
	return ''
}

function parseClaudeLine(d: any): EngineEvent[] {
	switch (d?.type) {
		case 'system':
			return d.subtype === 'init'
				? [{ type: 'init', model: d.model, tools: Array.isArray(d.tools) ? d.tools : undefined, sessionId: d.session_id }]
				: []
		case 'assistant': {
			const out: EngineEvent[] = []
			for (const c of d.message?.content || []) {
				if (c?.type === 'text' && c.text) out.push({ type: 'text', text: c.text })
				else if (c?.type === 'tool_use') {
					const { tool, server } = normalizeToolName(String(c.name || ''))
					out.push({ type: 'tool-start', callId: String(c.id), tool, server, args: c.input || {} })
				}
			}
			return out
		}
		case 'user': {
			const out: EngineEvent[] = []
			for (const c of d.message?.content || []) {
				if (c?.type === 'tool_result') {
					out.push({
						type: 'tool-end', callId: String(c.tool_use_id), ok: !c.is_error,
						error: c.is_error ? asText(c.content).split('\n')[0] || 'Tool error' : undefined
					})
				}
			}
			return out
		}
		case 'result':
			return [{
				type: 'done', ok: !d.is_error && d.subtype !== 'error_during_execution',
				text: typeof d.result === 'string' ? d.result : undefined,
				error: d.is_error ? (typeof d.result === 'string' && d.result) || d.subtype || 'Claude Code failed' : undefined
			}]
		default:
			return []
	}
}

const LINE_PARSERS: Record<CliEngineId, (d: any) => EngineEvent[]> = {
	'claude-code': parseClaudeLine
}

/** One JSONL line → common events. Lines that are not JSON (banners, warnings) are ignored. */
export function parseStreamLine(id: CliEngineId, line: string): EngineEvent[] {
	const trimmed = line.trim()
	if (!trimmed.startsWith('{')) return []
	let data: unknown
	try {
		data = JSON.parse(trimmed)
	} catch {
		return []
	}
	return LINE_PARSERS[id](data)
}

/** Splits a byte stream into lines across chunk boundaries. */
export function lineSplitter(onLine: (line: string) => void) {
	let buffer = ''
	return {
		push(chunk: string) {
			buffer += chunk
			let index: number
			while ((index = buffer.indexOf('\n')) !== -1) {
				onLine(buffer.slice(0, index))
				buffer = buffer.slice(index + 1)
			}
		},
		end() {
			if (buffer) onLine(buffer)
			buffer = ''
		}
	}
}

/**
 * Folds events into the turn's state: the steps list, and the answer — the
 * text the agent wrote after its last tool call.
 */
export class StepTracker {
	steps: EngineStep[] = []
	model?: string
	initTools?: string[]
	errors: string[] = []
	done?: { ok: boolean; error?: string }
	private text = ''
	private resultText?: string

	apply(event: EngineEvent): boolean {
		switch (event.type) {
			case 'init':
				this.model = event.model ?? this.model
				this.initTools = event.tools ?? this.initTools
				return false
			case 'tool-start': {
				const foreign = !isFrameflowTool(event.tool, event.server)
				this.text = ''
				const existing = this.steps.find((s) => s.id === event.callId)
				if (existing) return false
				this.steps.push({
					id: event.callId, tool: event.tool, title: stepTitle(event.tool, event.args, foreign),
					status: 'running', foreign: foreign || undefined
				})
				return true
			}
			case 'tool-end': {
				const step = this.steps.find((s) => s.id === event.callId)
				if (!step) return false
				step.status = event.ok ? 'done' : 'error'
				if (!event.ok && event.error) step.error = event.error.slice(0, 200)
				if (event.ok && step.tool === 'render_frame' && !step.foreign) step.title = `${step.title} — checked`
				return true
			}
			case 'text':
				this.text = event.delta ? this.text + event.text : (this.text ? `${this.text}\n\n${event.text}` : event.text)
				return false
			case 'error':
				this.errors.push(event.message)
				return false
			case 'done':
				this.done = { ok: event.ok, error: event.error }
				if (event.text) this.resultText = event.text
				return true
		}
	}

	/** The answer to show: the CLI's own result when it gives one, else the last text. */
	get answer(): string {
		return (this.resultText ?? this.text).trim()
	}

	/** Steps that never finished (the process was killed) end as errors. */
	settle(reason = 'Stopped'): void {
		for (const step of this.steps) {
			if (step.status === 'running') {
				step.status = 'error'
				step.error = reason
			}
		}
	}

	get foreignTools(): string[] {
		return this.steps.filter((s) => s.foreign).map((s) => s.tool)
	}
}

/**
 * Claude Code reports its whole tool list at start; anything but FrameFlow's
 * means the restriction did not hold and the run must stop.
 */
export function unexpectedTools(tools: string[] | undefined): string[] {
	if (!tools) return []
	return tools.filter((name) => {
		const { tool, server } = normalizeToolName(name)
		return !isFrameflowTool(tool, server)
	})
}

// ===== Prompts =====

export interface EnginePromptInput {
	/** The persona's own instructions. */
	persona: { name: string; systemPrompt: string }
	maxSteps: number
	engineLabel: string
}

export function buildEngineSystemPrompt(input: EnginePromptInput): string {
	return [
		`You are the video editor inside FrameFlow, working for the user through FrameFlow's own tools (the "frameflow" MCP server). You are running as ${input.engineLabel}.`,
		'You have no shell, no file access and no web access in this session — only FrameFlow\'s tools. Do not try anything else.',
		'',
		'How to work:',
		'- Start with get_project, then read what you need: get_timeline, get_media, search_moments.',
		'- Edit with apply_ops. Each call is one revision the user can undo, so prefer a few focused calls. Always give a short rationale.',
		'- Look at your result with render_frame before you finish, and fix it (or revert_to_version) if it is wrong.',
		'- Timeline times (timelineStart, atSec, removeRanges) are TIMELINE seconds; in/out are SOURCE seconds.',
		'- Never call export: the user exports.',
		`- You have at most ${input.maxSteps} tool calls for this turn.`,
		'- If the user asked a question rather than for an edit, answer it without editing.',
		'',
		'When you are done, reply in two or three plain sentences: what you changed and where (with times), or the answer. That reply is shown to the user as your rationale. No markdown headings, no lists of tool calls.',
		'',
		`The user's editor persona is "${input.persona.name}". Follow its instructions:`,
		input.persona.systemPrompt.trim()
	].join('\n')
}

export interface EngineUserPromptInput {
	prompt: string
	playheadSec: number
	/** Ids of the timeline items the user has selected. */
	selectedItemIds: string[]
	/** The scope chip's choice. */
	widen?: 'chapter' | 'full'
}

export function buildEngineUserPrompt(input: EngineUserPromptInput): string {
	const scope = input.widen === 'full'
		? 'Scope: the whole timeline.'
		: input.widen === 'chapter'
			? `Scope: the chapter around the playhead (${clock(input.playheadSec)}).`
			: input.selectedItemIds.length
				? `Scope: the selected timeline item${input.selectedItemIds.length === 1 ? '' : 's'} (${input.selectedItemIds.join(', ')}). Change only ${input.selectedItemIds.length === 1 ? 'it' : 'them'} unless the request needs more.`
				: 'Scope: whatever the request needs.'
	return `${input.prompt.trim()}\n\n---\nPlayhead: ${clock(input.playheadSec)}. ${scope}`
}

// ===== Command lines =====

/** The env var that carries the internal token, so it is never on disk or in `ps`. */
export const TOKEN_ENV = 'FRAMEFLOW_MCP_TOKEN'

export interface CommandInput {
	engine: CliEngineId
	prompt: string
	systemPrompt: string
	mcpUrl: string
	model?: string
	/** An empty scratch directory: the CLI's cwd, and where its config files go. */
	workDir: string
	pathSep?: '/' | '\\'
}

export interface CommandSpec {
	args: string[]
	/** Added to the environment (the token goes in separately). */
	env: Record<string, string>
	/** Written into workDir before spawning. */
	files: { name: string; content: string }[]
}

const join = (dir: string, name: string, sep: '/' | '\\' = '/') => `${dir.replace(/[\\/]+$/, '')}${sep}${name}`

export function buildCommand(input: CommandInput): CommandSpec {
	const sep = input.pathSep || '/'
	const model = input.model?.trim()
	switch (input.engine) {
		case 'claude-code': {
			const mcpConfig = {
				mcpServers: {
					[MCP_SERVER_KEY]: { type: 'http', url: input.mcpUrl, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } }
				}
			}
			return {
				files: [{ name: 'mcp.json', content: JSON.stringify(mcpConfig, null, 2) }],
				env: {},
				args: [
					'-p', input.prompt,
					'--output-format', 'stream-json', '--verbose',
					'--mcp-config', join(input.workDir, 'mcp.json', sep), '--strict-mcp-config',
					// No built-in tools at all: no Bash, no Read/Write/Edit, no web, no subagents.
					'--tools', '',
					'--allowedTools', `mcp__${MCP_SERVER_KEY}`,
					'--permission-mode', 'dontAsk',
					'--no-session-persistence',
					'--disable-slash-commands',
					// User settings only (their model and sign-in); never a project's.
					'--setting-sources', 'user',
					'--system-prompt', input.systemPrompt,
					...(model ? ['--model', model] : [])
				]
			}
		}
	}
}
