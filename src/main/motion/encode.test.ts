import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { EditorDocument, TimelineItem, Track } from '@shared/types'
import { getFFmpegBinaryPath, getFFprobeBinaryPath } from '../ffmpeg/binaries'
import { computeRegions } from '../editor/render'
import { allSlices, motionJobsFor, type CutRegion } from '../editor/renderBuilders'
import { encodeFrames, ffmpegArgs, unpremultiplyBgra } from './encode'
import { motionClipPath } from './cache'

/**
 * The half of the motion export that needs no window: the encoder against the
 * real binary, and the region walker's motion slices. Runs everywhere — CI
 * included, where the Electron-run test (motionRender.test.ts) has no display.
 */

const execFileAsync = promisify(execFile)
const ffmpeg = getFFmpegBinaryPath()
const ffprobe = getFFprobeBinaryPath()

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'frameflow-encode-')) })
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('unpremultiplyBgra', () => {
	it('restores the colour Chromium premultiplied, and zeroes clear pixels', () => {
		// Half-transparent red as Chromium returns it: B 0, G 0, R 128, A 128.
		const buf = Buffer.from([0, 0, 128, 128, 10, 20, 30, 0, 1, 2, 3, 255])
		unpremultiplyBgra(buf)
		expect([...buf]).toEqual([0, 0, 255, 128, 0, 0, 0, 0, 1, 2, 3, 255])
	})
})

describe('encodeFrames', () => {
	const frame = { width: 32, height: 16, fps: 10 }

	/** Frame k: a column k pixels wide, half-transparent pure red, premultiplied. */
	const synthetic = async (k: number) => {
		const buf = Buffer.alloc(frame.width * frame.height * 4)
		for (let y = 0; y < frame.height; y++) {
			for (let x = 0; x <= k; x++) buf.set([0, 0, 128, 128], (y * frame.width + x) * 4)
		}
		return buf
	}

	it('writes a qtrle argb .mov with straight alpha, frame for frame', async () => {
		const out = join(dir, 'synthetic.mov')
		const seen: number[] = []
		await encodeFrames({ frame, count: 8, next: synthetic, outputPath: out, onProgress: (d) => seen.push(d) })
		expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
		const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
			'-show_entries', 'stream=codec_name,pix_fmt,nb_read_frames,r_frame_rate', '-of', 'csv=p=0', out])
		expect(stdout.trim()).toBe('qtrle,argb,10/1,8')
		const raw = (await execFileAsync(ffmpeg, ['-v', 'error', '-ss', '0.5', '-i', out, '-frames:v', '1',
			'-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer' })).stdout as unknown as Buffer
		// Frame 5 covers columns 0..5: straight red at half alpha, clear beyond.
		expect([...raw.subarray(0, 4)]).toEqual([255, 0, 0, 128])
		expect([...raw.subarray(6 * 4, 6 * 4 + 4)]).toEqual([0, 0, 0, 0])
	})

	it('leaves nothing behind when a frame is the wrong size', async () => {
		const out = join(dir, 'bad.mov')
		await expect(encodeFrames({ frame, count: 2, next: async () => Buffer.alloc(10), outputPath: out }))
			.rejects.toThrow(/expected 2048/)
		expect(existsSync(out)).toBe(false)
		expect(readdirSync(dir).filter((f) => f.startsWith('bad'))).toEqual([])
	})

	it('names the partial file with a real extension, so ffmpeg can pick a muxer', () => {
		const args = ffmpegArgs(frame, '/x/abc.part.mov')
		expect(args[args.length - 1]).toMatch(/\.mov$/)
		expect(args).toContain('qtrle')
	})
})

describe('motion slices in the region plan', () => {
	const tracks: Track[] = [
		{ id: 'bg', kind: 'video', name: 'BG', order: -1, muted: false, locked: false, hidden: false, height: 48 },
		{ id: 'm1', kind: 'video', name: 'M1', order: 1, muted: false, locked: false, hidden: false, height: 64 }
	]
	const motion: TimelineItem = {
		// A trim left `in` at 0.5 — the slice must still index the clip's own file from 0.
		id: 'lt', trackId: 'm1', sourceAssetId: '', timelineStart: 1, in: 0.5, out: 3.5, speed: 1,
		preservePitch: true, duration: 3, label: 'Lower third', motion: { template: 'lower-third' },
		keyframes: { opacity: [{ t: 0, value: 0 }, { t: 1, value: 1 }] }
	}
	const doc: EditorDocument = {
		schemaVersion: 2, media: [], tracks,
		timeline: [
			{ id: 'g', trackId: 'bg', sourceAssetId: '', timelineStart: 0, in: 0, out: 5, speed: 1, preservePitch: true, duration: 5, generator: { kind: 'solid' } },
			motion
		],
		timelineMeta: { fps: 30, width: 640, height: 360, duration: 5, frameChosen: true },
		activePersonaId: 'p', turns: [], historyRef: { currentStepId: null as any, stepCount: 0 }
	}

	it('keys the clip by content for the plan’s frame, and plays it in clip seconds', () => {
		const plan = computeRegions(doc, 'original', {}, { motionDir: '/cache' })
		const slices = plan.regions.flatMap(allSlices).filter((s) => s.motion)
		expect(slices).toHaveLength(1)
		const [slice] = slices
		expect(slice.motion).toEqual({ width: 640, height: 360, fps: 30 })
		expect(slice.srcPath).toBe(motionClipPath('/cache', slice.item, slice.motion!))
		expect([slice.in, slice.out]).toEqual([0, 3])
		expect([slice.item.in, slice.item.out, slice.item.speed]).toEqual([0, 3, 1])
		// Top layer over the background, so it composites with alpha.
		const region = plan.regions.find((r) => r.kind === 'cut' && r.videoLayers.length === 2) as CutRegion
		expect(region.videoLayers[0].item.id).toBe('lt')
	})

	it('hands the export one job per distinct clip', () => {
		const plan = computeRegions(doc, 'original', {}, { motionDir: '/cache' })
		const jobs = motionJobsFor(plan.regions)
		expect(jobs.map((j) => j.item.id)).toEqual(['lt'])
	})

	it('is silent: a motion layer adds no audio to the mix', () => {
		const plan = computeRegions(doc, 'original', {}, { motionDir: '/cache' })
		expect(plan.regions.every((r) => r.audioSources.length === 0)).toBe(true)
	})
})
