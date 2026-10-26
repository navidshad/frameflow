import { describe, expect, it } from 'vitest'
import {
	FRAME_SEC, N_CEP, buildFrameTable, buildTurns, newMicTrack, rng, windowFeatures, type FrameTable, type MicTrack, type Smoothed
} from './diarizeMath'
import { clusterVoices } from './diarizeTracks'
import { speakersFrom } from './diarize'

/**
 * The clustering without ffmpeg: microphone tracks made by hand, with voices
 * whose levels, pitch and timbre are known and whose per-frame timbre is NOISY
 * (as phonemes make it) — so the tests catch a method that works on clean
 * numbers but not on speech.
 */

interface Voice { name: string; level: [number, number]; f0: number; timbre: number }
const SCHEDULE: Array<[number, number, number]> = [ // [from s, to s, voice index]
	[0, 14, 0], [15, 29, 1], [30, 44, 2], [45, 58, 0], [59, 70, 1], [71, 84, 2], [85, 99, 0]
]
const SECONDS = 100

function build(voices: Voice[], seed = 5): { tracks: MicTrack[]; truth: Int8Array } {
	const rand = rng(seed)
	const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-9)) * Math.cos(2 * Math.PI * rand())
	const frames = SECONDS / FRAME_SEC
	const tracks = [newMicTrack(frames), newMicTrack(frames)]
	const truth = new Int8Array(frames).fill(-1)
	for (let f = 0; f < frames; f++) {
		tracks.forEach((t) => { t.level[f] = -50 + gauss() })
	}
	for (const [from, to, v] of SCHEDULE) {
		for (let f = Math.round(from / FRAME_SEC); f < Math.round(to / FRAME_SEC); f++) {
			truth[f] = v
			tracks.forEach((t, m) => {
				t.level[f] = voices[v].level[m] + 2 * gauss()
				// Voiced about 70% of the time, with the pitch wandering a little.
				if (rand() < 0.7) t.f0[f] = voices[v].f0 * (1 + 0.06 * gauss())
				for (let i = 0; i < N_CEP; i++) {
					// Per-frame timbre: a big phonetic wobble around a small voice-specific offset.
					t.cep[f * N_CEP + i] = 3 * gauss() + voices[v].timbre * (i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0.5)
				}
			})
		}
	}
	return { tracks, truth }
}

/** Fraction of speech frames given the same voice as the truth, under the best matching of labels. */
function accuracy(res: NonNullable<ReturnType<typeof clusterVoices>>, truth: Int8Array): number {
	const k = res.k
	const confusion = Array.from({ length: k }, () => new Array(3).fill(0))
	for (const t of res.turns) {
		for (let f = Math.round((t.start - res.table.startSec) / FRAME_SEC); f < Math.round((t.end - res.table.startSec) / FRAME_SEC); f++) {
			if (truth[f] >= 0 && t.speaker >= 0) confusion[t.speaker][truth[f]]++
		}
	}
	const total = confusion.flat().reduce((a, b) => a + b, 0)
	const right = confusion.reduce((s, row) => s + Math.max(...row), 0)
	return right / total
}

describe('voices on two microphones', () => {
	it('tells three voices apart when two of them share a microphone and differ only in pitch and timbre', () => {
		// A and C are both far from mic 1 and about as loud on mic 0: the "two people on one camera" case.
		const { tracks, truth } = build([
			{ name: 'A', level: [-24, -38], f0: 120, timbre: 1.4 },
			{ name: 'B', level: [-27, -22], f0: 215, timbre: -1.2 },
			{ name: 'C', level: [-25, -38], f0: 138, timbre: -1.4 }
		])
		const res = clusterVoices(tracks, 0, { speakers: 3 })!
		expect(res.k).toBe(3)
		expect(accuracy(res, truth)).toBeGreaterThan(0.9)
		// The voice that is close to mic 1 is found, and its pitch is right.
		const close = res.voices.find((v) => v.closest === 1)!
		expect(close.pitchHz).toBeGreaterThan(200)
		expect(close.pitchHz).toBeLessThan(230)
	})

	it('is the same on every run (no luck in the starting points)', () => {
		const { tracks } = build([
			{ name: 'A', level: [-24, -38], f0: 120, timbre: 1.4 },
			{ name: 'B', level: [-27, -22], f0: 215, timbre: -1.2 },
			{ name: 'C', level: [-25, -38], f0: 138, timbre: -1.4 }
		])
		const a = clusterVoices(tracks, 0, { speakers: 3 })!
		const b = clusterVoices(tracks, 0, { speakers: 3 })!
		expect(a.turns).toEqual(b.turns)
	})

	it('says "unsure" instead of guessing when two voices are the same', () => {
		// Two "people" with identical level, pitch and timbre: nothing in the sound tells them apart.
		const same: Voice = { name: 'A', level: [-24, -38], f0: 130, timbre: 1 }
		const { tracks } = build([same, { ...same, name: 'B' }, { name: 'C', level: [-27, -22], f0: 215, timbre: -1.2 }])
		const res = clusterVoices(tracks, 0, { speakers: 3 })!
		const speakers = speakersFrom(res, ['Cam01', 'Cam02'], 3)
		// Never a confident, clean split: the pair is flagged as alike, or as a voice that never takes turns.
		expect(speakers.analysis.warnings.some((w) => /sound alike|ONE voice/.test(w))).toBe(true)
	})

	it('refuses when there is hardly any speech', () => {
		const tracks = [newMicTrack(400), newMicTrack(400)]
		tracks.forEach((t) => t.level.fill(-50))
		expect(clusterVoices(tracks, 0)).toBeNull()
	})

	it('names voices by how much they speak, with the cautions that matter', () => {
		const { tracks } = build([
			{ name: 'A', level: [-24, -38], f0: 120, timbre: 1.4 },
			{ name: 'B', level: [-27, -22], f0: 215, timbre: -1.2 },
			{ name: 'C', level: [-25, -38], f0: 138, timbre: -1.4 }
		])
		const res = clusterVoices(tracks, 0, { speakers: 3 })!
		const sp = speakersFrom(res, ['Cam01', 'Cam02'])
		expect(sp.people.map((p) => p.name)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 3'])
		expect(sp.people[0].talkSec!).toBeGreaterThanOrEqual(sp.people[2].talkSec!)
		expect(sp.analysis.warnings[0]).toMatch(/estimated, and the estimate is a guess/)
		// Distinct voices that alternate raise no further caution.
		expect(sp.analysis.warnings).toHaveLength(1)
		expect(sp.turns.every((t, i) => i === 0 || t.start >= sp.turns[i - 1].end - 1e-9)).toBe(true)
	})
})

describe('window averaging', () => {
	it('replaces each frame by the mean over its neighbourhood and ignores missing values', () => {
		const table: FrameTable = {
			frames: 10, startSec: 0, dims: ['a'], groups: ['pitch'], active: Int32Array.from([0, 1, 2, 3, 4, 5]),
			x: Float32Array.from([0, 2, 4, NaN, 8, 10]), margin: [], floors: []
		}
		const w = windowFeatures(table, 2 * FRAME_SEC)
		expect(w.x[0]).toBeCloseTo((0 + 2 + 4) / 3, 5) // frames 0..2 (3 values)
		expect(w.x[2]).toBeCloseTo((0 + 2 + 4 + 8) / 4, 5) // 0..4, one NaN skipped
		expect(w.x[5]).toBeNaN() // fewer than 3 values in reach: unknown, not a guess
	})
})

describe('turns', () => {
	const table = (active: number[]): FrameTable => ({
		frames: 1000, startSec: 100, dims: ['a'], groups: ['pitch'], active: Int32Array.from(active),
		x: new Float32Array(active.length), margin: [], floors: []
	})
	const smoothed = (labels: number[], conf = 0.95): Smoothed => ({
		label: Int32Array.from(labels),
		posterior: Float32Array.from(labels.flatMap((l) => (l === 0 ? [conf, 1 - conf] : [1 - conf, conf])))
	})
	const run = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

	it('turns runs of one voice into turns on the group clock, merging short pauses', () => {
		const active = [...run(0, 40), ...run(60, 100), ...run(140, 200)] // pause 1.0 s, then 2.0 s
		const labels = [...new Array(40).fill(0), ...new Array(40).fill(0), ...new Array(60).fill(1)]
		const turns = buildTurns(table(active), smoothed(labels), 2)
		expect(turns).toHaveLength(2)
		expect(turns[0]).toMatchObject({ speaker: 0, start: 100, end: 100 + 100 * FRAME_SEC })
		expect(turns[1]).toMatchObject({ speaker: 1, start: 100 + 140 * FRAME_SEC })
	})

	it('folds a short unsure-ish interjection into the turn around it, but keeps a clear one', () => {
		const active = run(0, 100)
		const blip = (conf: number) => {
			const labels = new Array(100).fill(0)
			for (let i = 40; i < 46; i++) labels[i] = 1 // 0.3 s of the other voice
			const sm = smoothed(labels)
			for (let i = 40; i < 46; i++) { sm.posterior[i * 2] = 1 - conf; sm.posterior[i * 2 + 1] = conf }
			return buildTurns(table(active), sm, 2)
		}
		expect(blip(0.7)).toHaveLength(1)
		expect(blip(0.97).map((t) => t.speaker)).toEqual([0, 1, 0])
	})

	it('marks a turn the model is not sure of as unsure (-1) rather than naming a speaker', () => {
		const turns = buildTurns(table(run(0, 80)), smoothed(new Array(80).fill(0), 0.55), 2)
		expect(turns).toEqual([expect.objectContaining({ speaker: -1, confidence: 0.55 })])
	})
})

describe('the frame table', () => {
	it('judges each microphone against its own noise floor, so a louder microphone does not win by gain', () => {
		const frames = 600
		const a = newMicTrack(frames), b = newMicTrack(frames)
		// Mic A is 20 dB hotter overall (gain), but in the middle third the voice is 12 dB over the room
		// on BOTH: the microphones agree about how close it is.
		for (let f = 0; f < frames; f++) {
			const speech = f >= 200 && f < 400
			a.level[f] = -30 + (speech ? 12 : 0) + (f % 7) * 0.1
			b.level[f] = -50 + (speech ? 12 : 0) + (f % 5) * 0.1
		}
		const t = buildFrameTable([a, b], 0)
		const closeDim = t.dims.indexOf('close1')
		const d = Array.from({ length: t.active.length }, (_, r) => t.x[r * t.dims.length + closeDim])
		const mean = d.reduce((s, v) => s + v, 0) / d.length
		expect(Math.abs(mean)).toBeLessThan(1.5)
		expect(t.floors[0] - t.floors[1]).toBeGreaterThan(15)
	})
})
