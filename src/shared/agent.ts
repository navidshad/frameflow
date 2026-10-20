/**
 * Agent access over MCP: the decidable parts.
 *
 * An agent in the user's terminal (Claude Code, Codex, Gemini CLI) connects to
 * FrameFlow's local MCP server and reads or edits the project that is open in
 * the editor. Everything here is pure so main (the server) and the renderer
 * (Settings, the Agent tab) share one answer, and so it can be unit-tested:
 * which requests the server lets in, which tools a permission allows, how the
 * edit-ops contract is shown to an agent, and how its arguments are checked.
 */

export const AGENT_DEFAULT_PORT = 47615
/** Ports tried in order before falling back to whatever the OS hands out. */
export const AGENT_PORT_ATTEMPTS = 10
export const AGENT_MCP_PATH = '/mcp'
export const AGENT_SERVER_NAME = 'frameflow'

// ===== Permissions =====

/**
 * `read` is implied while access is on. The other three are the checkboxes on
 * the Agent access card. `html` is stored here and enforced by the motion
 * layer's tools when they exist.
 */
export type AgentPermission = 'read' | 'edit' | 'html' | 'export'

export interface AgentPermissions {
	edit: boolean
	html: boolean
	export: boolean
}

/** As drawn: editing and HTML motion on, export off until the user allows it. */
export const DEFAULT_AGENT_PERMISSIONS: AgentPermissions = { edit: true, html: true, export: false }

export function normalizePermissions(value: unknown): AgentPermissions {
	const v = (value && typeof value === 'object' ? value : {}) as Partial<AgentPermissions>
	return {
		edit: typeof v.edit === 'boolean' ? v.edit : DEFAULT_AGENT_PERMISSIONS.edit,
		html: typeof v.html === 'boolean' ? v.html : DEFAULT_AGENT_PERMISSIONS.html,
		export: typeof v.export === 'boolean' ? v.export : DEFAULT_AGENT_PERMISSIONS.export
	}
}

/**
 * Why a call is refused, written for the AGENT to relay: it names the setting
 * and tells it to ask the user, since it cannot change the setting itself.
 * Null means allowed.
 */
export function permissionRefusal(permission: AgentPermission, perms: AgentPermissions): string | null {
	if (permission === 'read') return null
	if (permission === 'edit' && !perms.edit) {
		return 'Refused: the user has not allowed agents to edit the timeline in FrameFlow ' +
			'(Settings → Agent access → "Edit the timeline"). Tell the user what you would change and ' +
			'ask them to allow editing, or to make the change themselves.'
	}
	if (permission === 'html' && !perms.html) {
		return 'Refused: the user has not allowed agents to write custom HTML motion layers ' +
			'(Settings → Agent access → "Write custom HTML motion layers"). Use a built-in template, ' +
			'or ask the user to allow it.'
	}
	if (permission === 'export' && !perms.export) {
		return 'Refused: exporting is turned off for agents. Ask the user to press Export in FrameFlow, ' +
			'or to allow "Export videos to disk" in Settings → Agent access, then try again.'
	}
	return null
}

// ===== HTTP guard (auth + DNS-rebinding protection) =====

export interface RequestHeaders {
	host?: string
	origin?: string
	authorization?: string
}

export type GuardResult = { ok: true } | { ok: false; status: 401 | 403; message: string }

/** Hosts a request may name. Anything else is a DNS-rebinding attempt or a mistake. */
export const allowedHosts = (port: number): string[] =>
	[`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]

/** Browsers send Origin on cross-site requests; CLIs send none. */
export const allowedOrigins = (port: number): string[] =>
	[`http://127.0.0.1:${port}`, `http://localhost:${port}`]

/**
 * No early exit on the first wrong character, so response time says nothing
 * about how much of a guess was right. (Length is not secret: every token has
 * the same one.)
 */
export function tokensMatch(given: string, expected: string): boolean {
	if (!expected || given.length !== expected.length) return false
	let diff = 0
	for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
	return diff === 0
}

/**
 * Host and Origin first, so a page that rebinds a hostname to 127.0.0.1 learns
 * nothing — not even whether the token was right.
 */
export function checkRequest(headers: RequestHeaders, options: { port: number; token: string }): GuardResult {
	const host = (headers.host || '').toLowerCase()
	if (!allowedHosts(options.port).includes(host)) {
		return { ok: false, status: 403, message: `Host not allowed: ${headers.host || '(none)'}` }
	}
	if (headers.origin !== undefined && !allowedOrigins(options.port).includes(headers.origin.toLowerCase())) {
		return { ok: false, status: 403, message: `Origin not allowed: ${headers.origin}` }
	}
	const match = /^Bearer\s+(.+)$/i.exec(headers.authorization || '')
	if (!match || !tokensMatch(match[1].trim(), options.token)) {
		return {
			ok: false, status: 401,
			message: 'Missing or wrong access token. Copy the connect command from FrameFlow → Settings → Agent access.'
		}
	}
	return { ok: true }
}

// ===== Tokens and clients =====

export const TOKEN_PREFIX = 'ff_'

/** "ff_••••••••••••3f9a" — enough to tell two tokens apart, not enough to use one. */
export function maskToken(token: string, dots = 12): string {
	if (!token) return ''
	return `${TOKEN_PREFIX}${'•'.repeat(dots)}${token.slice(-4)}`
}

/** What the activity feed calls a client, from MCP `initialize`'s clientInfo. */
export function displayClientName(info?: { name?: string; title?: string } | null): string {
	const raw = `${info?.name || ''} ${info?.title || ''}`
	if (/claude/i.test(raw)) return 'Claude Code'
	if (/codex/i.test(raw)) return 'Codex'
	if (/gemini/i.test(raw)) return 'Gemini CLI'
	return info?.title || info?.name || 'An agent'
}

export type AgentClientKind = 'claude' | 'codex' | 'gemini'

/**
 * The connect command for each CLI, verified against their own `--help`:
 * Claude Code and Gemini CLI take an HTTP header; Codex only reads a bearer
 * token from an environment variable it names. Gemini's default scope is the
 * project, which would write the token into the repository, so it is user.
 */
export function connectSnippet(kind: AgentClientKind, url: string, token: string): string {
	switch (kind) {
		case 'claude':
			return `claude mcp add --transport http ${AGENT_SERVER_NAME} \\\n  ${url} \\\n  --header "Authorization: Bearer ${token}"`
		case 'codex':
			return `export FRAMEFLOW_TOKEN=${token}\ncodex mcp add ${AGENT_SERVER_NAME} --url ${url} \\\n  --bearer-token-env-var FRAMEFLOW_TOKEN`
		case 'gemini':
			return `gemini mcp add --transport http --scope user ${AGENT_SERVER_NAME} \\\n  ${url} \\\n  --header "Authorization: Bearer ${token}"`
	}
}

export const CONNECT_HINTS: Record<AgentClientKind, string> = {
	claude: 'Run it once in a terminal. Then ask Claude Code something like “cut the pauses out of the team greeting in FrameFlow”.',
	codex: 'Run both lines once, and keep the export in your shell profile so Codex can read the token. Then ask Codex something like “cut the pauses out of the team greeting in FrameFlow”.',
	gemini: 'Run it once in a terminal. Then ask Gemini CLI something like “cut the pauses out of the team greeting in FrameFlow”.'
}

// ===== The edit-ops contract as JSON Schema =====

/**
 * Fields of the ops schema that steer the built-in turn runner, not the edit:
 * an agent answers in its own chat, picks its own runtime, and reads detail
 * with get_media rather than asking for a second pass.
 */
export const TURN_RUNNER_ONLY_FIELDS = ['answer', 'targetLength', 'expandRegions']

const SCHEMA_KEYS_DROPPED = new Set(['propertyOrdering', 'nullable'])

/**
 * The Gemini-flavoured schema the turn runner uses, as plain JSON Schema.
 *
 * GENERIC on purpose: it walks whatever the ops schema holds, so an op another
 * part of the app adds to EDITOR_OPS_SCHEMA reaches agents with no change
 * here. Gemini's extensions are dropped and upper-case OpenAPI type names
 * lower-cased; everything else is already JSON Schema.
 */
export function toJsonSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(toJsonSchema)
	if (!node || typeof node !== 'object') return node
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (SCHEMA_KEYS_DROPPED.has(key)) continue
		if (key === 'type' && typeof value === 'string') out.type = value.toLowerCase()
		else if (key === 'properties' && value && typeof value === 'object') {
			out.properties = Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, toJsonSchema(child)])
			)
		} else out[key] = toJsonSchema(value)
	}
	return out
}

export interface JsonSchema {
	type?: string
	description?: string
	properties?: Record<string, JsonSchema>
	required?: string[]
	items?: JsonSchema
	enum?: unknown[]
	minimum?: number
	maximum?: number
	additionalProperties?: boolean
	[key: string]: unknown
}

/**
 * apply_ops' input: the ops schema minus the turn-runner fields, closed at the
 * top level so a misspelled op name ("removeClips") is an error the agent can
 * fix rather than an edit that silently does nothing. Nested objects stay open,
 * matching how opsToDiff reads them.
 */
export function opsInputSchema(opsSchema: unknown): JsonSchema {
	const converted = toJsonSchema(opsSchema) as JsonSchema
	const properties = { ...(converted.properties || {}) }
	for (const field of TURN_RUNNER_ONLY_FIELDS) delete properties[field]
	if (properties.rationale) {
		properties.rationale = {
			...properties.rationale,
			description: 'One or two sentences on what this edit does and why. Shown to the user in FrameFlow’s activity feed and revision list.'
		}
	}
	return { type: 'object', properties, additionalProperties: false }
}

/** Op fields that change something (everything but the prose). */
export const opKeys = (ops: Record<string, unknown>): string[] =>
	Object.keys(ops).filter((key) => key !== 'rationale' && ops[key] !== undefined && ops[key] !== null)

// ===== Argument validation =====

const typeOf = (value: unknown): string => {
	if (value === null) return 'null'
	if (Array.isArray(value)) return 'array'
	if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
	return typeof value
}

const MAX_ERRORS = 20

/**
 * Checks a value against the JSON Schema subset the ops contract uses: type,
 * properties, required, additionalProperties: false, items, enum, minimum,
 * maximum. Returns readable errors with paths (`updateItems[2].id: required`),
 * empty when valid. Unknown keywords are ignored rather than failing closed —
 * the schema is ours, so an unknown keyword is a gap here, not a bad input.
 */
export function validateArgs(schema: JsonSchema, value: unknown, path = ''): string[] {
	const errors: string[] = []
	const at = (p: string) => p || '(arguments)'
	const visit = (s: JsonSchema, v: unknown, p: string) => {
		if (errors.length >= MAX_ERRORS) return
		if (s.type) {
			const actual = typeOf(v)
			const ok = s.type === actual || (s.type === 'number' && actual === 'integer')
			if (!ok) {
				errors.push(`${at(p)}: expected ${s.type}, got ${actual}`)
				return
			}
		}
		if (s.enum && !s.enum.includes(v)) {
			errors.push(`${at(p)}: must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}`)
		}
		if (typeof v === 'number') {
			if (typeof s.minimum === 'number' && v < s.minimum) errors.push(`${at(p)}: must be ≥ ${s.minimum}`)
			if (typeof s.maximum === 'number' && v > s.maximum) errors.push(`${at(p)}: must be ≤ ${s.maximum}`)
		}
		if (Array.isArray(v) && s.items) {
			v.forEach((item, i) => visit(s.items!, item, `${p}[${i}]`))
		}
		if (v && typeof v === 'object' && !Array.isArray(v)) {
			const obj = v as Record<string, unknown>
			for (const name of s.required || []) {
				if (obj[name] === undefined) errors.push(`${p ? `${p}.` : ''}${name}: required`)
			}
			const props = s.properties || {}
			for (const [name, child] of Object.entries(obj)) {
				const childPath = p ? `${p}.${name}` : name
				if (props[name]) visit(props[name], child, childPath)
				else if (s.additionalProperties === false) {
					errors.push(`${childPath}: unknown field. Allowed: ${Object.keys(props).join(', ')}`)
				}
			}
		}
	}
	visit(schema, value, path)
	return errors.slice(0, MAX_ERRORS)
}
