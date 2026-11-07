import { clock } from './agentFeed'
import { opKeys } from './agent'
import { FRAMEFLOW_BASELINE } from './baseline'
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

/**
 * An engine whose loop runs inside FrameFlow: any model with tool calling,
 * driven over the same MCP tools a CLI gets. Gemini first; OpenRouter models
 * later plug in as another id with a provider and a model list.
 */
export type LoopEngineId = Exclude<EngineId, CliEngineId>
export const LOOP_ENGINE_IDS: LoopEngineId[] = ['gemini-api']
export const isLoopEngine = (id: EngineId | string | undefined): id is LoopEngineId =>
	id === 'gemini-api'

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
		blurb: 'Edits in many steps through FrameFlow\u2019s own tools, and looks at frames. Costs show in the project header.',
		footer: 'Gemini API'
	}
}

// ===== Settings =====

/** What a CLI runs until the user picks otherwise: the model and effort, by value. */
export const CLI_DEFAULTS: Record<CliEngineId, { model: string; effort: string }> = {
	'claude-code': { model: 'claude-opus-5-5', effort: 'medium' }
}

export const STEPS_MIN = 1
// A real edit is dozens of calls (read, cut, look, fix, motion layers, sound).
// 20 ran out mid-edit: past the limit the server refuses calls and tells the
// agent to wrap up, where Claude Desktop over MCP has no limit at all.
export const STEPS_MAX = 300
export const STEPS_DEFAULT = 80
/** The old default. Settings files saved it as if chosen, so it reads as "never changed". */
const STEPS_LEGACY_DEFAULT = 20

export interface EngineSettings {
	engine: EngineId
	/** Per CLI: the model it runs. Always set; a CLI the user never configured gets CLI_DEFAULTS. */
	models: Partial<Record<CliEngineId, string>>
	/** Per CLI: how hard it thinks. Always set, the same way. */
	efforts: Partial<Record<CliEngineId, string>>
	/** Tool calls a CLI engine may make in one turn. */
	maxSteps: number
}

/** Today's engine stays the default: nothing changes until the user picks a CLI. */
export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
	engine: 'gemini-api',
	models: Object.fromEntries(CLI_ENGINE_IDS.map((id) => [id, CLI_DEFAULTS[id].model])),
	efforts: Object.fromEntries(CLI_ENGINE_IDS.map((id) => [id, CLI_DEFAULTS[id].effort])),
	maxSteps: STEPS_DEFAULT
}

export function normalizeEngineSettings(raw: Partial<EngineSettings> | undefined | null): EngineSettings {
	const engine = ENGINE_IDS.includes(raw?.engine as EngineId) ? raw!.engine! : DEFAULT_ENGINE_SETTINGS.engine
	const models: EngineSettings['models'] = {}
	for (const id of CLI_ENGINE_IDS) {
		const value = raw?.models?.[id]
		const model = typeof value === 'string' ? value.trim() : ''
		// Nothing chosen (or "as set in the CLI", which older versions offered) is the default model.
		models[id] = model ? LEGACY_MODEL_ALIASES[id][model.toLowerCase()] ?? model : CLI_DEFAULTS[id].model
	}
	// An effort the CLI does not know would fail every run, so only listed ones stay.
	const efforts: EngineSettings['efforts'] = {}
	for (const id of CLI_ENGINE_IDS) {
		const value = typeof raw?.efforts?.[id] === 'string' ? raw!.efforts![id]!.trim() : ''
		efforts[id] = CLI_EFFORTS[id].some((o) => o.value === value) ? value : CLI_DEFAULTS[id].effort
	}
	const steps = Math.round(Number(raw?.maxSteps))
	const maxSteps = Number.isFinite(steps) && steps !== STEPS_LEGACY_DEFAULT ? Math.min(STEPS_MAX, Math.max(STEPS_MIN, steps)) : STEPS_DEFAULT
	return { engine, models, efforts, maxSteps }
}

export interface ModelOption { value: string; label: string }

/**
 * Models each CLI accepts by name: the newest of each family, by full model id,
 * so the label says which version runs. Move these up when a new one ships.
 * A CLI that reports its own catalogue at run time can fill
 * `EngineDetection.models` instead.
 */
export const CLI_MODELS: Record<CliEngineId, ModelOption[]> = {
	'claude-code': [
		{ value: 'claude-fable-5-1', label: 'Fable 5.1' },
		{ value: 'claude-opus-5-5', label: 'Opus 5.5' },
		{ value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
		{ value: 'claude-haiku-5-5', label: 'Haiku 5.5' }
	],
}

/**
 * Short aliases an earlier version saved ("opus"), read as the model they meant
 * then: the newest of that family, which is what an alias follows.
 */
const LEGACY_MODEL_ALIASES: Record<CliEngineId, Record<string, string>> = {
	'claude-code': {
		fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5'
	}
}

/**
 * How hard each CLI can be told to think, by the value its own flag takes. An
 * engine with no entry here has no effort control. Claude Code: `--effort`.
 */
export const CLI_EFFORTS: Record<CliEngineId, ModelOption[]> = {
	'claude-code': [
		{ value: 'low', label: 'Low' },
		{ value: 'medium', label: 'Medium' },
		{ value: 'high', label: 'High' },
		{ value: 'xhigh', label: 'Extra high' },
		{ value: 'max', label: 'Max' }
	]
}

/** What the composer can pick for an engine; Gemini API has a model only. */
export const engineEfforts = (id: EngineId): ModelOption[] => (isCliEngine(id) ? CLI_EFFORTS[id] : [])

export interface GeminiTextModel { value: string; label: string; inputPerM: number }

/**
 * The Gemini models that can answer an editor chat turn: every priced model
 * except the image generators, newest first by their order in `order`, then
 * the rest by price. `inputPerM` is the text input price per 1M tokens.
 */
export function geminiTextModels(
	pricing: Record<string, { input?: { standard?: number; text?: number }; output?: { image?: number } }> | undefined,
	metadata: Record<string, { label: string }> | undefined,
	order: string[] = []
): GeminiTextModel[] {
	const models = Object.entries(pricing || {})
		// Image makers and speech-to-text models cannot hold a conversation.
		.filter(([id, p]) => p?.output?.image === undefined && !/transcribe/i.test(id))
		.map(([value, p]) => ({
			value,
			label: metadata?.[value]?.label || value,
			inputPerM: p?.input?.standard ?? p?.input?.text ?? 0
		}))
	const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i }
	return models.sort((a, b) => rank(a.value) - rank(b.value) || a.inputPerM - b.inputPerM)
}

/** The chip's text: "Claude Code · Opus · High", "Gemini API · 3 Flash Preview", or just the engine. */
export function engineChipLabel(settings: EngineSettings, geminiModelLabel?: string): string {
	const label = ENGINES[settings.engine].label
	let model: string | undefined
	let effort: string | undefined
	if (isCliEngine(settings.engine)) {
		const value = settings.models[settings.engine]
		model = value ? (CLI_MODELS[settings.engine].find((m) => m.value === value)?.label ?? value) : undefined
		const level = settings.efforts[settings.engine]
		effort = level ? (CLI_EFFORTS[settings.engine].find((o) => o.value === level)?.label ?? level) : undefined
	} else {
		model = geminiModelLabel?.replace(/^Gemini\s+/i, '')
	}
	return [label, model, effort].filter(Boolean).join(' · ')
}

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
	engine: EngineId
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

/**
 * The newest chat turn this engine ran. A CLI run's edits are agent turns inside
 * its chat turn, so only chat turns count. `exceptTurnId` leaves out the run
 * that is asking.
 */
export function latestEngineTurn(turns: PromptTurn[] | undefined, engine: EngineId, exceptTurnId?: string): PromptTurn | undefined {
	let latest: PromptTurn | undefined
	for (const turn of turns || []) {
		if (turn.id === exceptTurnId || turn.agent?.engineTurnId || turn.engine?.id !== engine) continue
		if (!latest || turn.createdAt >= latest.createdAt) latest = turn
	}
	return latest
}

/**
 * The conversation the next run continues (a CLI's own, or the one FrameFlow's
 * loop keeps for a model): the one the newest chat turn of this engine was part of. That turn decides, so clearing its id (the user's
 * "New conversation") starts a fresh one instead of reaching back to an older turn's.
 */
export function resumableSessionId(turns: PromptTurn[] | undefined, engine: EngineId, exceptTurnId?: string): string | undefined {
	return latestEngineTurn(turns, engine, exceptTurnId)?.engine?.sessionId
}

/**
 * A resumed run that died before doing anything (the CLI no longer has that
 * conversation, or it cannot be continued) is worth one fresh start. A sign-in
 * failure is not: it would fail the same way again.
 */
export function shouldRestartFresh(
	resumed: boolean,
	result: { ok: boolean; cancelled: boolean; note?: string | null; steps: unknown[]; commits: unknown[] }
): boolean {
	return resumed && !result.ok && !result.cancelled && !result.note && !result.steps.length && !result.commits.length
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

/** The planning tool the loop adds beside FrameFlow's own; it lives in the loop, not on the MCP server. */
export const PLAN_TOOL = 'update_plan'
export type PlanStatus = 'pending' | 'in_progress' | 'completed'
export interface PlanItem { step: string; status: PlanStatus }

/** "plan · 2/4 · Trim the cold open": where the agent is in its own plan. */
export function planTitle(args: Record<string, unknown>): string {
	const items = Array.isArray(args.items) ? (args.items as Partial<PlanItem>[]) : []
	if (!items.length) return 'plan'
	const done = items.filter((i) => i.status === 'completed').length
	const doing = items.find((i) => i.status === 'in_progress') ?? items.find((i) => i.status !== 'completed')
	return `plan · ${done}/${items.length}${doing?.step ? ` · ${String(doing.step).slice(0, 60)}` : ''}`
}

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
	'get_project', 'get_timeline', 'get_media', 'search_moments', 'render_frame', 'get_motion_guide', 'get_motion_kit', 'apply_ops',
	'get_sound_guide', 'list_sounds', 'suggest_cues', 'render_sound', 'analyze_audio', 'inspect_audio',
	'revert_to_version', 'export'
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
		case PLAN_TOOL: return planTitle(args)
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
	/** The CLI's own id for this conversation, from its start line. */
	sessionId?: string
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
				this.sessionId = event.sessionId ?? this.sessionId
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
	maxSteps: number
	engineLabel: string
	/** The loop gives the model a local planning tool; a CLI has none. */
	planTool?: boolean
	/** The model is billed by the token and the loop re-sends the conversation each step. */
	metered?: boolean
}

/**
 * The engine's system prompt: the baseline every agent shares, then only what
 * this sandbox needs on top. Nothing here has an opinion about the edit: the
 * user's message is the brief.
 */
export function buildEngineSystemPrompt(input: EnginePromptInput): string {
	return [
		`You are the video editor inside FrameFlow, working for the user through FrameFlow's own tools (the "frameflow" MCP server). You are running as ${input.engineLabel}.`,
		'You have no shell, no file access and no web access in this session: only FrameFlow\'s tools. Exporting is the user\'s: you cannot export.',
		'',
		FRAMEFLOW_BASELINE,
		'',
		`You have at most ${input.maxSteps} tool calls for this turn. If the user asked a question rather than for an edit, answer it without editing.`,
		...(input.metered
			? ['Every tool call sends this whole conversation to the model again, so read only what the request needs, ask for a range rather than everything, and do not read again what you already have unless you have changed it since. Older results are cleared from the conversation to save space: call the tool again if you need one back.']
			: []),
		...(input.planTool
			? ['For a request with several parts, write the steps down with update_plan first and keep it current as you go: mark a step in_progress when you start it and completed when it is done. It changes nothing in the project and does not count as a tool call.']
			: []),
		'When you are done, reply in two or three plain sentences: what you changed and where (with times), or the answer. That reply is shown to the user in the chat. No markdown headings, no lists of tool calls.'
	].join('\n')
}

export interface EngineUserPromptInput {
	prompt: string
	playheadSec: number
	/** Ids of the timeline items the user has selected. */
	selectedItemIds: string[]
	/** The scope chip's choice. */
	widen?: 'chapter' | 'full'
	/** This continues the CLI's earlier conversation about the project. */
	resuming?: boolean
}

export function buildEngineUserPrompt(input: EngineUserPromptInput): string {
	const scope = input.widen === 'full'
		? 'Scope: the whole timeline.'
		: input.widen === 'chapter'
			? `Scope: the chapter around the playhead (${clock(input.playheadSec)}).`
			: input.selectedItemIds.length
				? `Scope: the selected timeline item${input.selectedItemIds.length === 1 ? '' : 's'} (${input.selectedItemIds.join(', ')}). Change only ${input.selectedItemIds.length === 1 ? 'it' : 'them'} unless the request needs more.`
				: 'Scope: whatever the request needs.'
	// A continued conversation remembers what it saw, and the user may have edited since.
	const changed = input.resuming ? ' The project may have changed since your last message (the user can edit too), so read what you need again before relying on it.' : ''
	return `${input.prompt.trim()}\n\n---\nPlayhead: ${clock(input.playheadSec)}. ${scope}${changed}`
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
	/** Empty = no effort flag. */
	effort?: string
	/**
	 * Keep this conversation on disk so a later turn can continue it. Without
	 * it the run leaves nothing behind, which is what a one-off run wants.
	 */
	keepSession?: boolean
	/** Continue this earlier conversation (the CLI's own id, from a previous run). */
	resumeSessionId?: string
	/**
	 * The CLI's cwd, and where its config files go. The CLI files a conversation
	 * under this folder, so resuming one needs the same folder as the run that began it.
	 */
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
	const effort = input.effort?.trim()
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
					...(input.keepSession || input.resumeSessionId ? [] : ['--no-session-persistence']),
					...(input.resumeSessionId ? ['--resume', input.resumeSessionId] : []),
					'--disable-slash-commands',
					// User settings only (their model and sign-in); never a project's.
					'--setting-sources', 'user',
					'--system-prompt', input.systemPrompt,
					...(effort ? ['--effort', effort] : []),
					...(model ? ['--model', model] : [])
				]
			}
		}
	}
}
