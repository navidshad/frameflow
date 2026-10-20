import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Clip, EditorDocument, MediaAsset, TimelineItem } from '@shared/types'
import { applyTimelineDiff } from '@shared/timeline'
import { DEFAULT_AGENT_PERMISSIONS, type AgentPermissions } from '@shared/agent'
import type { AgentActivity } from '@shared/agentFeed'
import { AgentServer, type AgentServerEvent } from './server'
import type { EditorBridge, LiveProject, RevisionSummary, TurnCommit } from './bridge'

/**
 * The real server on an ephemeral port, driven through the SDK's own client —
 * the same path Claude Code, Codex and Gemini CLI take. Only the editor is
 * fake: a document in memory that applies diffs the way the renderer does.
 */

const TOKEN = 'ff_test0123456789abcdef0123456789ab'

function makeAsset(): MediaAsset {
	const clips: Clip[] = [0, 1, 2].map((i) => ({
		id: `team-c${i + 1}`, sourceAssetId: 'team', index: i + 1,
		in: i * 10, out: i * 10 + 10, duration: 10,
		visual: i === 2 ? 'A bar chart showing triage three times faster' : 'Two people talking',
		text: `line ${i + 1}`, selected: false
	}))
	return {
		id: 'team', kind: 'video', name: 'greeting_team.mp4', originalPath: '/tmp/greeting_team.mp4',
		metadata: { duration: 30 } as MediaAsset['metadata'],
		preprocessing: { transcriptPath: '/tmp/team.json' } as MediaAsset['preprocessing'],
		clips, createdAt: 0
	}
}

function makeDoc(): EditorDocument {
	const item: TimelineItem = {
		id: 'i1', trackId: 'v1', sourceAssetId: 'team', timelineStart: 0,
		in: 0, out: 30, speed: 1, preservePitch: true, duration: 30, label: 'greeting_team'
	}
	return {
		schemaVersion: 2,
		media: [makeAsset()],
		tracks: [{ id: 'v1', kind: 'video', name: 'V1', order: 0, muted: false, locked: false, hidden: false, height: 64 }],
		timeline: [item],
		timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 30 },
		activePersonaId: 'podcast-editor',
		turns: [],
		historyRef: { currentStepId: 'step-0', stepCount: 0 }
	}
}

/** A 1×1 PNG, enough to prove an image travels. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

class FakeEditor implements EditorBridge {
	doc = makeDoc()
	open = true
	revisions: RevisionSummary[] = [{ id: 'r0', seq: 0, label: 'Original', origin: 'init', parentId: null, createdAt: 0 }]
	current = 'r0'
	commits: TurnCommit[] = []
	exports = 0

	async getLiveProject(): Promise<LiveProject | null> {
		if (!this.open) return null
		return {
			threadId: 't1', title: 'BytePets pre-pitch', doc: JSON.parse(JSON.stringify(this.doc)),
			revisions: [...this.revisions], currentRevisionId: this.current, playheadSec: 0
		}
	}

	async commitTurn(commit: TurnCommit) {
		this.commits.push(commit)
		const state = { tracks: this.doc.tracks, timeline: this.doc.timeline }
		const result = applyTimelineDiff(state, commit.turn.diff!, this.doc.media)
		// It replaces arrays rather than mutating them, as the store expects
		this.doc.tracks = state.tracks
		this.doc.timeline = state.timeline
		const seq = this.revisions.length
		const rev = { id: `r${seq}`, seq, label: commit.turn.agent!.name, origin: 'ai' as const, parentId: this.current, createdAt: Date.now() }
		this.revisions.push(rev)
		const parent = this.current
		this.current = rev.id
		return {
			ok: true as const, revisionId: rev.id, revisionSeq: seq, parentRevisionId: parent,
			counts: {
				added: commit.turn.diff!.addItems?.length || 0,
				removed: commit.turn.diff!.removeItemIds?.length || 0,
				updated: commit.turn.diff!.updateItems?.length || 0,
				markers: commit.addMarkers?.length || 0
			},
			pruned: result.errors
		}
	}

	async readTranscripts(_project: LiveProject, ids: string[]) {
		return ids.includes('team')
			? { team: [{ start: 21, end: 24, text: 'How much faster is triage now?' }, { start: 24, end: 27, text: 'Three times faster.' }] }
			: {}
	}

	async renderFrame() {
		return { data: PIXEL, mimeType: 'image/png', thumbnail: `data:image/png;base64,${PIXEL}` }
	}

	async switchRevision(id: string) {
		this.current = id
		return { ok: true as const }
	}

	async startExport() {
		this.exports++
		return { ok: true as const, detail: 'Export started.' }
	}
}

describe('AgentServer over Streamable HTTP', () => {
	let editor: FakeEditor
	let server: AgentServer
	let permissions: AgentPermissions
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
		events = []
		server = new AgentServer({
			bridge: editor, token: () => TOKEN, permissions: () => permissions, version: 'test',
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

	it('falls back to another port when the preferred one is taken', async () => {
		const other = new AgentServer({ bridge: editor, token: () => TOKEN, permissions: () => permissions, version: 'test' })
		const port = await other.start(Number(url.port))
		expect(port).not.toBe(Number(url.port))
		await other.stop()
	})
})
