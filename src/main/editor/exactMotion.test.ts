import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from '@shared/types'
import { getFFmpegBinaryPath } from '../ffmpeg'
import { buildRegionGraph, motionJobsFor, type CutRegion, type SourceSlice } from './renderBuilders'
import {
	describeMotionReport, layerState, motionClipsReady, motionItemsAt, rebasedSlice,
	stillClipPath, stillFrameRange
} from './exactMotion'

const execFileAsync = promisify(execFile)
const ffmpeg = getFFmpegBinaryPath()

let tempDir = ''
vi.mock('../threads', () => ({
	threadManager: { getThread: () => ({ type: 'editor', tempDir }) }
}))

/**
 * A stand-in motion clip whose frame k is an opaque gray of level 3k, so the
 * frame a still shows says which clip frame it read. Written in the codec the
 * capture writes.
 */
const writeNumberedClip = async (file: string, seconds: number, first = 0, last?: number) => {
	const select = last === undefined ? '' : `,select='between(n\\,${first}\\,${last})',setpts=N/FRAME_RATE/TB`
	await execFileAsync(ffmpeg, [
		'-y', '-v', 'error', '-f', 'lavfi',
		'-i', `color=c=black:s=320x180:r=30:d=${seconds},format=argb,geq=r='3*N':g='3*N':b='3*N':a=255${select}`,
		'-c:v', 'qtrle', '-pix_fmt', 'argb', '-g', '1', file
	])
}

// The capture needs Electron; the test draws "page frames" from the same
// numbered clip, frames first..last, which is what the capture would produce.
const captured: string[] = []
vi.mock('../motion', async (original) => ({
	...(await original<typeof import('../motion')>()),
	ensureMotionFrames: vi.fn(async (job: { item: TimelineItem }, first: number, last: number, outputPath: string) => {
		await fs.mkdir(join(outputPath, '..'), { recursive: true })
		await writeNumberedClip(outputPath, job.item.duration, first, last)
		captured.push(outputPath)
		return outputPath
	})
}))

const track = (id: string, order: number, hidden = false): Track =>
	({ id, kind: 'video', name: id, order, muted: false, locked: false, hidden, height: 72 })

const layer = (over: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'm', trackId: 'v2', sourceAssetId: '', timelineStart: 0.51, in: 0, out: 2.5,
	speed: 1, preservePitch: true, duration: 2.5, motion: { template: 'lower-third' }, ...over
})

describe('stillFrameRange and rebasedSlice', () => {
	const slice = (over: Partial<SourceSlice>): SourceSlice => ({
		srcPath: '/m/abc.mov', motion: { width: 320, height: 180, fps: 30 },
		in: 1, out: 1 + 2 / 30, offset: 0, duration: 2 / 30, freezeHead: 0, freezeTail: 0,
		item: { ...layer(), in: 0, out: 2.5 }, track: track('v2', 1), ...over
	})

	it('reads a frame either side of the instant, inside the clip', () => {
		expect(stillFrameRange(slice({}), 30)).toEqual({ first: 29, last: 33 })
		expect(stillFrameRange(slice({ in: 0, out: 2 / 30 }), 30)).toEqual({ first: 0, last: 3 })
		// The clip has 75 frames (2.5 s × 30): never past the last.
		expect(stillFrameRange(slice({ in: 2.5 - 2 / 30, out: 2.5 }), 30)).toEqual({ first: 72, last: 74 })
	})

	it('moves the seek and the item together, so fades and keys evaluate the same', () => {
		const original = slice({ item: { ...layer({ keyframes: { opacity: [{ t: 0, v: 0 }, { t: 2, v: 1 }] } as any }), in: 0, out: 2.5 } })
		const moved = rebasedSlice(original, 29, 30, '/m/stills/abc-29-33.mov')
		expect(moved.in).toBeCloseTo(1 - 29 / 30, 12)
		expect(moved.in - moved.item.in).toBeCloseTo(original.in - original.item.in, 12)
		expect(moved.out - moved.item.out).toBeCloseTo(original.out - original.item.out, 12)
		// The filtergraph is the same but for where the input seeks.
		const region = (s: SourceSlice): CutRegion => ({ kind: 'cut', duration: 2 / 30, videoLayers: [s], audioSources: [] })
		const plan = { regions: [], width: 320, height: 180, fps: 30, duration: 1, hasOverlap: false }
		expect(buildRegionGraph(region(moved), plan).filters).toEqual(buildRegionGraph(region(original), plan).filters)
	})

	it('names the still by the clip it stands in for', () => {
		expect(stillClipPath('/m/abc.mov', { first: 29, last: 33 })).toBe('/m/stills/abc-29-33.mov')
	})
})

describe('what the frame must show, and what it reports', () => {
	const doc = (items: TimelineItem[], tracks = [track('v1', 0), track('v2', 1)]) => ({ tracks, timeline: items })

	it('finds the motion layers covering an instant, on the frame grid', () => {
		const items = [layer({ id: 'a', timelineStart: 1, duration: 1, out: 1 }), layer({ id: 'b', timelineStart: 1.51, duration: 1, out: 1 })]
		expect(motionItemsAt(doc(items), 1.2, 30).map((i) => i.id)).toEqual(['a'])
		// b starts at 1.51, which the plan snaps to 1.5 (frame 45).
		expect(motionItemsAt(doc(items), 1.5, 30).map((i) => i.id)).toEqual(['a', 'b'])
		expect(motionItemsAt(doc(items), 2.0, 30).map((i) => i.id)).toEqual(['b'])
	})

	it('ignores hidden tracks and items that are not motion', () => {
		const items = [layer({ id: 'a', timelineStart: 0 }), { ...layer({ id: 'clip' }), motion: undefined, sourceAssetId: 'x' }]
		expect(motionItemsAt(doc(items, [track('v1', 0), track('v2', 1, true)]), 1, 30)).toEqual([])
	})

	it('counts each distinct clip once', () => {
		const s = (p: string) => ({ motion: { width: 1, height: 1, fps: 30 }, srcPath: p }) as SourceSlice
		const regions: CutRegion[] = [
			{ kind: 'cut', duration: 1, videoLayers: [s('/a.mov'), s('/b.mov')], audioSources: [] },
			{ kind: 'cut', duration: 1, videoLayers: [s('/a.mov')], audioSources: [] }
		]
		expect(motionClipsReady(regions, (p) => p === '/a.mov')).toEqual({ ready: 1, total: 2 })
	})

	it('tells checked, checking, older and empty pages apart', () => {
		const custom = (passed: any, html = '<p>x</p>') => ({ motion: { html, passed } })
		expect(layerState({ motion: { template: 'lower-third' } })).toBe('checked')
		expect(layerState(custom({ html: '<p>x</p>', verified: true }))).toBe('checked')
		expect(layerState(custom({ html: '<p>x</p>' }))).toBe('checking')
		expect(layerState(custom({ html: '<p>old</p>', verified: true }))).toBe('last-passing')
		expect(layerState(custom(null))).toBe('nothing')
	})

	it('says what is still rendering and what is still being checked', () => {
		const text = describeMotionReport({
			layers: [
				{ id: 'a', label: 'Lower third · Sara', drawnFrom: 'captured', state: 'checking' },
				{ id: 'b', label: 'Stat', drawnFrom: 'clip', state: 'nothing' }
			],
			clips: { ready: 12, total: 28 }
		})!
		expect(text).toContain('Motion layers in this frame (2): "Lower third · Sara", "Stat"')
		expect(text).toContain('"Lower third · Sara" is still being checked')
		expect(text).toContain('"Stat" draws nothing')
		expect(text).toContain('12 of 28 rendered')
		expect(describeMotionReport({ layers: [], clips: { ready: 0, total: 0 } })).toBeNull()
		expect(describeMotionReport({ layers: [], clips: { ready: 3, total: 3 } })).toBe('Motion clips for export: all 3 rendered.')
	})
})

describe('renderExactFrame with a motion layer — against the real ffmpeg', () => {
	let doc: EditorDocument
	let renderExactFrame: typeof import('./preview').renderExactFrame
	let clipPath = ''

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(join(tmpdir(), 'ff-exact-motion-'))
		const source = join(tempDir, 'black.mp4')
		await execFileAsync(ffmpeg, [
			'-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=4:r=30',
			'-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
			'-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '4', source
		])
		const asset: MediaAsset = {
			id: 'sa', kind: 'video', name: 'sa', originalPath: source,
			metadata: { duration: 4, width: 320, height: 180, fps: 30, hasAudio: true } as MediaAsset['metadata'],
			preprocessing: {}, clips: [], createdAt: 0
		}
		doc = {
			schemaVersion: 1, media: [asset], tracks: [track('v1', 0), track('v2', 1)],
			timeline: [
				{ id: 'c', trackId: 'v1', sourceAssetId: 'sa', timelineStart: 0, in: 0, out: 4, speed: 1, preservePitch: true, duration: 4 },
				layer()
			],
			timelineMeta: { fps: 30, width: 320, height: 180, duration: 4 },
			activePersonaId: 'podcast-editor', turns: [], historyRef: { currentStepId: 's', stepCount: 0 }
		}
		;({ renderExactFrame } = await import('./preview'))
		const { computeRegions } = await import('./render')
		const { motionCacheDir } = await import('../motion/cache')
		const plan = computeRegions(doc, 'original', {}, { motionDir: motionCacheDir(tempDir), frameGrid: true })
		clipPath = motionJobsFor(plan.regions)[0].outputPath
	}, 60_000)

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	const grayAt = async (file: string): Promise<number> => {
		const { stdout } = await execFileAsync(ffmpeg,
			['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'crop=10:10:150:80,scale=1:1,format=gray', '-f', 'rawvideo', '-'],
			{ encoding: 'buffer', maxBuffer: 1 << 20 })
		return (stdout as unknown as Buffer)[0]
	}

	it('draws the same clip frame from captured frames as from the full clip', async () => {
		// The layer starts at 0.51 s, snapped to 0.5 (frame 15); 1.7 s is clip frame 36.
		const t = 1.7
		await fs.mkdir(join(clipPath, '..'), { recursive: true })
		await writeNumberedClip(clipPath, 2.5)
		const fromClip = await renderExactFrame({ threadId: 't', doc, timeSec: t })
		expect(fromClip.motion.layers).toEqual([expect.objectContaining({ id: 'm', drawnFrom: 'clip', state: 'checked' })])
		expect(fromClip.motion.clips).toEqual({ ready: 1, total: 1 })
		const levelFromClip = await grayAt(fromClip.path)
		expect(Math.round(levelFromClip / 3)).toBe(36)

		// No clip on disk: only the frames around the instant are drawn.
		await fs.rm(clipPath)
		const fromPage = await renderExactFrame({ threadId: 't', doc, timeSec: t })
		expect(fromPage.motion.layers).toEqual([expect.objectContaining({ id: 'm', drawnFrom: 'captured' })])
		expect(fromPage.motion.clips).toEqual({ ready: 0, total: 1 })
		expect(captured.at(-1)).toMatch(/stills\/[0-9a-f]{24}-35-39\.mov$/)
		expect(Math.abs((await grayAt(fromPage.path)) - levelFromClip)).toBeLessThanOrEqual(1)
		// And the full clip was not rendered behind its back.
		expect(existsSync(clipPath)).toBe(false)
	}, 60_000)

	it('draws the first and last frames of the layer, and frames whose time rounds up', async () => {
		// Clip frame 2 is 0.0667 s, written to the millisecond as 0.067 — after
		// the frame. The seek must still land on it, not on frame 3.
		const instants = [[0.5, 0], [0.5 + 2 / 30, 2], [0.5 + 41 / 30, 41], [2.99, 74]] as const
		// From captured frames, then from the full clip (where the seek is the
		// clip time itself, 0.067 and 1.367 included).
		for (const fromClip of [false, true]) {
			if (fromClip) await writeNumberedClip(clipPath, 2.5)
			for (const [t, k] of instants) {
				const frame = await renderExactFrame({ threadId: 't', doc, timeSec: t })
				expect(frame.motion.layers[0].drawnFrom).toBe(fromClip ? 'clip' : 'captured')
				expect(Math.round((await grayAt(frame.path)) / 3)).toBe(k)
			}
		}
	}, 60_000)
})
