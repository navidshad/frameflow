import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'fs'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from '@shared/types'
import { cuesForDoc, transcriptsForAssets } from './captions'

/**
 * The boundary the pure module deliberately does not cross: transcripts on
 * disk, written as SRT strings, read into seconds.
 */

let dir: string
const at = (name: string) => join(dir, name)

const write = (name: string, body: unknown) => {
	writeFileSync(at(name), JSON.stringify(body), 'utf-8')
	return at(name)
}

const asset = (id: string, transcriptPath?: string): MediaAsset => ({
	id, kind: 'video', name: id, originalPath: `/tmp/${id}.mp4`,
	metadata: { duration: 60, width: 1920, height: 1080, fps: 30, hasAudio: true } as MediaAsset['metadata'],
	preprocessing: transcriptPath ? { transcriptPath } : {}, clips: [], createdAt: 0
})

const vtrack: Track = {
	id: 'v1', kind: 'video', name: 'V1', order: 0,
	muted: false, locked: false, hidden: false, height: 72
}

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'i1', trackId: 'v1', sourceAssetId: 'a1', timelineStart: 0,
	in: 0, out: 10, speed: 1, preservePitch: true, duration: 10, ...over
})

const doc = (over: Partial<EditorDocument>): EditorDocument => ({
	schemaVersion: 1, media: [], tracks: [vtrack], timeline: [item()],
	timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 },
	activePersonaId: 'podcast-editor', turns: [],
	historyRef: { currentStepId: 'step-0', stepCount: 0 }, ...over
})

beforeAll(async () => { dir = await fs.mkdtemp(join(tmpdir(), 'ff-cap-unit-')) })
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })

describe('transcriptsForAssets', () => {
	it('reads SRT timestamps into seconds', () => {
		const path = write('t1.json', [
			{ start: '00:00:01,500', end: '00:00:04,000', text: 'hello world' },
			{ start: '00:01:00,000', end: '00:01:02,000', text: 'a minute in' }
		])
		const out = transcriptsForAssets([asset('a1', path)])
		expect(out.a1).toEqual([
			{ start: 1.5, end: 4, text: 'hello world' },
			{ start: 60, end: 62, text: 'a minute in' }
		])
	})

	it('drops entries a transcriber can emit but nothing can render', () => {
		const path = write('t2.json', [
			{ start: '00:00:02,000', end: '00:00:01,000', text: 'backwards' },
			{ start: '00:00:03,000', end: '00:00:03,000', text: 'instant' },
			{ start: '00:00:04,000', end: '00:00:05,000', text: 'kept' }
		])
		expect(transcriptsForAssets([asset('a1', path)]).a1.map((e) => e.text)).toEqual(['kept'])
	})

	it('says nothing rather than throwing for media with no transcript', () => {
		expect(transcriptsForAssets([asset('a1')])).toEqual({})
		expect(transcriptsForAssets([asset('a1', at('missing.json'))])).toEqual({})
	})

	it('survives a corrupt file', () => {
		writeFileSync(at('bad.json'), '{not json', 'utf-8')
		expect(transcriptsForAssets([asset('a1', at('bad.json'))])).toEqual({})
		writeFileSync(at('object.json'), '{"nope":1}', 'utf-8')
		expect(transcriptsForAssets([asset('a1', at('object.json'))])).toEqual({})
	})
})

const FRAME = { width: 1920, height: 1080 }

describe('cuesForDoc', () => {
	it('turns a transcript on disk into cues on the timeline', () => {
		const path = write('t3.json', [
			{ start: '00:00:00,000', end: '00:00:06,000', text: 'one two three four five six' }
		])
		const cues = cuesForDoc(
			doc({ media: [asset('a1', path)], timeline: [item({ timelineStart: 4 })], captionsEnabled: true }),
			FRAME
		)
		expect(cues.map((c) => c.text)).toEqual(['one two three', 'four five six'])
		expect(cues[0].start).toBeCloseTo(4, 6)
		expect(cues[1].end).toBeCloseTo(10, 6)
	})

	it('says nothing when captions are switched off', () => {
		const path = write('t5.json', [{ start: '0', end: '3', text: 'hello there world' }])
		expect(cuesForDoc(doc({ media: [asset('a1', path)] }), FRAME)).toEqual([])
	})

	it('burns a title whether or not captions are on', () => {
		// A title is content the user placed by hand, not a setting.
		const titled = doc({
			tracks: [vtrack, { ...vtrack, id: 't1', kind: 'text', name: 'T1' }],
			timeline: [item({ id: 'ttl', trackId: 't1', timelineStart: 2, duration: 3, text: { content: 'Chapter One' } })]
		})
		const cues = cuesForDoc(titled, FRAME)
		expect(cues.map((c) => c.text)).toEqual(['Chapter One'])
		expect(cues[0].start).toBe(2)
		expect(cues[0].end).toBe(5)
	})

	it('ignores an asset the timeline does not use', () => {
		const path = write('t4.json', [{ start: '0', end: '3', text: 'unused' }])
		expect(cuesForDoc(doc({ media: [asset('a2', path)], captionsEnabled: true }), FRAME)).toEqual([])
	})
})
