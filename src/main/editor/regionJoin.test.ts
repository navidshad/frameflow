import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from '@shared/types'
import { getFFmpegBinaryPath, getFFprobeBinaryPath } from '../ffmpeg/binaries'
import { computeRegions, concatRegions, renderRegion } from './render'
import { motionJobsFor } from './renderBuilders'
import { AUDIO_RATE, concatLists, exactTailFilters, regionSpans, snapItemToFrames, spanTotals } from './regionJoin'

const execFileAsync = promisify(execFile)

describe('regionSpans — the length math', () => {
	// Durations like the ones a timeline full of motion layers produces: none of
	// them a whole number of frames.
	const durations = [1.0521, 1.6341, 1.3029, 1.7474, 1.7889, 0.7245, 0.625, 2.1912, 0.034, 1.0928]
	const total = durations.reduce((a, b) => a + b, 0)

	it.each([24, 25, 30000 / 1001, 30, 60])('adds up to the whole timeline on the frame grid at %s fps', (fps) => {
		const spans = regionSpans(durations, fps)
		const totals = spanTotals(spans, fps)
		expect(totals.frames).toBe(Math.round(total * fps))
		expect(totals.samples).toBe(Math.round(total * AUDIO_RATE))
		// Within half a frame of the timeline, however many regions there are.
		expect(Math.abs(totals.seconds - total)).toBeLessThanOrEqual(0.5 / fps + 1e-9)
		// The declared durations telescope: summed, they are the grid time of the end.
		const declared = spans.reduce((sum, s) => sum + Number(s.videoSec), 0)
		expect(Math.abs(declared - totals.frames / fps)).toBeLessThan(2e-6)
		const declaredAudio = spans.reduce((sum, s) => sum + Number(s.audioSec), 0)
		expect(Math.abs(declaredAudio - totals.samples / AUDIO_RATE)).toBeLessThan(2e-6)
	})

	it('never drifts, even across hundreds of regions', () => {
		const many = Array.from({ length: 500 }, (_, i) => 0.6 + ((i * 7919) % 1000) / 1000)
		const sum = many.reduce((a, b) => a + b, 0)
		const spans = regionSpans(many, 30)
		expect(spanTotals(spans, 30).frames).toBe(Math.round(sum * 30))
		// Every region boundary lands within half a frame of where the timeline puts it.
		let start = 0
		let frames = 0
		for (let i = 0; i < many.length; i++) {
			start += many[i]
			frames += spans[i].frames
			expect(Math.abs(frames / 30 - start)).toBeLessThanOrEqual(0.5 / 30 + 1e-9)
		}
	})

	it('gives a sliver under half a frame no picture, but keeps its sound', () => {
		const spans = regionSpans([1, 0.01, 1], 30)
		expect(spans[1].frames).toBe(0)
		expect(spans[1].samples).toBe(480)
		const lists = concatLists(['a.mov', 'b.mov', 'c.mov'], spans)
		expect(lists.video).not.toContain('b.mov')
		expect(lists.audio).toContain("file 'b.mov'\nduration 0.010000")
	})

	it('pins the region to its counts, padding black when the source has no picture left', () => {
		const tail = exactTailFilters({ video: '[v]', audio: '[a]' }, { frames: 32, samples: 50500 }, 30)
		expect(tail.filters).toEqual([
			'[v]setpts=N/FRAME_RATE/TB,tpad=stop_mode=clone:stop=2,tpad=stop_mode=add:stop_duration=1.100:color=black,trim=end_frame=32[vexact]',
			'[a]apad=whole_len=50500,atrim=end_sample=50500[aexact]'
		])
	})

	it('declares every file, quoted for the demuxer', () => {
		const spans = regionSpans([1, 1], 30)
		const lists = concatLists(["it's.mov", 'b.mov'], spans)
		expect(lists.video).toBe("file 'it'\\''s.mov'\nduration 1.000000\nfile 'b.mov'\nduration 1.000000")
	})
})

describe('snapItemToFrames', () => {
	const item = (over: Partial<TimelineItem>): TimelineItem => ({
		id: 'x', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0,
		in: 2, out: 4, speed: 1, preservePitch: true, duration: 2, ...over
	})

	it('leaves an item already on the grid as the same object', () => {
		const onGrid = item({ timelineStart: 1.5 })
		expect(snapItemToFrames(onGrid, 30)).toBe(onGrid)
	})

	it('moves both edges to the nearest frame and the trim with the start', () => {
		const snapped = snapItemToFrames(item({ timelineStart: 10.53, in: 2, out: 3.01, duration: 1.01 }), 30)!
		expect(snapped.timelineStart * 30).toBeCloseTo(316, 9)
		expect((snapped.timelineStart + snapped.duration) * 30).toBeCloseTo(346, 9)
		// The source under the new start is the source that was there.
		expect(snapped.in).toBeCloseTo(2 + (316 / 30 - 10.53), 9)
		expect(snapped.out - snapped.in).toBeCloseTo(snapped.duration, 9)
	})

	it('scales the trim by speed', () => {
		const snapped = snapItemToFrames(item({ timelineStart: 0.01, in: 1, out: 3, speed: 2, duration: 1 }), 30)!
		expect(snapped.timelineStart).toBe(0)
		expect(snapped.in).toBeCloseTo(1 - 0.02, 9)
		expect((snapped.out - snapped.in) / 2).toBeCloseTo(snapped.duration, 9)
	})

	it('drops an item that covers no frame, and never trims before the source', () => {
		expect(snapItemToFrames(item({ timelineStart: 1.001, in: 0, out: 0.01, duration: 0.01 }), 30)).toBeNull()
		expect(snapItemToFrames(item({ timelineStart: 0.01, in: 0, out: 1, duration: 1 }), 30)!.in).toBe(0)
	})

	it('keeps neighbours that touched touching', () => {
		const a = snapItemToFrames(item({ timelineStart: 0, in: 0, out: 1.017, duration: 1.017 }), 30)!
		const b = snapItemToFrames(item({ timelineStart: 1.017, in: 0, out: 1, duration: 1 }), 30)!
		expect(a.timelineStart + a.duration).toBeCloseTo(b.timelineStart, 12)
	})
})

// ===== Against the real binary: many motion layers, one exact length =====

const ffmpeg = getFFmpegBinaryPath()
const ffprobe = getFFprobeBinaryPath()
const FPS = 30
const LENGTH = 40
/** The source's hard cut from red to blue, and its beep. */
const CUT_AT = 25
const BEEP_AT = 31

describe('export length with many motion layers — against the real ffmpeg', () => {
	let dir: string
	const source = () => join(dir, 'source.mp4')

	beforeAll(async () => {
		dir = await fs.mkdtemp(join(tmpdir(), 'ff-join-'))
		await execFileAsync(ffmpeg, [
			'-y', '-v', 'error',
			// The picture stops 0.1 s before the sound, as a phone recording's
			// often does: the last regions have sound and no source frames.
			'-f', 'lavfi', '-i', `color=c=red:s=320x180:r=${FPS}:d=${LENGTH - 0.1},drawbox=x=0:y=0:w=iw:h=ih:color=blue:t=fill:enable='gte(t,${CUT_AT})'`,
			'-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=48000:duration=${LENGTH},volume=volume=0:enable='lt(t,${BEEP_AT})'`,
			'-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(FPS), '-c:a', 'aac', '-t', String(LENGTH), source()
		])
	}, 60_000)

	afterAll(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	const doc = (): EditorDocument => {
		const asset: MediaAsset = {
			id: 'src', kind: 'video', name: 'src', originalPath: source(),
			metadata: { duration: LENGTH, width: 320, height: 180, fps: FPS, hasAudio: true } as MediaAsset['metadata'],
			preprocessing: {}, clips: [], createdAt: 0
		}
		const track = (id: string, order: number): Track => ({
			id, kind: 'video', name: id, order, muted: false, locked: false, hidden: false, height: 72
		})
		// 24 motion layers at times that are no whole number of frames, so every
		// region boundary is one the old join rounded.
		const layers: TimelineItem[] = Array.from({ length: 24 }, (_, k) => {
			const duration = 0.53 + (k % 5) * 0.137
			return {
				id: `m${k}`, trackId: 'v2', sourceAssetId: '', timelineStart: 0.41 + k * 1.613,
				in: 0, out: duration, speed: 1, preservePitch: true, duration,
				motion: { template: 'lower-third', settings: { name: `Layer ${k}` } }
			}
		})
		return {
			schemaVersion: 1,
			media: [asset],
			tracks: [track('v1', 0), track('v2', 1)],
			timeline: [
				{ id: 'base', trackId: 'v1', sourceAssetId: 'src', timelineStart: 0, in: 0, out: LENGTH, speed: 1, preservePitch: true, duration: LENGTH },
				...layers
			],
			timelineMeta: { fps: FPS, width: 320, height: 180, duration: 0 },
			activePersonaId: 'podcast-editor',
			turns: [],
			historyRef: { currentStepId: 'step-0', stepCount: 0 }
		}
	}

	it('exports within a frame of the timeline, with the cut and the beep where they were', async () => {
		const plan = computeRegions(doc(), 'original', {}, { motionDir: join(dir, 'motion'), frameGrid: true })
		expect(plan.regions.length).toBeGreaterThanOrEqual(48)

		// Stand-ins for the captured clips: a small white box with alpha, in the
		// same codec the capture writes, at the path the plan points to.
		await fs.mkdir(join(dir, 'motion'), { recursive: true })
		for (const job of motionJobsFor(plan.regions)) {
			await execFileAsync(ffmpeg, [
				'-y', '-v', 'error', '-f', 'lavfi',
				'-i', `color=c=black@0:s=320x180:r=${FPS}:d=${job.item.duration},format=argb,drawbox=x=8:y=8:w=40:h=20:color=white:t=fill`,
				'-c:v', 'qtrle', '-pix_fmt', 'argb', '-g', '1', job.outputPath
			])
		}

		const spans = regionSpans(plan.regions.map((r) => r.duration), plan.fps)
		const signal = new AbortController().signal
		const files: string[] = []
		for (let i = 0; i < plan.regions.length; i++) {
			files.push(await renderRegion(plan.regions[i], i, plan, spans[i], dir, signal, () => {}))
		}
		const out = join(dir, 'export.mp4')
		await concatRegions(files, spans, dir, out, signal, false)

		const { stdout } = await execFileAsync(ffprobe, [
			'-v', 'error', '-show_entries', 'format=duration:stream=codec_type,nb_frames,duration', '-of', 'json', out
		])
		const probe = JSON.parse(stdout)
		const video = probe.streams.find((s: any) => s.codec_type === 'video')
		expect(Number(video.nb_frames)).toBe(LENGTH * FPS)
		expect(Math.abs(Number(probe.format.duration) - LENGTH)).toBeLessThanOrEqual(1 / FPS)
		const audio = probe.streams.find((s: any) => s.codec_type === 'audio')
		expect(Math.abs(Number(audio.duration) - LENGTH)).toBeLessThanOrEqual(1 / FPS)

		// The first blue frame, read from the middle of the picture (the layers
		// sit in the corner).
		const { stdout: pixels } = await execFileAsync(ffmpeg, [
			'-v', 'error', '-i', out, '-vf', 'crop=20:20:150:80,scale=1:1,format=rgb24', '-f', 'rawvideo', '-'
		], { encoding: 'buffer', maxBuffer: 1 << 24 })
		const rgb = pixels as unknown as Buffer
		let firstBlue = -1
		for (let f = 0; f * 3 < rgb.length; f++) {
			if (rgb[f * 3 + 2] > 128 && rgb[f * 3] < 128) { firstBlue = f; break }
		}
		expect(firstBlue / FPS).toBeCloseTo(CUT_AT, 5)

		// The beep's first loud sample, against the source's own (the source's
		// gate opens on its 1024-sample block, a little after BEEP_AT).
		const onsetOf = async (file: string) => {
			const { stdout: pcm } = await execFileAsync(ffmpeg, [
				'-v', 'error', '-i', file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'
			], { encoding: 'buffer', maxBuffer: 1 << 26 })
			const samples = pcm as unknown as Buffer
			for (let i = 0; i + 1 < samples.length; i += 2) {
				if (Math.abs(samples.readInt16LE(i)) > 2000) return i / 2 / 48000
			}
			return -1
		}
		const expected = await onsetOf(source())
		expect(Math.abs(expected - BEEP_AT)).toBeLessThan(0.025)
		// Within a millisecond: the sound is joined on the sample grid.
		expect(Math.abs((await onsetOf(out)) - expected)).toBeLessThan(0.001)
	}, 240_000)
})
