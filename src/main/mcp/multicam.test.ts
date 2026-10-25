import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DEFAULT_AGENT_PERMISSIONS } from '@shared/agent'
import { groupTimeAt } from '@shared/multicam'
import type { MediaAsset } from '@shared/types'
import { AgentServer } from './server'
import { FakeEditor, TOKEN } from './fakeEditor'

/**
 * A whole multicam edit over MCP, through the SDK's own client: find the
 * cameras, sync them into a group, compare angles, cut, change the sound.
 * Only the editor and the sync's measurement are fake.
 */

const camera = (id: string, folder: string, name: string, duration: number): MediaAsset => ({
	id, kind: 'video', name, originalPath: `/Gap-time/${folder}/${name}`,
	metadata: { duration, width: 3840, height: 2160, fps: 30, size: 1, codec: 'hevc', format: 'mp4', hasAudio: true },
	preprocessing: {}, preprocessState: 'completed', clips: [], createdAt: 0
})

describe('multicam over MCP', () => {
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
		editor.doc.media.push(
			camera('cam1', 'Cam01', 'DJI_20260717171155_0022_D.MP4', 120),
			camera('cam2', 'Cam02', 'DJI_20260717171157_0007_D.MP4', 118)
		)
		editor.syncOffsets = { cam2: 1.5 }
		const base = editor.readTranscripts.bind(editor)
		editor.readTranscripts = async (project, ids) => ({
			...(await base(project, ids)),
			cam1: [{ start: 10, end: 13, text: 'So what is gap time?' }, { start: 13, end: 16, text: 'Time between two things.' }]
		})
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

	it('finds, syncs, places, compares and cuts', async () => {
		// 1. The two DJI files started two seconds apart: a strong suggestion.
		const found = (await call('find_camera_groups')).body
		expect(found.suggestions).toHaveLength(1)
		expect(found.suggestions[0]).toMatchObject({ mediaIds: ['cam1', 'cam2'], strength: 'strong' })

		// 2. Sync and place: a group, its sound on a new audio track, one shot after the existing clip.
		const made = (await call('make_multicam', { assets: ['cam1', 'cam2'] })).body
		expect(made.revision).toMatch(/^V\d+$/)
		expect(made.group.cameras.map((c: any) => [c.name, c.files[0].offsetSec, c.files[0].confidence])).toEqual([
			['Cam01', 0, 'strong'], ['Cam02', 1.5, 'strong']
		])
		expect(made.group.name).toBe('Gap-time')
		expect(made.group.mainSound).toBe('Cam01') // the cleaner of the two
		const group = editor.doc.multicams![0]
		const sound = editor.doc.timeline.find((i) => i.multicam?.role === 'sound')!
		const shot = editor.doc.timeline.find((i) => i.multicam?.role === 'shot')!
		expect(editor.doc.tracks.find((t) => t.id === sound.trackId)?.kind).toBe('audio')
		expect(sound.timelineStart).toBe(30) // after the clip already there
		expect(shot).toMatchObject({ sourceAssetId: 'cam1', timelineStart: 30, muted: true })

		// 3. One transcript for the group, on both clocks.
		const info = (await call('get_multicam')).body
		expect(info.transcript[0]).toMatchObject({ groupSec: [10, 13], timelineSec: [40, 43], text: 'So what is gap time?' })

		// 4. Every angle at the same moments.
		const angles = await call('get_angles', { fromSec: 40, toSec: 48, frames: 4 })
		expect(angles.result.content.filter((c: any) => c.type === 'image')).toHaveLength(2)
		expect(angles.body.moments).toHaveLength(4)
		expect(angles.body.moments[0]).toMatchObject({ showing: 'Cam01' })
		expect(angles.body.said).toContain('gap time')
		// Each angle's tiles say TIMELINE time, not the file's own: the same moment reads the same in every row.
		const sheets = editor.sheetRequests.slice(-2)
		expect(sheets.map((r) => r.labels)).toEqual([['0:41.0', '0:43.0', '0:45.0', '0:47.0'], ['0:41.0', '0:43.0', '0:45.0', '0:47.0']])
		expect(sheets[0].times).not.toEqual(sheets[1].times)

		// 5. Cut to Cam 2 for ten seconds: the shot splits, the sound does not move, nothing drifts.
		await call('apply_ops', { rationale: 'Cam 2 for the answer', switchAngles: { switches: [{ atSec: 43, angle: 2 }, { atSec: 53, angle: 'cam01' }] } })
		const shots = editor.doc.timeline.filter((i) => i.multicam?.role === 'shot').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(shots.map((s) => s.label)).toEqual(['Cam01', 'Cam02', 'Cam01'])
		const live = editor.doc.timeline.find((i) => i.id === sound.id)!
		for (const s of shots) {
			expect(groupTimeAt(s, group, s.timelineStart + 1)).toBeCloseTo(groupTimeAt(live, group, s.timelineStart + 1)!, 9)
		}

		// 6. Main sound to Cam 2: the sound clip moves into Cam 2's file, still on the same moment.
		const changed = (await call('apply_ops', { rationale: 'Cam 2 mic', setMainSound: { sound: 'Cam02' } })).body
		expect(changed.notes.join(' ')).toMatch(/Cam02 did not record 2 s/)
		const moved = editor.doc.timeline.find((i) => i.id === sound.id)!
		expect(moved.sourceAssetId).toBe('cam2')
		// Cam 2 began 1.5 s into the group: the sound now starts there, at Cam 2's first sample.
		expect(moved.in).toBe(0)
		expect(moved.timelineStart).toBeCloseTo(31.5, 9)
		expect(groupTimeAt(moved, editor.doc.multicams![0], 40)).toBeCloseTo(10, 9)
		expect(editor.doc.multicams![0].soundAssetId).toBe('cam2')

		// 7. Remove the Cam 2 shot: its stretch leaves the sound too, so nothing after it slips.
		const cam2 = editor.doc.timeline.find((i) => i.multicam?.role === 'shot' && i.sourceAssetId === 'cam2')!
		const removedBody = (await call('apply_ops', { rationale: 'drop the answer', removeItemIds: [cam2.id] })).body
		expect(removedBody.notes.join(' ')).toMatch(/stay in sync/)
		const pieces = editor.doc.timeline.filter((i) => i.multicam?.role === 'sound').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(pieces).toHaveLength(2)
		let checked = 0
		for (const s of editor.doc.timeline.filter((i) => i.multicam?.role === 'shot')) {
			const t = s.timelineStart + s.duration / 2
			const under = pieces.find((p) => t >= p.timelineStart && t < p.timelineStart + p.duration)
			if (!under) continue // before Cam 2's sound began (step 6 trimmed it)
			expect(groupTimeAt(s, group, t)).toBeCloseTo(groupTimeAt(under, group, t)!, 6)
			checked++
		}
		expect(checked).toBeGreaterThanOrEqual(1)
	})

	it('explains what is wrong instead of guessing', async () => {
		await expect(call('get_multicam')).rejects.toThrow(/no camera group yet/)
		await expect(call('make_multicam', { assets: ['cam1'] })).rejects.toThrow(/at least two/)
		await call('make_multicam', { assets: ['cam1', 'cam2'], place: false })
		await expect(call('get_angles', { fromSec: 0, toSec: 5 })).rejects.toThrow(/not on the timeline/)
		const { body } = await call('apply_ops', { rationale: 'x', switchAngles: { switches: [{ atSec: 1, angle: 3 }] }, placeMulticam: {} })
		expect(body.droppedOps.join(' ')).toMatch(/no angle "3"/)
	})
})
