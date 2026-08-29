import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from '@shared/types'
import { getFFmpegBinaryPath, getFFprobeBinaryPath } from '../ffmpeg/binaries'
import { TRANSITION_PRESETS } from '@shared/transitionPresets'
import { computeRegions } from './render'
import { buildRegionGraph, type OverlapRegion, type Region, type RegionPlan } from './renderBuilders'
import { previewPlan, renderTransitionWindow } from './preview'

/**
 * End-to-end against the REAL bundled binary: proves the filtergraph this module
 * emits is accepted by ffmpeg and produces the picture and length it claims.
 * The unit tests assert the graph as strings; only this catches a graph that is
 * well-formed but wrong.
 */

const execFileAsync = promisify(execFile)
const ffmpeg = getFFmpegBinaryPath()
const ffprobe = getFFprobeBinaryPath()

let dir: string
const A = () => join(dir, 'A.mp4')
const B = () => join(dir, 'B.mp4')
/** Red on the left half, black on the right — so a pan is measurable. */
const C = () => join(dir, 'C.mp4')

/** Run a region's graph exactly as renderRegion would, and return the file. */
async function renderGraph(region: Region, plan: RegionPlan, name: string): Promise<string> {
	const graph = buildRegionGraph(region, plan)
	const args: string[] = ['-y', '-v', 'error']
	for (const input of graph.inputs) {
		if (input.format) args.push('-f', input.format)
		args.push(...input.options, '-i', input.path)
	}
	const out = join(dir, name)
	args.push(
		'-filter_complex', graph.filters.join(';'),
		'-map', graph.video, '-map', graph.audio,
		'-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
		'-t', region.duration.toFixed(3), out
	)
	await execFileAsync(ffmpeg, args)
	return out
}

const durationOf = async (file: string): Promise<number> => {
	const { stdout } = await execFileAsync(ffprobe,
		['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
	return Number(stdout.trim())
}

/** Average RGB of the frame at `t`, via a 1x1 downscale. */
const colourAt = async (file: string, t: number): Promise<[number, number, number]> => {
	const { stdout } = await execFileAsync(ffmpeg,
		['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
			'-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-'],
		{ encoding: 'buffer', maxBuffer: 1 << 20 })
	const buf = stdout as unknown as Buffer
	return [buf[0], buf[1], buf[2]]
}

// ===== Document fixtures =====

const asset = (id: string, file: string): MediaAsset => ({
	id, kind: 'video', name: id, originalPath: file,
	metadata: { duration: 4, width: 320, height: 180, fps: 30, hasAudio: true } as MediaAsset['metadata'],
	preprocessing: {}, clips: [], createdAt: 0
})

const vtrack: Track = {
	id: 'v1', kind: 'video', name: 'V1', order: 0,
	muted: false, locked: false, hidden: false, height: 72
}

const clip = (over: Partial<TimelineItem>): TimelineItem => ({
	id: 'x', trackId: 'v1', sourceAssetId: 'sa', timelineStart: 0,
	in: 0, out: 2, speed: 1, preservePitch: true, duration: 2, ...over
})

const document = (transition?: { kind: string; duration: number }): EditorDocument => ({
	schemaVersion: 1,
	media: [asset('sa', A()), asset('sb', B())],
	tracks: [vtrack],
	// Both clips trimmed 1s in from each end of a 4s source, so each has a full
	// second of handle either side and the window needs no repeated frames.
	timeline: [
		clip({ id: 'A', sourceAssetId: 'sa', timelineStart: 0, in: 1, out: 3, ...(transition ? { transition: { out: transition } } : {}) }),
		clip({ id: 'B', sourceAssetId: 'sb', timelineStart: 2, in: 1, out: 3 })
	],
	timelineMeta: { fps: 30, width: 320, height: 180, duration: 0 },
	activePersonaId: 'podcast-editor',
	turns: [],
	historyRef: { currentStepId: 'step-0', stepCount: 0 }
})

describe('render pipeline — against the real ffmpeg', () => {
	beforeAll(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'ff-render-'))
		// 4s red and blue sources, each with a distinct tone.
		for (const [file, colour, freq] of [[A(), 'red', 400], [B(), 'blue', 800]] as const) {
			await execFileAsync(ffmpeg, [
				'-y', '-v', 'error',
				'-f', 'lavfi', '-i', `color=c=${colour}:s=320x180:d=4:r=30`,
				'-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=4`,
				'-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '4', file
			])
		}
		await execFileAsync(ffmpeg, [
			'-y', '-v', 'error',
			'-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=4:r=30',
			'-f', 'lavfi', '-i', 'sine=frequency=600:duration=4',
			'-vf', 'drawbox=x=0:y=0:w=160:h=180:color=red@1:t=fill',
			'-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '4', C()
		])
	}, 60_000)

	afterAll(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it('renders an ordinary region to exactly its planned length', async () => {
		const plan = computeRegions(document(), 'original')
		const file = await renderGraph(plan.regions[0], plan, 'cut.mp4')
		expect(await durationOf(file)).toBeCloseTo(plan.regions[0].duration, 1)
	}, 60_000)

	it('renders a transition to exactly the window length', async () => {
		const plan = computeRegions(document({ kind: 'fade', duration: 1 }), 'original')
		const window = plan.regions.find((r): r is OverlapRegion => r.kind === 'overlap')!
		expect(window.duration).toBeCloseTo(1, 6)
		const file = await renderGraph(window, plan, 'xfade.mp4')
		expect(await durationOf(file)).toBeCloseTo(1, 1)
	}, 60_000)

	it('actually blends the two clips rather than cutting between them', async () => {
		const plan = computeRegions(document({ kind: 'fade', duration: 1 }), 'original')
		const window = plan.regions.find((r): r is OverlapRegion => r.kind === 'overlap')!
		const file = await renderGraph(window, plan, 'blend.mp4')

		const [r0, , b0] = await colourAt(file, 0.05)   // almost all outgoing
		const [rMid, , bMid] = await colourAt(file, 0.5) // half and half
		const [r1, , b1] = await colourAt(file, 0.95)   // almost all incoming

		expect(r0).toBeGreaterThan(b0)                  // starts red
		expect(b1).toBeGreaterThan(r1)                  // ends blue
		expect(rMid).toBeGreaterThan(30)                // the middle is BOTH,
		expect(bMid).toBeGreaterThan(30)                // which a hard cut never is
	}, 60_000)

	it('preserves the sequence length across the whole plan', async () => {
		// The property the concat demuxer depends on: a transition must not change
		// how long the finished video is.
		const withCut = computeRegions(document(), 'original')
		const withBlend = computeRegions(document({ kind: 'fade', duration: 1 }), 'original')
		const sum = (p: RegionPlan) => p.regions.reduce((s, r) => s + r.duration, 0)
		expect(sum(withBlend)).toBeCloseTo(sum(withCut), 6)

		const files: string[] = []
		for (const [i, region] of withBlend.regions.entries()) {
			files.push(await renderGraph(region, withBlend, `part-${i}.mp4`))
		}
		const rendered = await Promise.all(files.map(durationOf))
		expect(rendered.reduce((a, b) => a + b, 0)).toBeCloseTo(sum(withBlend), 1)
	}, 120_000)

	it('encodes a window at preview scale to a playable file', async () => {
		// REGRESSION. The encode wrote to `<key>.mp4.part`, and ffmpeg picks its
		// muxer from the extension — so EVERY preview failed with "Unable to
		// choose an output format", the monitor silently fell back to a
		// cross-fade, and every transition looked identical. Nothing caught it
		// because no test ran ffmpeg over this path.
		const plan = computeRegions(document({ kind: 'wipeleft', duration: 1 }), 'preview')
		const small = previewPlan(plan)
		const window = plan.regions.find((r): r is OverlapRegion => r.kind === 'overlap')!
		const out = join(dir, 'cached-window.mp4')

		await renderTransitionWindow(window, small, out)

		expect(await durationOf(out)).toBeCloseTo(window.duration, 1)
		// And it is the real preset, not a dissolve: a left wipe has a hard
		// vertical edge mid-transition, so the two halves differ sharply.
		const { stdout } = await execFileAsync(ffmpeg,
			['-v', 'error', '-ss', String(window.duration / 2), '-i', out, '-frames:v', '1',
				'-vf', 'scale=2:1,format=rgb24', '-f', 'rawvideo', '-'],
			{ encoding: 'buffer', maxBuffer: 1 << 20 })
		const px = stdout as unknown as Buffer
		const left = [px[0], px[1], px[2]]
		const right = [px[3], px[4], px[5]]
		expect(Math.abs(left[0] - right[0]) + Math.abs(left[2] - right[2])).toBeGreaterThan(60)
	}, 60_000)

	it('leaves no partial file behind', async () => {
		const plan = computeRegions(document({ kind: 'fade', duration: 1 }), 'preview')
		const window = plan.regions.find((r): r is OverlapRegion => r.kind === 'overlap')!
		const out = join(dir, 'no-partial.mp4')
		await renderTransitionWindow(window, previewPlan(plan), out)
		const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.part'))
		expect(leftovers).toEqual([])
	}, 60_000)

	it('reframes a landscape source into a portrait sequence', async () => {
		// The whole point of the feature: 16:9 footage exported 9:16. `fit` bars it,
		// `fill` crops it, and the pan chooses which third of the frame survives.
		// The sources are flat colours, so a letterbox is detectable as black.
		const portrait = (framing?: { mode: 'fit' | 'fill'; pan?: number }) => {
			const d = document()
			d.timelineMeta = { fps: 30, width: 180, height: 320, duration: 0, frameChosen: true }
			d.timeline = [clip({ id: 'A', sourceAssetId: 'sa', timelineStart: 0, in: 1, out: 3, framing })]
			return computeRegions(d, 'original')
		}

		const fitPlan = portrait({ mode: 'fit' })
		expect([fitPlan.width, fitPlan.height]).toEqual([180, 320])
		const fitFile = await renderGraph(fitPlan.regions[0], fitPlan, 'fit.mp4')
		const [, fitG, fitB] = await colourAt(fitFile, 0.5)

		const fillFile = await renderGraph(portrait({ mode: 'fill' }).regions[0], portrait({ mode: 'fill' }), 'fill.mp4')
		const [fillR] = await colourAt(fillFile, 0.5)

		// A is solid red. Filled, the frame is red edge to edge; fitted, most of it
		// is the black padding, so the average is far darker.
		expect(fillR).toBeGreaterThan(200)
		const fitAvg = await colourAt(fitFile, 0.5)
		expect(fitAvg[0]).toBeLessThan(fillR)
		expect(fitG + fitB).toBeLessThan(60)
	}, 60_000)

	it('pans the crop to the side of the source the user asked for', async () => {
		// C is red on the left, black on the right. Cover-scaling 16:9 into 9:16
		// keeps under a third of the width, so each extreme lands wholly inside
		// one half — which makes the pan visible as a colour rather than a shift.
		const panned = (pan: number) => {
			const d = document()
			d.media = [asset('sc', C())]
			d.timelineMeta = { fps: 30, width: 180, height: 320, duration: 0, frameChosen: true }
			d.timeline = [clip({
				id: 'A', sourceAssetId: 'sc', timelineStart: 0, in: 1, out: 3,
				framing: { mode: 'fill', pan }
			})]
			return computeRegions(d, 'original')
		}

		const leftPlan = panned(-1)
		const left = await renderGraph(leftPlan.regions[0], leftPlan, 'pan-left.mp4')
		const rightPlan = panned(1)
		const right = await renderGraph(rightPlan.regions[0], rightPlan, 'pan-right.mp4')

		expect((await colourAt(left, 0.5))[0]).toBeGreaterThan(200)
		expect((await colourAt(right, 0.5))[0]).toBeLessThan(40)
	}, 60_000)

	it('repeats frames instead of failing when neither clip has handles', async () => {
		const doc = document({ kind: 'fade', duration: 1 })
		// Untrimmed on both sides: no handle media anywhere.
		doc.timeline[0] = clip({ id: 'A', sourceAssetId: 'sa', timelineStart: 0, in: 0, out: 2, transition: { out: { kind: 'fade', duration: 1 } } })
		doc.timeline[1] = clip({ id: 'B', sourceAssetId: 'sb', timelineStart: 2, in: 0, out: 2 })
		doc.media = [asset('sa', A()), asset('sb', B())]
		doc.media[0].metadata!.duration = 2
		doc.media[1].metadata!.duration = 2

		const plan = computeRegions(doc, 'original')
		const window = plan.regions.find((r): r is OverlapRegion => r.kind === 'overlap')!
		expect(window.from.freezeTail).toBeGreaterThan(0)
		expect(window.to.freezeHead).toBeGreaterThan(0)

		const file = await renderGraph(window, plan, 'freeze.mp4')
		expect(await durationOf(file)).toBeCloseTo(window.duration, 1)
	}, 60_000)
})

describe('transition catalogue vs the real binary', () => {
	it('lists exactly the presets this ffmpeg build accepts', async () => {
		// Guards against drift: an ffmpeg upgrade that adds, renames or drops a
		// transition would otherwise surface as a failed export, not a failed test.
		const { stdout, stderr } = await execFileAsync(ffmpeg, ['-hide_banner', '-h', 'filter=xfade'])
		const help = `${stdout}${stderr}`
		const section = help.slice(help.indexOf('transition'))
		const offered = new Set<string>()
		for (const line of section.split('\n')) {
			const m = line.match(/^\s{5,}([a-z]+)\s+(-?\d+)\s/)
			if (m && m[1] !== 'custom') offered.add(m[1])
		}
		expect(offered.size).toBeGreaterThan(50)

		const catalogued = new Set(TRANSITION_PRESETS.map((p) => p.kind))
		expect([...offered].filter((k) => !catalogued.has(k)).sort()).toEqual([])
		expect([...catalogued].filter((k) => !offered.has(k)).sort()).toEqual([])
	}, 30_000)
})
