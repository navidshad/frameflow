import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import type { AgentActivity } from '@shared/agentFeed'
import { buildEngineSystemPrompt, ENGINES } from '@shared/engines'
import { FakeEditor } from '../mcp/fakeEditor'
import type { MotionProbe } from '../editor/vetHtml'
import { enginePermissions, runEngineTurn } from './runner'

/**
 * A CLI engine turn that writes a custom HTML page must be gated by the user's
 * "Write custom HTML motion layers" permission, like any external agent.
 *
 * This runs the REAL runner — its private MCP server, its spawned process, its
 * mcp.json and token — with a stand-in for the CLI: a small Node script that
 * reads that same mcp.json, connects the way Claude Code does, and calls
 * apply_ops with a custom page (or with a built-in template). Only the model is
 * missing; the gate under test is the runner's own.
 */

const SDK = '/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'
const root = process.cwd()

const FAKE_CLI = `#!/usr/bin/env node
import fs from 'node:fs'
const dir = process.env.SDK_DIR
const { Client } = await import(dir + 'index.js')
const { StreamableHTTPClientTransport } = await import(dir + 'streamableHttp.js')
const cfg = JSON.parse(fs.readFileSync(process.cwd() + '/mcp.json', 'utf8'))
const server = Object.values(cfg.mcpServers)[0]
const client = new Client({ name: 'claude-code', version: '2.1.0' })
await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
  requestInit: { headers: { Authorization: 'Bearer ' + process.env.FRAMEFLOW_MCP_TOKEN } }
}))
const page = '<div id="n"></div><script>frameflow.define({ duration: 3, settings: [], moments: [], seek(t) { n.textContent = String(t) } })</script>'
const args = process.env.FAKE_MODE === 'html'
  ? { rationale: 'Write a page', addMotion: [{ template: 'custom', atSec: 2, html: page }] }
  : { rationale: 'A lower third', addMotion: [{ template: 'lower-third', atSec: 2 }] }
const result = await client.callTool({ name: 'apply_ops', arguments: args })
console.log(JSON.stringify({ isError: !!result.isError, text: result.content[0].text }))
await client.close()
`

let dir: string
let cli: string

beforeAll(() => {
	dir = mkdtempSync(join(os.tmpdir(), 'frameflow-engine-html-'))
	cli = join(dir, 'fake-claude.mjs')
	writeFileSync(cli, FAKE_CLI)
	chmodSync(cli, 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function turn(mode: 'html' | 'template', htmlAllowed: boolean, probeMotion?: MotionProbe) {
	const editor = new FakeEditor()
	const activities: AgentActivity[] = []
	const result = await runEngineTurn({
		engine: 'claude-code',
		located: { id: 'claude-code', path: cli, env: { ...process.env, SDK_DIR: root + SDK, FAKE_MODE: mode } },
		prompt: 'Add a motion graphic.',
		systemPrompt: buildEngineSystemPrompt({ persona: { name: 'Editor', systemPrompt: 'Be brief.' }, maxSteps: 12, engineLabel: ENGINES['claude-code'].label }),
		maxSteps: 12,
		bridge: editor,
		turnId: 'turn-html',
		version: 'test',
		signal: new AbortController().signal,
		onActivity: (a) => activities.push(a),
		permissions: () => enginePermissions(htmlAllowed),
		probeMotion,
		timeoutMs: 60_000
	})
	const last = (tool: string) => [...activities].reverse().find((a) => a.tool === tool && a.status !== 'running')
	return { editor, result, applyOps: last('apply_ops') }
}

describe('a CLI engine turn that writes custom HTML', () => {
	it('is refused without the HTML permission, and nothing is committed', async () => {
		const { editor, result, applyOps } = await turn('html', false)
		expect(result.exitCode).toBe(0)
		expect(applyOps).toMatchObject({ status: 'refused', detail: 'refused · HTML motion is off' })
		expect(editor.commits).toHaveLength(0)
		expect(result.commits).toHaveLength(0)
		expect(editor.doc.timeline.some((i) => i.motion)).toBe(false)
	}, 90_000)

	it('goes through with the permission, as a labelled revision carrying the page', async () => {
		const { editor, result, applyOps } = await turn('html', true)
		expect(applyOps).toMatchObject({ status: 'done' })
		expect(result.commits).toHaveLength(1)
		const layer = editor.doc.timeline.find((i) => i.motion)!
		expect(layer.motion!.html).toContain('frameflow.define')
		expect(layer.motion!.passed!.html).toBe(layer.motion!.html)
		expect(editor.commits[0].turn.agent).toMatchObject({ name: 'Claude Code', engineTurnId: 'turn-html' })
	}, 90_000)

	it('is checked before it lands: a page the probe rejects is not applied, permission or not', async () => {
		const seen: string[] = []
		const { editor, result, applyOps } = await turn('html', true, async (input) => {
			seen.push(input.html)
			return { determinism: 'fail', differsAt: 1.5 }
		})
		expect(seen).toHaveLength(1)
		expect(seen[0]).toContain('frameflow.define')
		expect(applyOps).toMatchObject({ status: 'error' })
		expect(applyOps!.detail).toMatch(/Nothing was changed/)
		expect(editor.commits).toHaveLength(0)
		expect(result.commits).toHaveLength(0)
		expect(editor.doc.timeline.some((i) => i.motion)).toBe(false)
	}, 90_000)

	it('still places a built-in template with the permission off — only pages are gated', async () => {
		const { editor, applyOps } = await turn('template', false)
		expect(applyOps).toMatchObject({ status: 'done' })
		expect(editor.doc.timeline.find((i) => i.motion)!.motion!.template).toBe('lower-third')
	}, 90_000)

	it('says no by default: an engine run that is not told about the setting cannot write pages', () => {
		expect(enginePermissions(false)).toEqual({ edit: true, html: false, export: false, sound: true, generate: false })
		expect(enginePermissions(true)).toEqual({ edit: true, html: true, export: false, sound: true, generate: false })
	})
})
