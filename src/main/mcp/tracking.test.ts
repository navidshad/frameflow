import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DEFAULT_AGENT_PERMISSIONS } from '@shared/agent'
import { AgentServer } from './server'
import { FakeEditor, TOKEN } from './fakeEditor'

/**
 * Tracking over MCP, through the SDK's own client. The measuring itself is
 * fake (main/tracking has its own tests on real frames); this is the contract:
 * which clock each tool speaks, what it saves, what it tells the agent.
 */
describe('tracking over MCP', () => {
	let editor: FakeEditor
	let server: AgentServer
	let client: Client

	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }) as any
		const first = result.content.find((c: any) => c.type === 'text')
		if (result.isError) throw new Error(first?.text)
		return { body: JSON.parse(first.text), result }
	}

	beforeEach(async () => {
		editor = new FakeEditor()
		// The clip shows source 10–20 s at double speed, starting at 100 s on the timeline.
		Object.assign(editor.doc.timeline[0], { timelineStart: 100, in: 10, out: 20, speed: 2, duration: 5 })
		server = new AgentServer({
			bridge: editor, token: () => TOKEN, permissions: () => ({ ...DEFAULT_AGENT_PERMISSIONS }), version: 'test',
			probeMotion: async () => ({ determinism: 'pass' })
		})
		const port = await server.start(0)
		client = new Client({ name: 'claude-code', version: '2.1.0' })
		await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
			requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
		}))
	})

	afterEach(async () => {
		await client.close().catch(() => undefined)
		await server.stop()
	})

	it('finds faces in the part of the footage a clip shows, and shows who it found', async () => {
		const { body, result } = await call('find_faces', { clip: 'i1', fromSec: 101, toSec: 103 })
		expect(editor.trackRequests).toEqual([{ kind: 'faces', assetId: 'team', fromSec: 12, toSec: 16 }])
		expect(result.content[0].type).toBe('image')
		expect(body.people.map((p: any) => p.name)).toEqual(['Person 1', 'Person 2'])
		expect(body.people[0].sourceSpans).toEqual([{ from: 12, to: 16, sec: 4 }])
		expect(body.people[0].timelineSpans).toEqual([{ from: 101, to: 103, sec: 2 }])
		expect(body.positions).toMatch(/fills the frame untouched/)
	})

	it('defaults to the whole clip, never the footage outside it', async () => {
		await call('find_faces', { clip: 'i1' })
		expect(editor.trackRequests[0]).toMatchObject({ fromSec: 10, toSec: 20 })
	})

	it('refuses a stretch too long for one call', async () => {
		editor.doc.media[0].metadata!.duration = 900
		await expect(call('find_faces', { asset: 'team' })).rejects.toThrow(/at most 180 s/)
	})

	it('gives a track back on the clip\'s own clock', async () => {
		await call('find_faces', { clip: 'i1', fromSec: 101, toSec: 103 })
		const { body } = await call('get_track', { track: 'Person 1', clip: 'i1', everySec: 0.5 })
		expect(body.clock).toBe('timeline seconds')
		expect(body.columns).toEqual(['t', 'cx', 'cy', 'w', 'h'])
		expect(body.rows[0][0]).toBe(101)
		expect(body.rows.at(-1)[0]).toBe(103)
		expect(body.fps).toBe(50)
		const source = (await call('get_track', { track: 'Person 1' })).body
		expect(source.clock).toBe('source seconds')
		expect(source.rows[0][0]).toBe(12)
	})

	it('caps the rows and says how to continue', async () => {
		editor.doc.media[0].metadata!.duration = 60
		await call('find_faces', { asset: 'team', fromSec: 0, toSec: 30 })
		const { body } = await call('get_track', { track: 'Person 1' })
		expect(body.rows).toHaveLength(400)
		expect(body.more).toMatch(/fromSec/)
	})

	it('warns when a clip is reframed, because the numbers are not frame positions then', async () => {
		editor.doc.timeline[0].transform = { x: 0.1, y: 0, scale: 1.2, rotation: 0 } as any
		const { body } = await call('find_faces', { clip: 'i1' })
		expect(body.positions).toMatch(/NOT the same positions/)
	})

	it('follows a box from a frame and says when it lost the object', async () => {
		const { body, result } = await call('track_object', {
			clip: 'i1', atSec: 100.5, box: { x: 0.4, y: 0.4, w: 0.1, h: 0.2 }, name: 'whisky bottle', direction: 'forward'
		})
		expect(editor.trackRequests[0]).toMatchObject({ kind: 'object', atSec: 11, fromSec: 10, toSec: 20 })
		expect(result.content[0].type).toBe('image')
		expect(body.name).toBe('whisky bottle')
		expect(body.ended).toEqual({ forward: 'lost' })
		expect(body.lost).toMatch(/lost the object going forwards/)
	})

	it('refuses a box that runs outside the picture, and a frame outside the clip', async () => {
		await expect(call('track_object', { clip: 'i1', atSec: 101, box: { x: 0.95, y: 0.4, w: 0.1, h: 0.2 } })).rejects.toThrow(/outside the picture/)
		await expect(call('track_object', { clip: 'i1', atSec: 300, box: { x: 0.4, y: 0.4, w: 0.1, h: 0.2 } })).rejects.toThrow(/outside the stretch/)
	})

	it('renames, merges and deletes tracks', async () => {
		await call('find_faces', { clip: 'i1', fromSec: 101, toSec: 103 })
		await call('edit_track', { track: 'Person 1', name: 'Hoodie woman', shape: 'box' })
		expect((await call('list_tracks')).body.tracks.map((t: any) => `${t.name}/${t.shape}`)).toEqual(['Hoodie woman/box', 'Person 2/ellipse'])

		const merged = (await call('edit_track', { track: 'Person 2', mergeInto: 'Hoodie woman' })).body
		expect(merged.into.name).toBe('Hoodie woman')
		expect((await call('list_tracks', { asset: 'team' })).body.tracks).toHaveLength(1)

		await call('edit_track', { track: 'Hoodie woman', delete: true })
		expect((await call('list_tracks')).body.tracks).toEqual([])
		await expect(call('get_track', { track: 'Hoodie woman' })).rejects.toThrow(/no tracks yet/)
	})
})
