import { describe, expect, it } from 'vitest'
import {
	checkRequest, connectSnippet, DEFAULT_AGENT_PERMISSIONS, displayClientName, maskToken,
	normalizePermissions, opKeys, opsInputSchema, permissionRefusal, toJsonSchema, tokensMatch,
	TURN_RUNNER_ONLY_FIELDS, validateArgs, type JsonSchema
} from './agent'
import { EDITOR_OPS_SCHEMA } from '../main/editor/ops'

const PORT = 47615
const TOKEN = 'ff_0123456789abcdef0123456789abcdef'
const good = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` }

describe('checkRequest', () => {
	it('lets in a local request carrying the token', () => {
		expect(checkRequest(good, { port: PORT, token: TOKEN })).toEqual({ ok: true })
		expect(checkRequest({ ...good, host: `localhost:${PORT}` }, { port: PORT, token: TOKEN }).ok).toBe(true)
	})

	it('rejects a missing or wrong token with 401', () => {
		const none = checkRequest({ host: good.host }, { port: PORT, token: TOKEN })
		expect(none).toMatchObject({ ok: false, status: 401 })
		const wrong = checkRequest({ ...good, authorization: `Bearer ${TOKEN.slice(0, -1)}x` }, { port: PORT, token: TOKEN })
		expect(wrong).toMatchObject({ ok: false, status: 401 })
		const basic = checkRequest({ ...good, authorization: `Basic ${TOKEN}` }, { port: PORT, token: TOKEN })
		expect(basic).toMatchObject({ ok: false, status: 401 })
	})

	it('rejects a rebound hostname before looking at the token', () => {
		const result = checkRequest({ ...good, host: `evil.example:${PORT}` }, { port: PORT, token: TOKEN })
		expect(result).toMatchObject({ ok: false, status: 403 })
		// Right host, wrong port: a different service's name for this one
		expect(checkRequest({ ...good, host: '127.0.0.1:80' }, { port: PORT, token: TOKEN }).ok).toBe(false)
	})

	it('rejects a foreign browser Origin but allows none (CLIs send none)', () => {
		expect(checkRequest({ ...good, origin: 'https://evil.example' }, { port: PORT, token: TOKEN }))
			.toMatchObject({ ok: false, status: 403 })
		expect(checkRequest({ ...good, origin: 'null' }, { port: PORT, token: TOKEN }).ok).toBe(false)
		expect(checkRequest({ ...good, origin: `http://localhost:${PORT}` }, { port: PORT, token: TOKEN }).ok).toBe(true)
	})

	it('never accepts an empty expected token', () => {
		expect(tokensMatch('', '')).toBe(false)
		expect(checkRequest({ host: good.host, authorization: 'Bearer ' }, { port: PORT, token: '' }).ok).toBe(false)
	})
})

describe('permissions', () => {
	it('defaults to edit, html and the synth on, export off', () => {
		expect(DEFAULT_AGENT_PERMISSIONS).toEqual({ edit: true, html: true, export: false, sound: true, generate: false })
		expect(normalizePermissions(undefined)).toEqual(DEFAULT_AGENT_PERMISSIONS)
		expect(normalizePermissions({ export: true, edit: 'yes' })).toEqual({ edit: true, html: true, export: true, sound: true, generate: false })
		// A settings file from before sound existed gets the default.
		expect(normalizePermissions({ edit: false, html: false, export: true })).toMatchObject({ sound: true })
	})

	it('always allows reading', () => {
		expect(permissionRefusal('read', { edit: false, html: false, export: false, sound: false, generate: false })).toBeNull()
	})

	it('refuses export by default, telling the agent to ask the user', () => {
		const refusal = permissionRefusal('export', DEFAULT_AGENT_PERMISSIONS)
		expect(refusal).toMatch(/Refused/)
		expect(refusal).toMatch(/Ask the user to press Export/)
		expect(permissionRefusal('export', { ...DEFAULT_AGENT_PERMISSIONS, export: true })).toBeNull()
	})

	it('refuses edits and HTML when they are switched off', () => {
		expect(permissionRefusal('edit', { edit: false, html: true, export: false, sound: true, generate: false })).toMatch(/Edit the timeline/)
		expect(permissionRefusal('html', { edit: true, html: false, export: false, sound: true, generate: false })).toMatch(/HTML motion/)
	})

	it('keeps anything that costs money off until the user turns it on, and says so', () => {
		expect(DEFAULT_AGENT_PERMISSIONS.generate).toBe(false)
		const refusal = permissionRefusal('generate', DEFAULT_AGENT_PERMISSIONS)!
		expect(refusal).toMatch(/costs money/)
		expect(refusal).toMatch(/Generate audio with a provider/)
		expect(refusal).toMatch(/built-in synth/)
		expect(permissionRefusal('generate', { ...DEFAULT_AGENT_PERMISSIONS, generate: true })).toBeNull()
	})

	it('refuses the synth when it is switched off, and says where to turn it on', () => {
		const refusal = permissionRefusal('sound', { ...DEFAULT_AGENT_PERMISSIONS, sound: false })
		expect(refusal).toMatch(/built-in synth/)
		expect(refusal).toMatch(/Agent access/)
		expect(permissionRefusal('sound', DEFAULT_AGENT_PERMISSIONS)).toBeNull()
	})
})

describe('tokens and clients', () => {
	it('masks all but the last four characters', () => {
		expect(maskToken(TOKEN)).toBe('ff_••••••••••••cdef')
		expect(maskToken(TOKEN, 4)).toBe('ff_••••cdef')
		expect(maskToken('')).toBe('')
	})

	it('names the two CLIs from their clientInfo', () => {
		expect(displayClientName({ name: 'claude-code' })).toBe('Claude Code')
		expect(displayClientName({ name: 'codex-mcp-client' })).toBe('Codex')
		expect(displayClientName({ name: 'my-tool', title: 'My Tool' })).toBe('My Tool')
		expect(displayClientName(undefined)).toBe('An agent')
	})

	it('writes each CLI its own connect command', () => {
		const url = `http://127.0.0.1:${PORT}/mcp`
		expect(connectSnippet('claude', url, TOKEN)).toBe(
			`claude mcp add --transport http frameflow \\\n  ${url} \\\n  --header "Authorization: Bearer ${TOKEN}"`
		)
		// Codex has no header flag for HTTP servers: it reads a named env var
		const codex = connectSnippet('codex', url, TOKEN)
		expect(codex).toContain(`export FRAMEFLOW_TOKEN=${TOKEN}`)
		expect(codex).toContain('--bearer-token-env-var FRAMEFLOW_TOKEN')
		expect(codex).toContain(`--url ${url}`)
	})
})

describe('opsInputSchema', () => {
	const schema = opsInputSchema(EDITOR_OPS_SCHEMA)

	it('carries every editing op from the real ops schema, generically', () => {
		const source = Object.keys(EDITOR_OPS_SCHEMA.properties)
		const expected = source.filter((k) => !TURN_RUNNER_ONLY_FIELDS.includes(k))
		expect(Object.keys(schema.properties!).sort()).toEqual(expected.sort())
		expect(schema.properties!.removeRanges.items!.required).toEqual(['fromSec', 'toSec'])
	})

	it('drops the turn-runner-only fields and closes the top level', () => {
		for (const field of TURN_RUNNER_ONLY_FIELDS) expect(schema.properties![field]).toBeUndefined()
		expect(schema.additionalProperties).toBe(false)
		expect(schema.type).toBe('object')
	})

	it('passes an op added to the source schema straight through', () => {
		const extended = {
			...EDITOR_OPS_SCHEMA,
			properties: {
				...EDITOR_OPS_SCHEMA.properties,
				addMotion: { type: 'ARRAY', items: { type: 'OBJECT', properties: { template: { type: 'STRING' } }, required: ['template'] } }
			}
		}
		const out = opsInputSchema(extended)
		expect(out.properties!.addMotion).toEqual({
			type: 'array', items: { type: 'object', properties: { template: { type: 'string' } }, required: ['template'] }
		})
	})

	it('strips Gemini-only keywords', () => {
		const out = toJsonSchema({ type: 'OBJECT', propertyOrdering: ['a'], nullable: true, properties: { a: { type: 'NUMBER' } } })
		expect(out).toEqual({ type: 'object', properties: { a: { type: 'number' } } })
	})
})

describe('validateArgs', () => {
	const schema = opsInputSchema(EDITOR_OPS_SCHEMA)

	it('accepts a well-formed edit', () => {
		expect(validateArgs(schema, {
			rationale: 'Cut a pause',
			removeRanges: [{ fromSec: 3, toSec: 5.4 }],
			updateItems: [{ id: 'a', speed: 1.2, framing: { mode: 'fill' } }]
		})).toEqual([])
	})

	it('names the path of every problem', () => {
		const errors = validateArgs(schema, {
			removeRanges: [{ fromSec: '3' }],
			updateItems: [{ speed: 2, framing: { mode: 'stretch' } }],
			removeClips: ['x']
		})
		expect(errors).toContain('removeRanges[0].fromSec: expected number, got string')
		expect(errors).toContain('removeRanges[0].toSec: required')
		expect(errors).toContain('updateItems[0].id: required')
		expect(errors.some((e) => e.startsWith('updateItems[0].framing.mode: must be one of'))).toBe(true)
		expect(errors.some((e) => e.startsWith('removeClips: unknown field'))).toBe(true)
	})

	it('checks integer bounds and tolerates integers where numbers are wanted', () => {
		const s: JsonSchema = { type: 'object', properties: { n: { type: 'integer', minimum: 0 }, x: { type: 'number' } } }
		expect(validateArgs(s, { n: 1.5 })).toEqual(['n: expected integer, got number'])
		expect(validateArgs(s, { n: -1 })).toEqual(['n: must be ≥ 0'])
		expect(validateArgs(s, { x: 3 })).toEqual([])
		expect(validateArgs(s, null)).toEqual(['(arguments): expected object, got null'])
	})

	it('caps the error list', () => {
		const many = { removeRanges: Array.from({ length: 50 }, () => ({})) }
		expect(validateArgs(schema, many).length).toBe(20)
	})
})

describe('opKeys', () => {
	it('lists the ops that change something, not the prose', () => {
		expect(opKeys({ rationale: 'x', removeRanges: [], captions: false, closeGaps: undefined })).toEqual(['removeRanges', 'captions'])
	})
})
