import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DEFAULT_AGENT_PERMISSIONS, type AgentPermissions } from '@shared/agent'
import type { AgentActivity } from '@shared/agentFeed'
import { AgentServer, type AgentServerEvent } from './server'
import { FakeEditor, PIXEL, TOKEN } from './fakeEditor'

/**
 * The real server on an ephemeral port, driven through the SDK's own client —
 * the same path Claude Code and Codex take. Only the editor is
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

	it('serves the motion guide: the contract, the craft rules and how to make a field keyframable', async () => {
		const client = await connect()
		const result = await client.callTool({ name: 'get_motion_guide', arguments: {} }) as any
		const guide = result.content.find((c: any) => c.type === 'text').text as string
		expect(guide).toMatch(/MOTION PAGE CONTRACT/)
		expect(guide).toMatch(/Fill the frame/)
		expect(guide).toMatch(/animate: true/)
		const { tools } = await client.listTools()
		expect(tools.find((t) => t.name === 'apply_ops')!.description).toMatch(/get_motion_guide/)
	})

	it('lists the tools with the ops contract as apply_ops input', async () => {
		const client = await connect()
		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name)).toEqual([
			'get_project', 'get_timeline', 'get_media', 'search_moments', 'render_frame', 'get_motion_guide', 'get_motion_kit',
			'get_sound_guide', 'list_sounds', 'suggest_cues', 'render_sound', 'analyze_audio', 'generate_audio',
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
		expect(project.permissions).toEqual({ read: true, editTimeline: true, writeHtmlMotion: true, exportVideos: false, makeSounds: true })
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


	// ===== Sound =====

	/** A lower third on a motion track, so there is a moment for a sound to follow. */
	const withLowerThird = () => {
		editor.doc.tracks.unshift({ id: 'm1', kind: 'video', name: 'M1', order: 2, muted: false, locked: false, hidden: false, height: 64 })
		editor.doc.timeline.push({
			id: 'lt', trackId: 'm1', sourceAssetId: '', timelineStart: 3, in: 0, out: 4, speed: 1, preservePitch: true,
			duration: 4, label: 'Lower third', motion: { template: 'lower-third' }
		})
	}

	it('teaches sound by the numbers, and lists the palette and what is placed', async () => {
		const client = await connect()
		const guide = (await client.callTool({ name: 'get_sound_guide', arguments: {} }) as any).content[0].text as string
		expect(guide).toMatch(/SOUND GUIDE/)
		expect(guide).toMatch(/whoosh: .* 0\.50 s/)
		expect(guide).toMatch(/SAME pitch/)

		const palette = text(await client.callTool({ name: 'list_sounds', arguments: {} }))
		expect(palette.palette.map((p: any) => p.kind)).toContain('whoosh')
		expect(palette.palette.find((p: any) => p.kind === 'flight').lengthSec).toMatch(/durationSec/)
		expect(palette.placed).toEqual([])
		expect(palette.providers).toEqual({
			connected: [{ provider: 'elevenlabs', makes: ['speech', 'sfx', 'music'] }], allowed: false, limit: { generations: 2, usd: 1 }
		})
	})

	it('suggests the moments that want a sound, with the follow to pass back', async () => {
		withLowerThird()
		const client = await connect()
		const { cues, open } = text(await client.callTool({ name: 'suggest_cues', arguments: {} }))
		expect(open).toBe(2)
		expect(cues[0]).toMatchObject({ cue: 'lt:start', atSec: 3, sound: 'whoosh', taken: false, follow: { item: 'lt', at: 'start' }, leadMs: 84 })
		expect(cues[1]).toMatchObject({ sound: 'pop', follow: { item: 'lt', at: 'out' } })
	})

	it('adds a sound that follows a moment: rendered first, placed early, one revision, and it goes with the moment', async () => {
		withLowerThird()
		const client = await connect()
		const result = await client.callTool({
			name: 'apply_ops',
			arguments: { rationale: 'A whoosh as the name slides in.', addSounds: [{ kind: 'whoosh', follow: { item: 'lt', at: 'start' } }] }
		}) as any
		const out = text(result)
		expect(out.revision).toBe('V1')
		expect(out.applied.added).toBe(1)
		expect(editor.renderedSounds).toEqual([{ kind: 'whoosh' }])

		const sound = editor.doc.timeline.find((i) => i.bind)!
		expect(sound.timelineStart).toBeCloseTo(3 - 0.084)
		expect(editor.doc.tracks.find((t) => t.id === sound.trackId)).toMatchObject({ kind: 'audio', role: 'sfx' })
		// The renderer was handed the asset with the turn.
		expect(editor.doc.media.some((a) => a.synth?.kind === 'whoosh')).toBe(true)

		// Move the lower third, and the whoosh follows in the same edit.
		await client.callTool({ name: 'apply_ops', arguments: { rationale: 'Later.', updateItems: [{ id: 'lt', timelineStart: 9 }] } })
		expect(editor.doc.timeline.find((i) => i.bind)!.timelineStart).toBeCloseTo(9 - 0.084)

		// get_timeline says what the sound is and what it follows.
		const items = text(await client.callTool({ name: 'get_timeline', arguments: {} })).items
		const reported = items.find((i: any) => i.sound)
		expect(reported.sound).toMatchObject({ kind: 'whoosh', levelDb: -17 })
		expect(reported.follows).toMatchObject({ item: 'lt', at: 'start' })
	})

	it('changes a sound and a role, and refuses a sound that does not exist', async () => {
		withLowerThird()
		const client = await connect()
		await client.callTool({ name: 'apply_ops', arguments: { rationale: 'Whoosh.', addSounds: [{ kind: 'whoosh', follow: { item: 'lt' } }] } })
		const id = editor.doc.timeline.find((i) => i.bind)!.id

		await client.callTool({ name: 'apply_ops', arguments: { rationale: 'Higher.', setSounds: [{ id, pitch: 2 }] } })
		expect(editor.doc.media.some((a) => a.synth?.kind === 'whoosh' && a.synth.pitch === 2)).toBe(true)

		const audio = editor.doc.tracks.find((t) => t.kind === 'audio')!
		await client.callTool({ name: 'apply_ops', arguments: { rationale: 'Voice.', setTrackRoles: [{ trackId: audio.id, role: 'voice' }] } })
		expect(editor.doc.tracks.find((t) => t.id === audio.id)!.role).toBe('voice')

		const bad = await client.callTool({ name: 'apply_ops', arguments: { rationale: 'x', addSounds: [{ kind: 'kazoo', atSec: 1 }] } }) as any
		expect(bad.isError).toBe(true)
		expect(bad.content[0].text).toMatch(/unknown sound "kazoo"|not in|must be one of/)
	})

	it('measures a recipe: numbers and a spectrogram picture, without changing the project', async () => {
		const client = await connect()
		const before = editor.doc.timeline.length
		const result = await client.callTool({ name: 'render_sound', arguments: { kind: 'chime', pitch: 2 } }) as any
		const body = text(result)
		expect(body.recipe).toMatchObject({ kind: 'chime', pitch: 2, levelDb: -4 })
		expect(body.lengthSec).toBeCloseTo(2)
		expect(body.peakDb).toBe(-4)
		expect(result.content.some((c: any) => c.type === 'image')).toBe(true)
		expect(editor.doc.timeline).toHaveLength(before)

		const none = await client.callTool({ name: 'render_sound', arguments: {} }) as any
		expect(none.isError).toBe(true)
	})

	it('reads how the mix sits, in words', async () => {
		const client = await connect()
		// A music bed only 2 LU under a voice of −16.
		editor.doc.tracks.push({ id: 'a2', kind: 'audio', name: 'A2', order: 1, muted: false, locked: false, hidden: false, height: 48, role: 'music' })
		editor.doc.media.push({
			id: 'bed', kind: 'audio', name: 'bed', originalPath: '', preprocessing: {}, clips: [], createdAt: 0,
			metadata: { duration: 30 } as any, synth: { kind: 'bed', variant: 0, pitch: 0, levelDb: -4, air: 0.4, seed: 0, durationSec: 30 }
		})
		editor.doc.timeline.push({ id: 'bd', trackId: 'a2', sourceAssetId: 'bed', timelineStart: 0, in: 0, out: 30, speed: 1, preservePitch: true, duration: 30, label: 'bed' })
		const report = text(await client.callTool({ name: 'analyze_audio', arguments: {} }))
		expect(report.roles.map((r: any) => r.role).sort()).toEqual(['music', 'voice'])
		expect(report.warnings.join(' ')).toMatch(/Music sits only/)
		expect(report.caveats.length).toBeGreaterThan(0)
	})

	it('gates making sounds on its own permission, and says where to turn it on', async () => {
		withLowerThird()
		permissions.sound = false
		const client = await connect()
		const refused = await client.callTool({ name: 'apply_ops', arguments: { rationale: 'x', addSounds: [{ kind: 'pop', atSec: 1 }] } }) as any
		expect(refused.isError).toBe(true)
		expect(refused.content[0].text).toMatch(/built-in synth/)
		expect(editor.commits).toHaveLength(0)
		expect(editor.renderedSounds).toEqual([])
		// Roles and reading are not making a sound.
		const roles = await client.callTool({ name: 'apply_ops', arguments: { rationale: 'x', setTrackRoles: [{ trackId: 'v1', role: 'voice' }] } }) as any
		expect(roles.content[0].text).not.toMatch(/built-in synth/)
		expect((await client.callTool({ name: 'list_sounds', arguments: {} }) as any).isError).toBeFalsy()
	})

	describe('generating audio with a provider', () => {
		const gen = (client: any, args: Record<string, unknown>) =>
			client.callTool({ name: 'generate_audio', arguments: args }) as Promise<any>

		it('is off until the user allows it, and nothing is made or spent', async () => {
			const client = await connect()
			const refused = await gen(client, { capability: 'speech', prompt: 'Welcome to the show.' })
			expect(refused.isError).toBe(true)
			expect(refused.content[0].text).toMatch(/Settings/)
			expect(editor.generated).toEqual([])
		})

		it('makes an asset, says what it cost, and puts nothing on the timeline', async () => {
			permissions.generate = true
			const client = await connect()
			const before = editor.doc.timeline.length
			const made = text(await gen(client, { capability: 'speech', prompt: 'Welcome to the show.', voice: 'Rachel' }))
			expect(made).toMatchObject({ asset: 'gen-1', provider: 'elevenlabs', generationsLeftThisTurn: 1 })
			expect(made.cost).toBe('$0.05')
			expect(editor.generated[0]).toMatchObject({ provider: 'elevenlabs', capability: 'speech', voice: 'Rachel' })
			expect(editor.doc.timeline).toHaveLength(before)
		})

		it('stops at the count for the turn, and tells the agent what to do instead', async () => {
			permissions.generate = true
			const client = await connect()
			await gen(client, { capability: 'sfx', prompt: 'a door slamming', durationSec: 1 })
			await gen(client, { capability: 'sfx', prompt: 'a door creaking', durationSec: 1 })
			const third = await gen(client, { capability: 'sfx', prompt: 'a door knocking', durationSec: 1 })
			expect(third.isError).toBe(true)
			expect(third.content[0].text).toMatch(/2 generations per turn/)
			expect(editor.generated).toHaveLength(2)
		})

		it('stops at the dollars before it spends them', async () => {
			permissions.generate = true
			const client = await connect()
			await gen(client, { capability: 'music', prompt: 'calm piano', durationSec: 30 })
			const over = await gen(client, { capability: 'music', prompt: 'calm piano again', durationSec: 30 })
			expect(over.isError).toBe(true)
			expect(over.content[0].text).toMatch(/limit/)
			expect(editor.generated).toHaveLength(1)
		})

		it('says so when no provider is connected, and when the request cannot be made', async () => {
			permissions.generate = true
			const client = await connect()
			editor.connected = []
			const none = await gen(client, { capability: 'speech', prompt: 'Hello there.' })
			expect(none.content[0].text).toMatch(/No audio provider is connected.*Settings → Audio providers/)
			editor.connected = ['elevenlabs']
			const short = await gen(client, { capability: 'sfx', prompt: 'a door slamming', durationSec: 99 })
			expect(short.isError).toBe(true)
			expect(short.content[0].text).toMatch(/0\.5 to 30 seconds/)
			const unknown = await gen(client, { capability: 'speech', prompt: 'Hello there.', provider: 'suno' })
			expect(unknown.content[0].text).toMatch(/Unknown provider/)
			expect(editor.generated).toEqual([])
		})

		it('places what it made on a lane of the right role, and a missing asset is dropped, not guessed', async () => {
			permissions.generate = true
			const client = await connect()
			await gen(client, { capability: 'speech', prompt: 'Welcome to the show.' })
			const raw = await client.callTool({
				name: 'apply_ops', arguments: { rationale: 'Voice-over', placeAudio: [{ asset: 'gen-1', atSec: 2 }, { asset: 'nope', atSec: 1 }, { asset: 'gen-1' }] }
			}) as any
			const placed = text(raw)
			expect(placed.droppedOps.join(' ')).toMatch(/no audio nope/)
			expect(placed.droppedOps.join(' ')).toMatch(/say when/)
			const clip = editor.doc.timeline.find((i) => i.sourceAssetId === 'gen-1')!
			expect(clip.timelineStart).toBe(2)
			expect(editor.doc.tracks.find((t) => t.id === clip.trackId)).toMatchObject({ kind: 'audio', role: 'voice' })
		})

		it('placing costs nothing and needs no generate permission', async () => {
			const client = await connect()
			editor.doc.media.push({
				id: 'vo', kind: 'audio', name: 'vo', originalPath: '', preprocessing: {}, clips: [], createdAt: 0,
				metadata: { duration: 3 } as any, generated: { provider: 'elevenlabs', capability: 'speech', prompt: 'x', costUsd: 0.01, madeAt: 0 }
			})
			const placed = text(await client.callTool({ name: 'apply_ops', arguments: { rationale: 'Voice-over', placeAudio: [{ asset: 'vo', atSec: 0 }] } }))
			expect(placed.applied).toBeTruthy()
			expect(editor.generated).toEqual([])
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
