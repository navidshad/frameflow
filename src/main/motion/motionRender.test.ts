import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile, spawn } from 'child_process'
import { createRequire } from 'module'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { promisify } from 'util'
import { build } from 'vite'
import type { EditorDocument, TimelineItem, Track } from '@shared/types'
import { motionFrameCount } from '@shared/motion'
import { getFFmpegBinaryPath, getFFprobeBinaryPath } from '../ffmpeg/binaries'
import { computeRegions } from '../editor/render'
import { buildRegionGraph, motionJobsFor, regionAtInstant, type CutRegion } from '../editor/renderBuilders'
import { motionClipPath } from './cache'
import type { MotionJob } from './index'

/**
 * A motion template, REALLY rendered: the hidden-window capture and the qtrle
 * encode the export uses, run inside the real Electron binary, then checked
 * with the bundled ffprobe and composited through the real region graph.
 *
 * vitest cannot host a BrowserWindow, so this builds `harness/render-harness.ts`
 * — which imports the production `renderMotionClip` unchanged — and spawns
 * Electron on it. Skipped only where Electron cannot open a window at all
 * (Linux with no display, i.e. CI); everywhere else it runs.
 */

const execFileAsync = promisify(execFile)
const ffmpeg = getFFmpegBinaryPath()
const ffprobe = getFFprobeBinaryPath()
const canOpenWindows = process.platform !== 'linux' || !!process.env.DISPLAY

const W = 640
const H = 360

let dir: string
let harness: string

const lowerThird = (over: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'lt', trackId: 'm1', sourceAssetId: '', timelineStart: 0,
	in: 0, out: 4, speed: 1, preservePitch: true, duration: 4,
	label: 'Lower third', motion: { template: 'lower-third' }, ...over
})

/** Run jobs through the real Electron capture. */
async function renderInElectron(jobs: MotionJob[]): Promise<{ timings: number[] }> {
	const jobsFile = join(dir, `jobs-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
	writeFileSync(jobsFile, JSON.stringify(jobs))
	const electron = createRequire(import.meta.url)('electron') as string
	const env = { ...process.env }
	delete env.ELECTRON_RUN_AS_NODE
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(electron, [harness, jobsFile], { env })
		let out = ''
		let err = ''
		child.stdout.on('data', (d) => { out += d })
		child.stderr.on('data', (d) => { err += d })
		child.on('error', reject)
		child.on('close', (code) => {
			const line = out.split('\n').find((l) => l.startsWith('FRAMEFLOW_RESULT '))
			if (code === 0 && line) resolvePromise(JSON.parse(line.slice('FRAMEFLOW_RESULT '.length)))
			else reject(new Error(`electron exited ${code}\n${err.slice(-2000)}`))
		})
	})
}

const probe = async (file: string) => {
	const { stdout } = await execFileAsync(ffprobe, [
		'-v', 'error', '-count_frames', '-select_streams', 'v:0',
		'-show_entries', 'stream=codec_name,pix_fmt,width,height,r_frame_rate,nb_read_frames:format=duration',
		'-of', 'json', file
	])
	const json = JSON.parse(stdout)
	return { ...json.streams[0], duration: Number(json.format.duration) }
}

/** One decoded frame as straight RGBA. */
const rgbaAt = async (file: string, t: number): Promise<Buffer> => {
	const { stdout } = await execFileAsync(ffmpeg,
		['-v', 'error', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
		{ encoding: 'buffer', maxBuffer: 1 << 24 })
	return stdout as unknown as Buffer
}

/** Per-frame decoded hashes — identical lists mean identical pictures. */
const frameHashes = async (file: string): Promise<string[]> => {
	const { stdout } = await execFileAsync(ffmpeg,
		['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], { maxBuffer: 1 << 24 })
	return stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim())
}

const px = (buf: Buffer, x: number, y: number, width = W) => {
	const o = (y * width + x) * 4
	return [buf[o], buf[o + 1], buf[o + 2], buf[o + 3]]
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'frameflow-motion-'))
	if (!canOpenWindows) return
	// Bundle the harness the way electron-vite bundles main: `@shared` resolved,
	// `?raw` templates inlined, Electron and Node left external.
	const outDir = join(dir, 'harness')
	await build({
		configFile: false,
		logLevel: 'silent',
		resolve: { alias: { '@shared': resolve('src/shared') } },
		build: {
			ssr: resolve('src/main/motion/harness/render-harness.ts'),
			outDir,
			emptyOutDir: true,
			minify: false,
			rollupOptions: {
				external: ['electron'],
				output: { format: 'cjs', entryFileNames: 'render-harness.cjs' }
			}
		}
	})
	harness = join(outDir, 'render-harness.cjs')
}, 60_000)

afterAll(() => {
	if (dir && !process.env.KEEP_MOTION_TEST) rmSync(dir, { recursive: true, force: true })
	else if (dir) console.log('kept', dir)
})

describe.skipIf(!canOpenWindows)('motion layers, rendered for real', () => {
	const fps = 15
	const frame = { width: W, height: H, fps }
	let first: string
	let second: string
	let faded: string

	beforeAll(async () => {
		first = join(dir, 'lower-third-a.mov')
		second = join(dir, 'lower-third-b.mov')
		faded = join(dir, 'lower-third-faded.mov')
		const half = lowerThird({ keyframes: { opacity: [{ t: 0, value: 0.5 }] } })
		// Two separate processes for the two copies: determinism across windows,
		// not just across frames of one.
		await renderInElectron([
			{ item: lowerThird(), frame, outputPath: first },
			{ item: half, frame, outputPath: faded }
		])
		await renderInElectron([{ item: lowerThird(), frame, outputPath: second }])
	}, 180_000)

	it('encodes a lossless alpha .mov at the sequence size and rate', async () => {
		const info = await probe(first)
		expect(info.codec_name).toBe('qtrle')
		expect(info.pix_fmt).toBe('argb')
		expect([info.width, info.height]).toEqual([W, H])
		expect(info.r_frame_rate).toBe('15/1')
	})

	it('runs exactly the clip’s length, one frame per tick', async () => {
		const info = await probe(first)
		expect(Number(info.nb_read_frames)).toBe(motionFrameCount(4, fps))
		expect(info.duration).toBeCloseTo(4, 2)
	})

	it('carries real transparency: clear around the lower third, solid on it', async () => {
		const hold = await rgbaAt(first, 2)
		let clear = 0
		let solid = 0
		for (let i = 3; i < hold.length; i += 4) {
			if (hold[i] === 0) clear++
			else if (hold[i] >= 240) solid++
		}
		const pixels = W * H
		expect(clear / pixels).toBeGreaterThan(0.8)
		expect(solid).toBeGreaterThan(1000)
		// Top-left corner is nothing at all.
		expect(px(hold, 5, 5)[3]).toBe(0)
		// The accent bar: left 6%, at 70.3% down plus a little, 1.5rem wide.
		const [r, g, b, a] = px(hold, Math.round(W * 0.06) + 2, Math.round(H * 0.703) + 10)
		expect(a).toBe(255)
		expect(Math.abs(r - 0xec)).toBeLessThanOrEqual(6)
		expect(Math.abs(g - 0x48)).toBeLessThanOrEqual(6)
		expect(Math.abs(b - 0x99)).toBeLessThanOrEqual(6)
	})

	it('stores straight alpha, not premultiplied: a half-opacity layer keeps its colour', async () => {
		const hold = await rgbaAt(faded, 2)
		const [r, g, b, a] = px(hold, Math.round(W * 0.06) + 2, Math.round(H * 0.703) + 10)
		expect(a).toBeGreaterThan(120)
		expect(a).toBeLessThan(135)
		// Premultiplied would have halved these too.
		expect(Math.abs(r - 0xec)).toBeLessThanOrEqual(8)
		expect(Math.abs(g - 0x48)).toBeLessThanOrEqual(8)
		expect(Math.abs(b - 0x99)).toBeLessThanOrEqual(8)
	})

	it('changes over time: the entrance moves, the hold holds', async () => {
		const hashes = await frameHashes(first)
		// Frames 0..5 are the 0.4s entrance at 15 fps: every one differs.
		expect(new Set(hashes.slice(0, 6)).size).toBe(6)
		// Mid-hold, nothing moves.
		expect(hashes[30]).toBe(hashes[31])
		// The exit differs from the hold.
		expect(hashes[59]).not.toBe(hashes[30])
	})

	it('renders identically twice — same pixels, frame for frame', async () => {
		expect(await frameHashes(second)).toEqual(await frameHashes(first))
	})
})

describe.skipIf(!canOpenWindows)('a motion layer through the export graph', () => {
	const bg: Track = { id: 'bg', kind: 'video', name: 'BG', order: -1, muted: false, locked: false, hidden: false, height: 48 }
	const m1: Track = { id: 'm1', kind: 'video', name: 'M1', order: 1, muted: false, locked: false, hidden: false, height: 64 }
	const doc = (): EditorDocument => ({
		schemaVersion: 2,
		media: [],
		tracks: [bg, m1],
		timeline: [
			{
				id: 'g', trackId: 'bg', sourceAssetId: '', timelineStart: 0, in: 0, out: 4, speed: 1,
				preservePitch: true, duration: 4, generator: { kind: 'solid', colour: '#1E40AF' }
			},
			// Starts at 1s, so the clip's own time and the timeline's differ.
			lowerThird({ timelineStart: 1, out: 3, duration: 3 })
		],
		timelineMeta: { fps: 30, width: W, height: H, duration: 4, frameChosen: true },
		activePersonaId: 'p', turns: [], historyRef: { currentStepId: null as any, stepCount: 0 }
	})

	it('composites the page over the layer below, at the right moment', async () => {
		const motionDir = join(dir, 'cache')
		const plan = computeRegions(doc(), 'original', {}, { motionDir })
		const jobs = motionJobsFor(plan.regions)
		expect(jobs).toHaveLength(1)
		expect(jobs[0].outputPath).toBe(motionClipPath(motionDir, jobs[0].item, { width: W, height: H, fps: 30 }))
		await renderInElectron(jobs)
		expect(existsSync(jobs[0].outputPath)).toBe(true)

		const region = plan.regions.find((r) => r.kind === 'cut' && r.videoLayers.length === 2) as CutRegion
		// 2s on the timeline = 1s into the clip: the hold, fully on screen.
		const regionStart = 1
		const still = regionAtInstant(region, 2 - regionStart, plan.fps)
		const graph = buildRegionGraph(still, plan)
		const out = join(dir, 'composite.png')
		const args = ['-y', '-v', 'error']
		for (const input of graph.inputs) {
			if (input.format) args.push('-f', input.format)
			args.push(...input.options, '-i', input.path)
		}
		args.push('-filter_complex', [...graph.filters, `${graph.audio}anullsink`].join(';'),
			'-map', graph.video, '-frames:v', '1', out)
		await execFileAsync(ffmpeg, args)
		const pic = await rgbaAt(out, 0)

		// Clear of the lower third: the blue background shows through untouched.
		const [r0, g0, b0] = px(pic, 600, 30)
		expect(Math.abs(r0 - 0x1e)).toBeLessThanOrEqual(6)
		expect(Math.abs(b0 - 0xaf)).toBeLessThanOrEqual(6)
		expect(g0).toBeLessThan(80)
		// On the accent bar: pink over the blue, not blue and not black.
		const [r1, g1, b1] = px(pic, Math.round(W * 0.06) + 2, Math.round(H * 0.703) + 10)
		expect(r1).toBeGreaterThan(200)
		expect(g1).toBeLessThan(110)
		expect(b1).toBeGreaterThan(120)
	}, 180_000)
})
