import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from '@shared/types'
import { getFFmpegBinaryPath, getFFprobeBinaryPath } from '../ffmpeg/binaries'
import { TRANSITION_PRESETS } from '@shared/transitionPresets'
import { computeRegions } from './render'
import { buildRegionGraph, type OverlapRegion, type Region, type RegionPlan } from './renderBuilders'
import { previewPlan, renderTransitionWindow } from './preview'
import { burnCaptions } from './captions'
import { normaliseLoudness } from './loudness'
import { deliver } from './deliver'
import { duckExpression } from '@shared/ducking'
import { transformFilter } from '@shared/transform'
import { allEffects, effectChain } from '@shared/effects'
import { parsePack, starterManifest, STARTER_LOOKS, toCube } from '@shared/packs'

/**
 * End-to-end against the REAL bundled binary: proves the filtergraph this module
 * emits is accepted by ffmpeg and produces the picture and length it claims.
 * The unit tests assert the graph as strings; only this catches a graph that is
 * well-formed but wrong.
 */

const execFileAsync = promisify(execFile)

/** One applied effect, the shape a TimelineItem carries. */
const fx = (kind: string, params?: Record<string, number>) => [{ id: 'e', kind, params }]
const ffmpeg = getFFmpegBinaryPath()
const ffprobe = getFFprobeBinaryPath()

let dir: string
const A = () => join(dir, 'A.mp4')
const B = () => join(dir, 'B.mp4')
/** Red on the left half, black on the right — so a pan is measurable. */
const C = () => join(dir, 'C.mp4')
/** A blue subject on a chroma-green screen. */
const G = () => join(dir, 'G.mp4')

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

/**
 * Brightest pixel in the frame at `t`.
 *
 * NOT the average: text covers a small share of the frame, and a 1x1 downscale
 * rounds a line of white lettering on black straight down to zero — which is
 * how "libass renders nothing" was once concluded from a working build.
 */
const maxLumaAt = async (file: string, t: number): Promise<number> => {
	const { stdout } = await execFileAsync(ffmpeg,
		['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
			'-vf', 'format=gray', '-f', 'rawvideo', '-'],
		{ encoding: 'buffer', maxBuffer: 1 << 24 })
	return (stdout as unknown as Buffer).reduce((max, v) => (v > max ? v : max), 0)
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
		await execFileAsync(ffmpeg, [
			'-y', '-v', 'error',
			'-f', 'lavfi', '-i', 'color=c=0x00B140:s=320x180:d=4:r=30',
			'-f', 'lavfi', '-i', 'sine=frequency=500:duration=4',
			'-vf', 'drawbox=x=110:y=50:w=100:h=80:color=blue@1:t=fill',
			'-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '4', G()
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

	describe('compositing vs the real binary', () => {
		/** Mean RGB of a small window, as a fraction of the frame. */
		const patch = async (file: string, fx: number, fy: number): Promise<[number, number, number]> => {
			const { stdout } = await execFileAsync(ffmpeg,
				['-v', 'error', '-i', file, '-frames:v', '1',
					'-vf', `crop=24:24:${Math.round(fx * 320) - 12}:${Math.round(fy * 180) - 12},scale=1:1,format=rgb24`,
					'-f', 'rawvideo', '-'],
				{ encoding: 'buffer', maxBuffer: 1 << 20 })
			const buf = stdout as unknown as Buffer
			return [buf[0], buf[1], buf[2]]
		}

		/** Two video tracks: A underneath on v1, B on top of it on v2. */
		const stacked = (transform?: { scale?: number; x?: number; y?: number }) => {
			const v2: Track = { ...vtrack, id: 'v2', name: 'V2', order: 1 }
			const d = document()
			d.tracks = [vtrack, v2]
			d.timeline = [
				clip({ id: 'base', sourceAssetId: 'sa', trackId: 'v1', timelineStart: 0, in: 1, out: 2, duration: 1 }),
				clip({ id: 'pip', sourceAssetId: 'sb', trackId: 'v2', timelineStart: 0, in: 1, out: 2, duration: 1, transform })
			]
			d.timelineMeta = { fps: 30, width: 320, height: 180, duration: 0, frameChosen: true }
			return computeRegions(d, 'original')
		}

		it('carries every covering layer, top-most first', () => {
			const plan = stacked()
			const region = plan.regions[0]
			expect(region.kind).toBe('cut')
			// The walker has always carried these; until now only [0] was rendered.
			expect((region as { videoLayers: unknown[] }).videoLayers).toHaveLength(2)
		})

		it('an untransformed top layer still hides what is under it', () => {
			// The old behaviour, which must not change: a full-frame opaque layer on
			// top is the whole picture.
			const plan = stacked()
			return renderGraph(plan.regions[0], plan, 'stack-full.mp4').then(async (file) => {
				const [r, , b] = await patch(file, 0.5, 0.5)
				expect(b).toBeGreaterThan(150) // B is blue
				expect(r).toBeLessThan(80)
			})
		}, 90_000)

		it('shows the layer underneath around a scaled-down one', async () => {
			// This is picture-in-picture: blue in the middle, red around it. It only
			// works if the area the scale vacates ends up TRANSPARENT — pad it with
			// black and the base disappears under a black frame instead.
			const plan = stacked({ scale: 0.4 })
			const file = await renderGraph(plan.regions[0], plan, 'stack-pip.mp4')

			const [cr, , cb] = await patch(file, 0.5, 0.5)
			expect(cb, 'centre should be the PiP').toBeGreaterThan(150)
			expect(cr).toBeLessThan(80)

			const [er, , eb] = await patch(file, 0.1, 0.5)
			expect(er, 'edge should be the layer underneath').toBeGreaterThan(150)
			expect(eb).toBeLessThan(80)
		}, 90_000)

		it('puts the inset where the transform asks', async () => {
			const plan = stacked({ scale: 0.3, x: 0.3, y: -0.3 })
			const file = await renderGraph(plan.regions[0], plan, 'stack-corner.mp4')
			const [, , topRight] = await patch(file, 0.8, 0.2)
			expect(topRight, 'PiP should be up and to the right').toBeGreaterThan(150)
			const [bottomLeftR] = await patch(file, 0.2, 0.8)
			expect(bottomLeftR, 'and not down and to the left').toBeGreaterThan(150)
		}, 90_000)

		it('encodes a pixel format h264 can actually take', async () => {
			const plan = stacked({ scale: 0.4 })
			const file = await renderGraph(plan.regions[0], plan, 'stack-fmt.mp4')
			const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
				'-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', file])
			expect(stdout.trim()).toBe('yuv420p')
		}, 90_000)
	})

	describe('keying — a subject IN FRONT of a background', () => {
		/**
		 * The layer the compositor was built for. Phase 3 could put a layer
		 * BESIDE another; a key is what puts one IN FRONT.
		 */
		const keyed = (key?: Parameters<typeof clip>[0]['key']) => {
			const v2: Track = { ...vtrack, id: 'v2', name: 'V2', order: 1 }
			const d = document()
			d.tracks = [vtrack, v2]
			d.media = [asset('sa', A()), asset('sg', G())]
			d.timeline = [
				clip({ id: 'bg', sourceAssetId: 'sa', trackId: 'v1', timelineStart: 0, in: 0, out: 1, duration: 1 }),
				clip({ id: 'fg', sourceAssetId: 'sg', trackId: 'v2', timelineStart: 0, in: 0, out: 1, duration: 1, key })
			]
			d.timelineMeta = { fps: 30, width: 320, height: 180, duration: 0, frameChosen: true }
			return computeRegions(d, 'original')
		}

		const patch = async (file: string, fx: number, fy: number): Promise<[number, number, number]> => {
			const { stdout } = await execFileAsync(ffmpeg,
				['-v', 'error', '-i', file, '-frames:v', '1',
					'-vf', `crop=16:16:${Math.round(fx * 320) - 8}:${Math.round(fy * 180) - 8},scale=1:1,format=rgb24`,
					'-f', 'rawvideo', '-'],
				{ encoding: 'buffer', maxBuffer: 1 << 20 })
			const buf = stdout as unknown as Buffer
			return [buf[0], buf[1], buf[2]]
		}

		it('without a key, the green screen covers everything', async () => {
			const plan = keyed()
			const file = await renderGraph(plan.regions[0], plan, 'key-off.mp4')
			const [, g] = await patch(file, 0.15, 0.5)
			expect(g, 'the screen itself').toBeGreaterThan(100)
		}, 90_000)

		it('with a key, the background shows through and the subject does not', async () => {
			const plan = keyed({ kind: 'chroma', colour: '#00B140', similarity: 0.3, blend: 0.05, despill: 0.4 })
			const file = await renderGraph(plan.regions[0], plan, 'key-on.mp4')

			// Where the screen was, A (red) now shows through.
			const [edgeR, edgeG] = await patch(file, 0.12, 0.5)
			expect(edgeR, 'background should show through').toBeGreaterThan(150)
			expect(edgeG).toBeLessThan(90)

			// The subject — a blue box on the green source — survives.
			const [, , centreB] = await patch(file, 0.5, 0.5)
			expect(centreB, 'the subject should survive the key').toBeGreaterThan(120)
		}, 90_000)

		it('still encodes something h264 can take', async () => {
			const plan = keyed({ kind: 'chroma', colour: '#00B140' })
			const file = await renderGraph(plan.regions[0], plan, 'key-fmt.mp4')
			const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
				'-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', file])
			expect(stdout.trim()).toBe('yuv420p')
		}, 90_000)
	})

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

describe('effects vs the real binary', () => {
	// The unit tests assert the filter STRINGS. These prove the strings are
	// filters this build accepts, and that each one moves the picture the way
	// its label promises — the only check that catches a well-formed filter
	// pointed the wrong way.
	let fxDir: string
	let grey: string

	/** Mean RGB of a one-frame render of `chain` applied to the grey source. */
	const through = async (chain: string, name: string): Promise<[number, number, number]> => {
		const out = join(fxDir, `${name}.png`)
		await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-i', grey, '-frames:v', '1',
			...(chain ? ['-vf', chain] : []), out])
		const { stdout } = await execFileAsync(ffmpeg,
			['-v', 'error', '-i', out, '-frames:v', '1', '-vf', 'scale=1:1,format=rgb24',
				'-f', 'rawvideo', '-'],
			{ encoding: 'buffer', maxBuffer: 1 << 20 })
		const buf = stdout as unknown as Buffer
		return [buf[0], buf[1], buf[2]]
	}

	beforeAll(async () => {
		fxDir = await fs.mkdtemp(join(tmpdir(), 'ff-fx-'))
		// A mid-grey with a colour cast: flat enough to measure, coloured enough
		// that saturation and hue have something to act on.
		grey = join(fxDir, 'grey.mp4')
		await execFileAsync(ffmpeg, ['-y', '-v', 'error',
			'-f', 'lavfi', '-i', 'color=c=0x806040:s=160x90:d=1:r=10',
			'-c:v', 'libx264', '-preset', 'ultrafast', '-t', '1', grey])
	}, 60_000)

	afterAll(async () => { await fs.rm(fxDir, { recursive: true, force: true }) })

	it('accepts every filter the catalogue can emit', async () => {
		// Guards against drift the way the transition catalogue test does: an
		// ffmpeg upgrade dropping a filter would otherwise surface as a failed
		// export rather than a failed test.
		for (const def of allEffects()) {
			if (def.stream !== 'video') continue
			// A value away from the identity, so `build` returns something.
			const params: Record<string, number> = {}
			for (const p of def.params) {
				if (p.kind !== 'number') continue
				params[p.key] = p.default === p.max ? p.min : p.max
			}
			const chain = def.build(params)
			if (!chain) continue
			await expect(through(chain, `accept-${def.kind}`), def.kind).resolves.toBeDefined()
		}
	}, 120_000)

	it('renders the starter pack’s LUTs, generated and loaded like any other pack', async () => {
		// The looks this app ships go through the pack loader rather than being
		// registered directly, so the seam a third-party pack uses is exercised
		// on every launch. This proves the files that seam produces are real
		// LUTs ffmpeg will apply.
		const parsed = parsePack(starterManifest(), (name) => {
			const file = join(fxDir, name)
			const look = STARTER_LOOKS.find((l) => `${l.kind}.cube` === name)!
			writeFileSync(file, toCube(look.label, 17, look.map), 'utf-8')
			return file
		})
		expect(parsed.problems).toEqual([])

		const base = await through('', 'lut-base')
		for (const effect of parsed.effects) {
			const out = await through(effect.build({}), `lut-${effect.kind}`)
			// A look that changed nothing would be a look nobody would notice.
			const distance = Math.abs(out[0] - base[0]) + Math.abs(out[1] - base[1]) + Math.abs(out[2] - base[2])
			expect(distance, effect.kind).toBeGreaterThan(3)
		}
	}, 120_000)

	it('moves the picture the way each label promises', async () => {
		const base = await through('', 'base')
		const luma = (c: [number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
		const spread = (c: [number, number, number]) => Math.max(...c) - Math.min(...c)

		expect(luma(await through(effectChain(fx('exposure', { amount: 0.3 }), 'video').join(','), 'up')))
			.toBeGreaterThan(luma(base))
		expect(luma(await through(effectChain(fx('exposure', { amount: -0.3 }), 'video').join(','), 'down')))
			.toBeLessThan(luma(base))

		// Saturation to zero must leave grey: R, G and B collapse together.
		expect(spread(await through(effectChain(fx('saturation', { amount: 0 }), 'video').join(','), 'mono')))
			.toBeLessThan(6)
		expect(spread(await through(effectChain(fx('saturation', { amount: 2.5 }), 'video').join(','), 'vivid')))
			.toBeGreaterThan(spread(base))

		// Warm pushes red up relative to blue; cool does the reverse.
		const warm = await through(effectChain(fx('warmth', { kelvin: 2500 }), 'video').join(','), 'warm')
		const cool = await through(effectChain(fx('warmth', { kelvin: 11000 }), 'video').join(','), 'cool')
		expect(warm[0] - warm[2]).toBeGreaterThan(cool[0] - cool[2])

		// A negative is a negative.
		const negative = await through(effectChain(fx('look-negative'), 'video').join(','), 'neg')
		expect(luma(negative)).toBeLessThan(255)
		expect(Math.abs(negative[0] - (255 - base[0]))).toBeLessThan(40)
	}, 120_000)
})

describe('transform vs the real binary', () => {
	let trDir: string
	let dot: string

	/** Where the brightest pixel is, as a fraction of the frame. */
	const brightestAt = async (file: string): Promise<{ x: number; y: number; max: number }> => {
		const w = 160, h = 90
		const { stdout } = await execFileAsync(ffmpeg,
			['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h},format=gray`,
				'-f', 'rawvideo', '-'],
			{ encoding: 'buffer', maxBuffer: 1 << 24 })
		const buf = stdout as unknown as Buffer
		let best = -1, at = 0
		for (let i = 0; i < buf.length; i++) if (buf[i] > best) { best = buf[i]; at = i }
		return { x: (at % w) / w, y: Math.floor(at / w) / h, max: best }
	}

	const render = async (transform: Parameters<typeof transformFilter>[0], name: string) => {
		const out = join(trDir, `${name}.mp4`)
		const chain = transformFilter(transform, 320, 180)
		await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-i', dot, '-frames:v', '1',
			...(chain ? ['-vf', chain] : []), out])
		return out
	}

	beforeAll(async () => {
		trDir = await fs.mkdtemp(join(tmpdir(), 'ff-tr-'))
		// A small white square dead centre of a black frame: the one shape whose
		// position after a transform can be measured rather than eyeballed.
		dot = join(trDir, 'dot.mp4')
		await execFileAsync(ffmpeg, ['-y', '-v', 'error',
			'-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1:r=10',
			'-vf', 'drawbox=x=150:y=80:w=20:h=20:color=white@1:t=fill',
			'-c:v', 'libx264', '-preset', 'ultrafast', '-t', '1', dot])
	}, 60_000)

	afterAll(async () => { await fs.rm(trDir, { recursive: true, force: true }) })

	it('leaves the picture alone when the transform is inert', async () => {
		const untouched = await brightestAt(await render({ scale: 1 }, 'inert'))
		expect(untouched.x).toBeCloseTo(0.5, 1)
		expect(untouched.y).toBeCloseTo(0.5, 1)
	}, 60_000)

	it('moves the picture the way the numbers say, not the opposite way', async () => {
		// The crop window moves opposite the content, which is exactly the sign
		// error this test exists to catch.
		const right = await brightestAt(await render({ x: 0.25 }, 'right'))
		expect(right.x).toBeGreaterThan(0.68)
		expect(right.y).toBeCloseTo(0.5, 1)

		const up = await brightestAt(await render({ y: -0.25 }, 'up'))
		expect(up.y).toBeLessThan(0.32)
	}, 60_000)

	it('shrinks into the frame and grows past it', async () => {
		const corners = async (file: string) => {
			const { stdout } = await execFileAsync(ffmpeg,
				['-v', 'error', '-i', file, '-frames:v', '1',
					'-vf', 'crop=40:40:0:0,format=gray', '-f', 'rawvideo', '-'],
				{ encoding: 'buffer', maxBuffer: 1 << 20 })
			return (stdout as unknown as Buffer).reduce((max, v) => (v > max ? v : max), 0)
		}
		// Small: the square is still one square, still centred, corners black.
		const small = await brightestAt(await render({ scale: 0.4 }, 'small'))
		expect(small.x).toBeCloseTo(0.5, 1)
		expect(await corners(await render({ scale: 0.4 }, 'small'))).toBeLessThan(24)

		// Big: the square fills more of the frame, so a fixed-size sample away
		// from centre now catches it.
		const bigFile = await render({ scale: 4 }, 'big')
		const { stdout } = await execFileAsync(ffmpeg,
			['-v', 'error', '-i', bigFile, '-frames:v', '1',
				'-vf', 'crop=40:40:100:70,format=gray', '-f', 'rawvideo', '-'],
			{ encoding: 'buffer', maxBuffer: 1 << 20 })
		expect((stdout as unknown as Buffer).reduce((m, v) => (v > m ? v : m), 0)).toBeGreaterThan(200)
	}, 60_000)

	it('animates a position across the clip', async () => {
		// The keyframe evaluator and the ffmpeg expression are separately tested
		// to agree; this proves the expression is one ffmpeg will actually run,
		// and that it moves the picture over TIME rather than once at init.
		const chain = transformFilter(undefined, 320, 180, false, {
			tracks: { 'transform.x': [{ t: 0, value: -0.3 }, { t: 2, value: 0.3 }] }
		})
		expect(chain).toContain('crop=320:180:x=')

		const out = join(trDir, 'anim.mp4')
		await execFileAsync(ffmpeg, ['-y', '-v', 'error',
			'-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=2:r=10',
			'-vf', `drawbox=x=150:y=80:w=20:h=20:color=white@1:t=fill,${chain}`,
			'-c:v', 'libx264', '-preset', 'ultrafast', '-t', '2', out])

		const at = async (t: number) => {
			const { stdout } = await execFileAsync(ffmpeg,
				['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1',
					'-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-'],
				{ encoding: 'buffer', maxBuffer: 1 << 20 })
			const buf = stdout as unknown as Buffer
			let best = -1, idx = 0
			for (let i = 0; i < buf.length; i++) if (buf[i] > best) { best = buf[i]; idx = i }
			return (idx % 64) / 64
		}

		const start = await at(0.1)
		const middle = await at(1)
		const end = await at(1.9)
		expect(start).toBeLessThan(0.3)
		expect(middle).toBeGreaterThan(start)
		expect(end).toBeGreaterThan(middle)
		expect(end).toBeGreaterThan(0.7)
	}, 90_000)

	it('accepts a rotation', async () => {
		const rotated = await brightestAt(await render({ rotation: 30 }, 'rot'))
		// A centred square rotated about the centre is still centred.
		expect(rotated.max).toBeGreaterThan(200)
		expect(rotated.x).toBeCloseTo(0.5, 1)
	}, 60_000)
})

describe('audio vs the real binary', () => {
	let auDir: string
	let quiet: string

	/** Integrated loudness in LUFS, measured with ebur128. */
	const loudnessOf = async (file: string): Promise<number> => {
		const { stderr } = await execFileAsync(ffmpeg,
			['-v', 'info', '-i', file, '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-'],
			{ maxBuffer: 1 << 22 }).catch((e) => ({ stderr: e.stderr as string }))
		const match = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g
		let last: number | null = null
		for (const m of String(stderr).matchAll(match)) last = Number(m[1])
		if (last === null) throw new Error('ebur128 reported no integrated loudness')
		return last
	}

	beforeAll(async () => {
		auDir = await fs.mkdtemp(join(tmpdir(), 'ff-audio-'))
		// A quiet tone: well below the -14 LUFS target, so normalisation has to
		// move it UP and the direction of the fix is unambiguous.
		quiet = join(auDir, 'quiet.mp4')
		await execFileAsync(ffmpeg, ['-y', '-v', 'error',
			'-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=4:r=10',
			'-f', 'lavfi', '-i', 'sine=frequency=300:duration=4',
			'-af', 'volume=0.02',
			'-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '4', quiet
		])
	}, 60_000)

	afterAll(async () => { await fs.rm(auDir, { recursive: true, force: true }) })

	it('accepts every repair filter the catalogue can emit', async () => {
		for (const def of allEffects()) {
			if (def.stream !== 'audio') continue
			const params: Record<string, number> = {}
			for (const p of def.params) {
				if (p.kind !== 'number') continue
				params[p.key] = p.default === p.max ? p.min : p.max
			}
			const chain = def.build(params)
			if (!chain) continue
			await execFileAsync(ffmpeg, ['-y', '-v', 'error', '-i', quiet, '-af', chain,
				'-t', '1', '-f', 'null', '-'])
		}
	}, 120_000)

	it('ducks the bed under speech and lets it back up after', async () => {
		// A steady tone stands in for a music bed. Speech from 2s to 4s, so the
		// window either side must come back louder than the window inside — which
		// is the assertion an envelope pointed the wrong way fails.
		const expression = duckExpression(
			[{ start: 2, end: 4 }],
			{ start: 0, duration: 6 },
			{ ramp: 0.2 }
		)
		expect(expression).not.toBe('')

		const ducked = join(auDir, 'ducked.wav')
		await execFileAsync(ffmpeg, ['-y', '-v', 'error',
			'-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
			'-af', expression, ducked])

		const rmsAt = async (from: number) => {
			const { stderr } = await execFileAsync(ffmpeg,
				['-v', 'info', '-ss', String(from), '-t', '1', '-i', ducked,
					'-af', 'astats=metadata=1', '-f', 'null', '-'],
				{ maxBuffer: 1 << 22 }).catch((e) => ({ stderr: e.stderr as string }))
			const match = /RMS level dB:\s*(-?\d+(?:\.\d+)?)/g
			const values = [...String(stderr).matchAll(match)].map((m) => Number(m[1]))
			if (!values.length) throw new Error('astats reported no RMS')
			return Math.max(...values)
		}

		const before = await rmsAt(0.5)
		const during = await rmsAt(2.6)
		const after = await rmsAt(5)
		// -12 dB is what a depth of 0.25 comes to.
		expect(during).toBeLessThan(before - 8)
		expect(after).toBeGreaterThan(during + 8)
		expect(Math.abs(after - before)).toBeLessThan(1)
	}, 120_000)

	it('normalises a quiet mix up toward the streaming target', async () => {
		const before = await loudnessOf(quiet)
		expect(before).toBeLessThan(-25)

		const out = await normaliseLoudness({
			sourcePath: quiet,
			signal: new AbortController().signal
		})
		const after = await loudnessOf(out)
		// Single-pass loudnorm lands near the target, not exactly on it.
		expect(after).toBeGreaterThan(before + 10)
		expect(Math.abs(after - -14)).toBeLessThan(3)
	}, 120_000)

	it('leaves the picture untouched, because it only re-encodes audio', async () => {
		const out = await normaliseLoudness({
			sourcePath: quiet,
			signal: new AbortController().signal
		})
		const codecOf = async (file: string) => {
			const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
				'-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', file])
			return stdout.trim()
		}
		expect(await codecOf(out)).toBe(await codecOf(quiet))
	}, 120_000)
})

describe('delivery vs the real binary', () => {
	let dlDir: string
	let source: string

	beforeAll(async () => {
		dlDir = await fs.mkdtemp(join(tmpdir(), 'ff-dl-'))
		source = join(dlDir, 'src.mp4')
		await execFileAsync(ffmpeg, ['-y', '-v', 'error',
			'-f', 'lavfi', '-i', 'testsrc=s=320x180:d=1:r=10',
			'-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
			'-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '1', source])
	}, 60_000)

	afterAll(async () => { await fs.rm(dlDir, { recursive: true, force: true }) })

	it('does nothing at all for the format the render already produced', async () => {
		// An identity transcode would cost a full encode and a generation of
		// quality for a file that is already correct.
		expect(await deliver({ sourcePath: source, format: 'h264', signal: new AbortController().signal }))
			.toBeNull()
	})

	it('writes a real ProRes 422 HQ file, with PCM audio', async () => {
		const out = await deliver({
			sourcePath: source, format: 'prores', signal: new AbortController().signal
		})
		expect(out).toMatch(/\.mov$/)
		const { stdout } = await execFileAsync(ffprobe, ['-v', 'error',
			'-show_entries', 'stream=codec_name,profile,pix_fmt', '-of', 'csv=p=0', out!])
		expect(stdout).toContain('prores')
		expect(stdout).toContain('yuv422p10le')
		// PCM is the ProRes convention: an intermediate that will be encoded
		// again downstream should not carry a lossy track.
		expect(stdout).toContain('pcm_s16le')
	}, 90_000)

	it('keeps the picture, rather than quietly rescaling it', async () => {
		const out = await deliver({
			sourcePath: source, format: 'prores', signal: new AbortController().signal
		})
		const size = async (file: string) => {
			const { stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
				'-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
			return stdout.trim()
		}
		expect(await size(out!)).toBe(await size(source))
	}, 90_000)
})

describe('captions vs the real binary', () => {
	let capDir: string
	let black: string

	beforeAll(async () => {
		// A colon, a comma and brackets in the directory name: the escaping has
		// three parsers to satisfy, and a home directory really can contain them.
		capDir = await fs.mkdtemp(join(tmpdir(), 'ff-cap-'))
		capDir = join(capDir, "weird: dir, [x]'y")
		await fs.mkdir(capDir, { recursive: true })
		black = join(capDir, 'black.mp4')
		await execFileAsync(ffmpeg, [
			'-y', '-v', 'error',
			'-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=3:r=15',
			'-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
			'-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '3', black
		])
	}, 60_000)

	afterAll(async () => {
		await fs.rm(capDir, { recursive: true, force: true })
	})

	it('burns a cue, and only inside its own window', async () => {
		const out = await burnCaptions({
			sourcePath: black,
			workDir: capDir,
			cues: [{ start: 1, end: 2, text: 'HELLO' }],
			frame: { width: 320, height: 180 },
			signal: new AbortController().signal
		})

		expect(await maxLumaAt(out, 1.5)).toBeGreaterThan(200)  // white text
		expect(await maxLumaAt(out, 0.4)).toBeLessThan(24)      // still black
		expect(await maxLumaAt(out, 2.6)).toBeLessThan(24)
	}, 90_000)

	it('renders right-to-left text', async () => {
		// libass carries FriBidi and HarfBuzz inside it, not as an ffmpeg
		// configure flag — which is why `-version` does not mention them and this
		// is worth asserting rather than assuming.
		const out = await burnCaptions({
			sourcePath: black,
			workDir: capDir,
			cues: [{ start: 1, end: 2, text: 'سلام دنیا' }],
			frame: { width: 320, height: 180 },
			signal: new AbortController().signal
		})
		expect(await maxLumaAt(out, 1.5)).toBeGreaterThan(200)
	}, 90_000)

	it('burns a positioned title where it was placed', async () => {
		// The title sits in the top-left quadrant, so the bottom half must stay
		// black — which is the assertion that catches a placement pointed at the
		// wrong corner, something a "did any pixel light up" test cannot.
		const out = await burnCaptions({
			sourcePath: black,
			workDir: capDir,
			cues: [{
				start: 0.5, end: 2.5, text: 'TOP LEFT',
				override: '{\\an5\\pos(80,45)\\fs28\\1c&H00FFFFFF&\\b1}'
			}],
			frame: { width: 320, height: 180 },
			signal: new AbortController().signal
		})

		const half = async (crop: string) => {
			const { stdout } = await execFileAsync(ffmpeg,
				['-v', 'error', '-ss', '1.5', '-i', out, '-frames:v', '1',
					'-vf', `crop=${crop},format=gray`, '-f', 'rawvideo', '-'],
				{ encoding: 'buffer', maxBuffer: 1 << 24 })
			return (stdout as unknown as Buffer).reduce((max, v) => (v > max ? v : max), 0)
		}
		expect(await half('320:90:0:0')).toBeGreaterThan(200)    // top half: text
		expect(await half('320:90:0:90')).toBeLessThan(24)       // bottom half: black
	}, 90_000)

	it('leaves the source file alone', async () => {
		const before = (await fs.stat(black)).size
		await burnCaptions({
			sourcePath: black,
			workDir: capDir,
			cues: [{ start: 0.5, end: 1, text: 'x' }],
			frame: { width: 320, height: 180 },
			signal: new AbortController().signal
		})
		expect((await fs.stat(black)).size).toBe(before)
	}, 90_000)
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
