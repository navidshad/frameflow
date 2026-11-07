import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from '@shared/types'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
let tempDir = ''
vi.mock('../threads', () => ({
	threadManager: { getThread: () => ({ type: 'editor', tempDir }) }
}))
const ensureMotionClip = vi.fn<(job: any, options?: any) => Promise<string>>()
vi.mock('../motion', () => ({ ensureMotionClip: (job: any, options?: any) => ensureMotionClip(job, options) }))
let exporting = false
vi.mock('./render', async (original) => ({ ...(await original<typeof import('./render')>()), hasActiveRender: () => exporting }))

import { IDLE_RATIO, motionClipsFor, prerenderMotion } from './motionPrerender'

// A 4K60 project with two different motion layers over a clip.
const asset = (): MediaAsset => ({
	id: 'a', kind: 'video', name: 'a.mp4', originalPath: '/tmp/a.mp4',
	metadata: { duration: 100, width: 3840, height: 2160, fps: 60, hasAudio: true } as MediaAsset['metadata'],
	preprocessing: {}, clips: [], createdAt: 0
})
const track = (id: string, order: number): Track => ({
	id, kind: 'video', name: id, order, muted: false, locked: false, hidden: false, height: 72
})
const clip = (id: string, over: Partial<TimelineItem>): TimelineItem => ({
	id, trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 10, speed: 1, preservePitch: true, duration: 10, ...over
})
const doc = (names: string[]): EditorDocument => ({
	schemaVersion: 1,
	media: [asset()],
	tracks: [track('v1', 0), track('v2', 1)],
	timeline: [
		clip('base', {}),
		...names.map((name, i) => clip(`m${i}`, {
			trackId: 'v2', sourceAssetId: '', timelineStart: i * 3, in: 0, out: 2, duration: 2,
			motion: { template: 'lower-third', settings: { name } }
		}))
	],
	timelineMeta: { fps: 60, width: 3840, height: 2160, duration: 10 },
	turns: [], historyRef: { currentStepId: 's0', stepCount: 0 }
}) as EditorDocument

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prerender-'))
	ensureMotionClip.mockReset()
	ensureMotionClip.mockImplementation(async (job) => {
		fs.mkdirSync(path.dirname(job.outputPath), { recursive: true })
		fs.writeFileSync(job.outputPath, 'x')
		return job.outputPath
	})
	exporting = false
})

describe('prerenderMotion', () => {
	it('draws exactly the clips an original-quality export would ask for, at its size and rate', async () => {
		const d = doc(['Ada', 'Bo'])
		const wanted = motionClipsFor(d, tempDir)
		expect(wanted).toHaveLength(2)
		const result = await prerenderMotion({ threadId: 't', doc: d }, { report: () => {} })
		expect(ensureMotionClip.mock.calls.map(([job]) => job.outputPath)).toEqual(wanted.map((j) => j.outputPath))
		// 4K, and at the motion rate: half the 60 fps sequence, as the export draws it.
		expect(ensureMotionClip.mock.calls[0][0].frame).toEqual({ width: 3840, height: 2160, fps: 30 })
		expect(result).toEqual({ threadId: 't', done: 2, total: 2, running: false })
	})

	it('rests between frames so the editor stays responsive', async () => {
		await prerenderMotion({ threadId: 't', doc: doc(['Ada']) }, { report: () => {} })
		const rest = ensureMotionClip.mock.calls[0][1].idleRatio as () => number
		expect(rest()).toBe(IDLE_RATIO)
		expect(IDLE_RATIO).toBeGreaterThan(0)
		// ...until an export is waiting on the clip, which then runs at full speed.
		exporting = true
		expect(rest()).toBe(0)
	})

	it('skips a clip that is already on disk, and reports how many are ready', async () => {
		const d = doc(['Ada', 'Bo'])
		const [first] = motionClipsFor(d, tempDir)
		fs.mkdirSync(path.dirname(first.outputPath), { recursive: true })
		fs.writeFileSync(first.outputPath, 'x')
		const reports: [number, boolean][] = []
		await prerenderMotion({ threadId: 't', doc: d }, { report: (p) => reports.push([p.done, p.running]) })
		expect(ensureMotionClip).toHaveBeenCalledTimes(1)
		// One ready to begin with and drawing the other, then both ready and done.
		expect(reports).toEqual([[1, true], [2, true], [2, false]])
	})

	it('draws nothing for a project with no motion layers', async () => {
		const result = await prerenderMotion({ threadId: 't', doc: doc([]) }, { report: () => {} })
		expect(ensureMotionClip).not.toHaveBeenCalled()
		expect(result?.total).toBe(0)
	})

	it('stands aside for an export, which draws the rest itself', async () => {
		ensureMotionClip.mockImplementation(async (job) => {
			fs.mkdirSync(path.dirname(job.outputPath), { recursive: true })
			fs.writeFileSync(job.outputPath, 'x')
			exporting = true // an export starts while the first clip is being drawn
			return job.outputPath
		})
		const result = await prerenderMotion({ threadId: 't', doc: doc(['Ada', 'Bo', 'Cy']) }, { report: () => {} })
		expect(ensureMotionClip).toHaveBeenCalledTimes(1)
		expect(result).toMatchObject({ done: 1, total: 3, running: false })
	})

	it('a newer snapshot replaces an older run, but only between clips', async () => {
		let release!: () => void
		const firstClipHeld = new Promise<void>((r) => { release = r })
		let calls = 0
		ensureMotionClip.mockImplementation(async (job) => {
			fs.mkdirSync(path.dirname(job.outputPath), { recursive: true })
			if (calls++ === 0) await firstClipHeld // the older run is inside its first clip
			fs.writeFileSync(job.outputPath, 'x')
			return job.outputPath
		})
		const older = prerenderMotion({ threadId: 't', doc: doc(['Ada', 'Bo']) }, { report: () => {} })
		await Promise.resolve()
		const newer = prerenderMotion({ threadId: 't', doc: doc(['Ada', 'Cy']) }, { report: () => {} })
		release()
		const [a, b] = await Promise.all([older, newer])
		// The older run finished the clip it was in, then left the rest to the newer one.
		expect(a?.done).toBe(1)
		expect(b?.total).toBe(2)
	})

	it('a layer that cannot be drawn does not stop the others', async () => {
		let calls = 0
		ensureMotionClip.mockImplementation(async (job) => {
			if (calls++ === 0) throw new Error('page broke')
			fs.mkdirSync(path.dirname(job.outputPath), { recursive: true })
			fs.writeFileSync(job.outputPath, 'x')
			return job.outputPath
		})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const result = await prerenderMotion({ threadId: 't', doc: doc(['Ada', 'Bo']) }, { report: () => {} })
		expect(result).toMatchObject({ done: 1, total: 2, running: false }) // not left spinning
		warn.mockRestore()
	})
})
