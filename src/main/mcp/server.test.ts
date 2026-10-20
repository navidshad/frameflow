import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DEFAULT_AGENT_PERMISSIONS, type AgentPermissions } from '@shared/agent'
import type { AgentActivity } from '@shared/agentFeed'
import { AgentServer, type AgentServerEvent } from './server'
import { FakeEditor, PIXEL, TOKEN } from './fakeEditor'

/**
 * The real server on an ephemeral port, driven through the SDK's own client —
 * the same path Claude Code, Codex and Gemini CLI take. Only the editor is
 * fake: a document in memory that applies diffs the way the renderer does.
 */

describe('AgentServer over Streamable HTTP', () => {
	let editor: FakeEditor
	let server: AgentServer
	let permissions: AgentPermissions
	/** Stands in for the hidden-window probe; the real one is tested in Electron. */
	let probe: (input: any) => Promise<any>
	let events: AgentServerEvent[]
	let url: URL
	const clients: Client[] = []

	const connect = async (token = TOKEN, name = 'claude-code') => {
		const client = new Client({ name, version: '2.1.0' })
		const transport = new StreamableHTTPClientTransport(url, {
			requestInit: { headers: { Authorization: `Bearer ${token}` } }
		})
		await client.connect(transport)
		clients.push(client)
		return client
	}

	const text = (result: any) => JSON.parse(result.content.find((c: any) => c.type === 'text').text)

	beforeEach(async () => {
		editor = new FakeEditor()
		permissions = { ...DEFAULT_AGENT_PERMISSIONS }
		probe = async () => ({ determinism: 'pass' })
		events = []
		server = new AgentServer({
			bridge: editor, token: () => TOKEN, permissions: () => permissions, version: 'test',
			probeMotion: (input) => probe(input),
			onEvent: (e) => events.push(e)
		})
		const port = await server.start(0)
		url = new URL(`http://127.0.0.1:${port}/mcp`)
	})

	afterEach(async () => {
		await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)))
		await server.stop()
	})

	it('binds loopback only', () => {
		expect(server.running).toBe(true)
		expect(url.hostname).toBe('127.0.0.1')
	})

	it('rejects a client without the token', async () => {
		await expect(connect('ff_wrong')).rejects.toThrow()
		const raw = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
		})
		expect(raw.status).toBe(401)
		expect(server.listSessions()).toHaveLength(0)
	})

	it('rejects a rebound Host and a foreign Origin even with the token', async () => {
		const headers = {
			'content-type': 'application/json', accept: 'application/json, text/event-stream',
			authorization: `Bearer ${TOKEN}`
		}
		const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
		const http = await import('node:http')
		const status = await new Promise<number>((resolve, reject) => {
			const req = http.request({
				host: '127.0.0.1', port: Number(url.port), path: '/mcp', method: 'POST',
				headers: { ...headers, host: `attacker.example:${url.port}` }
			}, (res) => { res.resume(); resolve(res.statusCode!) })
			req.on('error', reject)
			req.end(body)
		})
		expect(status).toBe(403)
		const foreign = await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body })
		expect(foreign.status).toBe(403)
	})

	it('lists the tools with the ops contract as apply_ops input', async () => {
		const client = await connect()
		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name)).toEqual([
			'get_project', 'get_timeline', 'get_media', 'search_moments', 'render_frame',
			'apply_ops', 'revert_to_version', 'export'
		])
		const apply = tools.find((t) => t.name === 'apply_ops')!
		expect(Object.keys(apply.inputSchema.properties || {})).toContain('removeRanges')
		expect(Object.keys(apply.inputSchema.properties || {})).not.toContain('expandRegions')
		for (const tool of tools) expect(tool.description!.length).toBeGreaterThan(80)
	})

	it('knows each client by name, concurrently', async () => {
		await connect(TOKEN, 'claude-code')
		await connect(TOKEN, 'codex-mcp-client')
		const names = server.listSessions().map((s) => s.clientName).sort()
		expect(names).toEqual(['Claude Code', 'Codex'])
	})

	it('reads the live project, timeline, media and moments', async () => {
		const client = await connect()
		const project = text(await client.callTool({ name: 'get_project', arguments: {} }))
		expect(project.project.title).toBe('BytePets pre-pitch')
		expect(project.media[0]).toMatchObject({ id: 'team', scenes: 3, hasTranscript: true })
		expect(project.permissions).toEqual({ read: true, editTimeline: true, writeHtmlMotion: true, exportVideos: false })
		expect(project.catalog.transitions).toContain('fade')

		const timeline = text(await client.callTool({ name: 'get_timeline', arguments: {} }))
		expect(timeline.items).toHaveLength(1)
		expect(timeline.items[0]).toMatchObject({ id: 'i1', asset: 'greeting_team.mp4', endSec: 30 })

		const media = text(await client.callTool({ name: 'get_media', arguments: { asset: 'greeting_team' } }))
		expect(media.transcript).toHaveLength(2)
		expect(media.scenes[2]).toMatchObject({ scene: 3, seen: expect.stringMatching(/bar chart/) })

		const found = text(await client.callTool({ name: 'search_moments', arguments: { query: 'how much faster' } }))
		expect(found.hits[0]).toMatchObject({ asset: 'team', sourceStart: 21, timelineSec: [21] })
	})

	it('says plainly when no project is open', async () => {
		editor.open = false
		const client = await connect()
		const result: any = await client.callTool({ name: 'get_timeline', arguments: {} })
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toMatch(/No project is open/)
	})

	it('applies ops as a labelled AI turn and reports the revision', async () => {
		const client = await connect()
		const result: any = await client.callTool({
			name: 'apply_ops',
			arguments: { rationale: 'Cut the pause before the answer', removeRanges: [{ fromSec: 10, toSec: 12.4 }] }
		})
		expect(result.isError).toBeFalsy()
		const body = text(result)
		expect(body.revision).toBe('V1')
		expect(body.undo).toMatch(/revert_to_version 0/)

		// Down the existing path: one completed turn, labelled with the client
		expect(editor.commits).toHaveLength(1)
		const turn = editor.commits[0].turn
		expect(turn.status).toBe('completed')
		expect(turn.agent).toMatchObject({ name: 'Claude Code' })
		expect(turn.rationale).toBe('Cut the pause before the answer')
		// The clip was split around the cut: 0–10 kept, 12.4–30 kept
		expect(editor.doc.timeline.map((i) => [i.in, i.out])).toEqual([[0, 10], [12.4, 30]])

		// And the feed got a finished row with the version chip
		const rows = events.filter((e): e is { type: 'activity'; activity: AgentActivity } => e.type === 'activity')
		const last = rows[rows.length - 1].activity
		expect(last).toMatchObject({ tool: 'apply_ops', status: 'done', detail: 'Cut the pause before the answer' })
		expect(last.chips).toEqual([{ text: 'V1', tone: 'violet' }, { text: '−1 range', tone: 'red' }])
	})

	it('rejects malformed ops without touching the editor', async () => {
		const client = await connect()
		const result: any = await client.callTool({ name: 'apply_ops', arguments: { removeClips: ['i1'] } })
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toMatch(/removeClips: unknown field/)
		expect(editor.commits).toHaveLength(0)
	})

	it('gates edits and export on the Agent access permissions', async () => {
		const client = await connect()
		const exported: any = await client.callTool({ name: 'export', arguments: {} })
		expect(exported.isError).toBe(true)
		expect(exported.content[0].text).toMatch(/Ask the user to press Export/)
		expect(editor.exports).toBe(0)

		permissions = { ...permissions, export: true, edit: false }
		expect((await client.callTool({ name: 'export', arguments: {} }) as any).isError).toBeFalsy()
		expect(editor.exports).toBe(1)
		const edit: any = await client.callTool({ name: 'apply_ops', arguments: { closeGaps: true } })
		expect(edit.isError).toBe(true)
		expect(edit.content[0].text).toMatch(/Edit the timeline/)
		const refused = events.filter((e) => e.type === 'activity' && e.activity.status === 'refused')
		expect(refused).toHaveLength(2)
	})

	describe('custom HTML motion layers', () => {
		const PAGE = [
			'<div id="n"></div>',
			'<script>frameflow.define({ duration: 3, settings: [{ key: "value", type: "number", default: 3 }],',
			'  moments: [{ name: "in", duration: 0.5 }, { name: "hold", duration: 2, flex: true }, { name: "out", duration: 0.5 }],',
			'  seek(t, s) { n.textContent = String(s.value) } })</script>'
		].join('\n')
		const custom = { addMotion: [{ template: 'custom', atSec: 4, html: PAGE, label: 'Triage stat' }] }

		it('refuses a page without the “Write custom HTML motion layers” permission, and changes nothing', async () => {
			permissions = { ...permissions, html: false }
			const client = await connect()
			const refused: any = await client.callTool({ name: 'apply_ops', arguments: custom })
			expect(refused.isError).toBe(true)
			expect(refused.content[0].text).toMatch(/not allowed agents to write custom HTML motion layers/)
			expect(refused.content[0].text).toMatch(/Use a built-in template/)
			expect(editor.commits).toHaveLength(0)
			const row = events.filter((e) => e.type === 'activity' && e.activity.status === 'refused').pop() as any
			expect(row.activity.detail).toBe('refused · HTML motion is off')

			// A rewrite of an existing layer is the same permission.
			const update: any = await client.callTool({ name: 'apply_ops', arguments: { updateMotion: [{ id: 'x', html: PAGE }] } })
			expect(update.isError).toBe(true)
			expect(update.content[0].text).toMatch(/custom HTML motion layers/)
			expect(editor.commits).toHaveLength(0)
		})

		it('still lets the same agent place a built-in template with HTML off', async () => {
			permissions = { ...permissions, html: false }
			const client = await connect()
			const ok: any = await client.callTool({
				name: 'apply_ops',
				arguments: { addMotion: [{ template: 'lower-third', atSec: 2, settings: [{ key: 'name', value: 'Sara' }] }] }
			})
			expect(ok.isError).toBeFalsy()
			expect(editor.doc.timeline.some((i) => i.motion?.template === 'lower-third')).toBe(true)
		})

		it('writes the page with the permission, labelled with the client and its turn', async () => {
			const client = await connect()
			const ok: any = await client.callTool({ name: 'apply_ops', arguments: custom })
			expect(ok.isError).toBeFalsy()
			const layer = editor.doc.timeline.find((i) => i.motion)!
			expect(layer.motion!.html).toBe(PAGE)
			expect(layer.motion!.passed!.html).toBe(PAGE)
			expect(layer.motion!.author).toEqual({ by: 'Claude Code', turnId: editor.commits[0].turn.id })
		})

		it('rejects a page that fails the lint, changes nothing, and says which line', async () => {
			const client = await connect()
			const result: any = await client.callTool({
				name: 'apply_ops',
				arguments: { addMotion: [{ template: 'custom', atSec: 4, html: PAGE.replace('String(s.value)', 'String(Date.now())') }] }
			})
			expect(result.isError).toBe(true)
			const message = result.content[0].text
			expect(message).toMatch(/Nothing was changed/)
			expect(message).toMatch(/addMotion\[0\] \(custom page\) rejected, nothing was added: line 4/)
			expect(message).toMatch(/wall clock/)
			expect(editor.commits).toHaveLength(0)
			expect(editor.doc.timeline.some((i) => i.motion)).toBe(false)
		})

		it('rejects a page that lints clean but fails the probe: the earlier page stays, and the agent is told why', async () => {
			const client = await connect()
			await client.callTool({ name: 'apply_ops', arguments: { addMotion: [{ template: 'custom', atSec: 4, html: PAGE }] } })
			const layer = editor.doc.timeline.find((i) => i.motion)!
			const before = JSON.stringify(layer.motion)
			const commits = editor.commits.length

			// Clean as far as the text goes — but drawn twice, it differs.
			const STATEFUL = PAGE.replace('seek(t, s) { n.textContent = String(s.value) }', 'seek(t, s) { n.textContent = String((window.k = (window.k || 0) + 1)) }')
			expect(STATEFUL).not.toBe(PAGE)
			probe = async (input) => (input.html === STATEFUL ? { determinism: 'fail', differsAt: 1.5 } : { determinism: 'pass' })
			const result: any = await client.callTool({
				name: 'apply_ops',
				arguments: { rationale: 'Count the frames', updateMotion: [{ id: layer.id, html: STATEFUL }] }
			})

			expect(result.isError).toBe(true)
			const message = result.content[0].text
			expect(message).toMatch(new RegExp(`updateMotion ${layer.id} rejected, the layer keeps its previous page`))
			expect(message).toMatch(/drawing the same frame twice gave different pixels at t = 1\.50s/)
			expect(message).toMatch(/pure function of t and settings/)
			// Nothing reached the editor: no new turn, and the earlier page is untouched.
			expect(editor.commits).toHaveLength(commits)
			expect(JSON.stringify(editor.doc.timeline.find((i) => i.id === layer.id)!.motion)).toBe(before)
			expect(editor.doc.timeline.find((i) => i.id === layer.id)!.motion!.html).toBe(PAGE)
		})

		it('hands the probe the page, its definition and the frame', async () => {
			const seen: any[] = []
			probe = async (input) => { seen.push(input); return { determinism: 'pass' } }
			const client = await connect()
			await client.callTool({ name: 'apply_ops', arguments: { addMotion: [{ template: 'custom', atSec: 4, html: PAGE }] } })
			expect(seen).toHaveLength(1)
			expect(seen[0].html).toBe(PAGE)
			expect(seen[0].definition.duration).toBe(3)
			expect(seen[0].frame).toEqual({ width: 1920, height: 1080 })
		})

		it('reports a page that throws when it runs', async () => {
			probe = async () => ({ determinism: 'fail', error: 'thisFunctionDoesNotExist is not defined' })
			const client = await connect()
			const result: any = await client.callTool({ name: 'apply_ops', arguments: { addMotion: [{ template: 'custom', atSec: 4, html: PAGE }] } })
			expect(result.isError).toBe(true)
			expect(result.content[0].text).toMatch(/the page throws when it runs: thisFunctionDoesNotExist is not defined/)
		})

		it('applies the rest of a call when only one page is rejected, and lists the rejection', async () => {
			probe = async () => ({ determinism: 'fail', differsAt: 0 })
			const client = await connect()
			const result: any = await client.callTool({
				name: 'apply_ops',
				arguments: { addMotion: [{ template: 'lower-third', atSec: 2 }, { template: 'custom', atSec: 4, html: PAGE }] }
			})
			expect(result.isError).toBeFalsy()
			const body = text(result)
			expect(body.droppedOps.join(' ')).toMatch(/addMotion\[1\] \(custom page\) rejected/)
			const layers = editor.doc.timeline.filter((i) => i.motion)
			expect(layers.map((l) => l.motion!.template)).toEqual(['lower-third'])
		})

		it('lists the motion templates in get_project, with saved ones marked', async () => {
			const client = await connect()
			const project = text(await client.callTool({ name: 'get_project', arguments: {} }))
			expect(project.catalog.motionTemplates.map((t: any) => t.id)).toContain('lower-third')
			expect(project.catalog.motionTemplates.find((t: any) => t.id === 'lower-third').settings).toContain('name')
		})
	})

	it('returns an image from render_frame and reverts by V number', async () => {
		const client = await connect()
		const frame: any = await client.callTool({ name: 'render_frame', arguments: { timeSec: 5, note: 'Is the chart legible?' } })
		expect(frame.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PIXEL })
		await client.callTool({ name: 'apply_ops', arguments: { closeGaps: true, removeItemIds: ['i1'] } })
		const back = text(await client.callTool({ name: 'revert_to_version', arguments: { version: 0 } }))
		expect(back.current).toBe('V0')
		expect(editor.current).toBe('r0')
	})

	it('drops every session when told to, and refuses its next call', async () => {
		const client = await connect()
		const [session] = server.listSessions()
		await server.disconnect(session.id)
		expect(server.listSessions()).toHaveLength(0)
		expect(events.some((e) => e.type === 'session-closed')).toBe(true)
		await expect(client.callTool({ name: 'get_project', arguments: {} })).rejects.toThrow()
	})

	it('closes a session that has gone quiet (CLIs exit without saying goodbye)', async () => {
		const quiet = new AgentServer({
			bridge: editor, token: () => TOKEN, permissions: () => permissions, version: 'test',
			idleTimeoutMs: 150, sweepEveryMs: 50
		})
		const port = await quiet.start(0)
		const client = new Client({ name: 'claude-code', version: '1' })
		await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
		}))
		expect(quiet.listSessions()).toHaveLength(1)
		await new Promise((r) => setTimeout(r, 400))
		expect(quiet.listSessions()).toHaveLength(0)
		await client.close().catch(() => undefined)
		await quiet.stop()
	})

	it('falls back to another port when the preferred one is taken', async () => {
		const other = new AgentServer({ bridge: editor, token: () => TOKEN, permissions: () => permissions, version: 'test' })
		const port = await other.start(Number(url.port))
		expect(port).not.toBe(Number(url.port))
		await other.stop()
	})
})
