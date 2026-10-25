import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { MediaAsset, MulticamGroup } from '@shared/types'
import { speakerIn } from '@shared/speakers'
import { getFFmpegBinaryPath } from '../ffmpeg/binaries'
import { diarizeGroup } from './diarize'

/**
 * "Who speaks when" against REAL ffmpeg, on voices made so the answer is known:
 * three synthetic speakers with their own pitch and timbre take turns at known
 * times, heard by two microphones. One camera's microphone is close to speaker
 * 2, the other hears all three equally (two people sharing a microphone).
 */

const execFileAsync = promisify(execFile)
// [from, to, voice]: ten-second turns, a breath of silence at each end.
const SCHEDULE: Array<[number, number, number]> = [
	[0, 10, 0], [10, 20, 1], [20, 30, 2], [30, 40, 0], [40, 50, 1], [50, 60, 2], [60, 70, 0]
]
const TOTAL = 70
// f0, and how strong each harmonic is: a dark, a bright and a nasal voice.
const VOICES = [
	{ f0: 115, weight: (n: number) => 1 / n },
	{ f0: 210, weight: (n: number) => (n >= 3 && n <= 6 ? 1 : 0.35 / n) },
	{ f0: 150, weight: (n: number) => (n >= 5 && n <= 8 ? 1.2 : 0.5 / n) }
]
const OFFSET = 0.5 // camera 2's file starts half a second after the group clock's zero

let dir = ''
let cam1 = '', cam2 = ''

/** One voice: harmonics with a little vibrato and a syllable rhythm, switched on during its turns. */
function voiceExpr(v: number): string {
	const { f0, weight } = VOICES[v]
	const gate = SCHEDULE.filter(([, , who]) => who === v)
		.map(([a, b]) => `between(t,${a + 0.3},${b - 0.5})`).join('+')
	const harmonics = Array.from({ length: 12 }, (_, i) => i + 1)
		.map((n) => `${(weight(n)).toFixed(3)}*sin(2*PI*${n * f0}*t+${(n * 0.04 * f0 / 3).toFixed(3)}*sin(2*PI*3*t))`).join('+')
	return `(${gate})*(0.6+0.4*sin(2*PI*4*t))*0.08*(${harmonics})`
}

beforeAll(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), 'ff-diarize-'))
	const ff = getFFmpegBinaryPath()
	const voices: string[] = []
	for (let v = 0; v < 3; v++) {
		const file = join(dir, `voice${v}.wav`)
		await execFileAsync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${voiceExpr(v)}':s=16000:d=${TOTAL}`, file])
		voices.push(file)
	}
	// Room tone for both microphones.
	const hiss = ['-f', 'lavfi', '-i', `anoisesrc=d=${TOTAL}:c=pink:r=16000:a=0.004:seed=`]
	// Mic 1 hears all three equally; mic 2 hears voice 1 loud and the others faint.
	await execFileAsync(ff, ['-v', 'error', '-y', '-i', voices[0], '-i', voices[1], '-i', voices[2], ...hiss.slice(0, 3), `${hiss[3]}11`,
		'-filter_complex', '[0]volume=1[a];[1]volume=1[b];[2]volume=1[c];[a][b][c][3]amix=inputs=4:normalize=0[o]',
		'-map', '[o]', '-c:a', 'aac', join(dir, 'cam1.m4a')])
	await execFileAsync(ff, ['-v', 'error', '-y', '-i', voices[0], '-i', voices[1], '-i', voices[2], ...hiss.slice(0, 3), `${hiss[3]}23`,
		'-filter_complex', `[0]volume=0.25[a];[1]volume=2.5[b];[2]volume=0.25[c];[a][b][c][3]amix=inputs=4:normalize=0,atrim=start=${OFFSET},asetpts=PTS-STARTPTS[o]`,
		'-map', '[o]', '-c:a', 'aac', join(dir, 'cam2.m4a')])
	cam1 = join(dir, 'cam1.m4a')
	cam2 = join(dir, 'cam2.m4a')
}, 120_000)

afterAll(async () => {
	if (dir) await fs.rm(dir, { recursive: true, force: true })
})

const asset = (id: string, path: string, duration: number): MediaAsset => ({
	id, kind: 'video', name: `${id}.mp4`, originalPath: path,
	metadata: { duration, width: 1920, height: 1080, fps: 30, size: 1, codec: 'h264', format: 'mp4', hasAudio: true },
	preprocessing: {}, clips: [], createdAt: 0
})
const group = (): { group: MulticamGroup; media: MediaAsset[] } => ({
	media: [asset('c1', cam1, TOTAL), asset('c2', cam2, TOTAL - OFFSET)],
	group: {
		id: 'g', name: 'Synthetic', soundAssetId: 'c1', createdAt: 0,
		members: [
			{ assetId: 'c1', name: 'Cam01', camera: 'Cam01', offset: 0, rate: 1, sync: { method: 'reference', confidence: 'strong', driftPpm: 0 } },
			{ assetId: 'c2', name: 'Cam02', camera: 'Cam02', offset: OFFSET, rate: 1, sync: { method: 'audio', confidence: 'strong', driftPpm: 0 } }
		]
	}
})

describe('diarizeGroup', () => {
	it('finds three voices of known pitch, takes them at the right times, and knows which microphone one is close to', async () => {
		const { group: g, media } = group()
		const speakers = await diarizeGroup(g, media, { speakers: 3 })
		expect(speakers.people).toHaveLength(3)

		// Pitch: each synthetic voice is found at its own f0 (within 12%: the estimate is for telling voices apart,
		// at 4 kHz its steps are 5% wide near 200 Hz, and these voices wobble with vibrato).
		const pitches = speakers.people.map((p) => p.pitchHz!).sort((a, b) => a - b)
		;[115, 150, 210].forEach((f0, i) => expect(Math.abs(pitches[i] / f0 - 1)).toBeLessThan(0.12))

		// Time: the speaker the analysis names inside each scheduled turn is the same one every time that
		// voice speaks, and a different one for each voice.
		let right = 0, total = 0
		for (const [from, to, who] of SCHEDULE) {
			// The voice this scheduled speaker was given overall is the one with the most seconds in its turns.
			const tally = new Map<string, number>()
			for (const [f, t, w] of SCHEDULE) if (w === who) for (let x = f + 1; x < t - 1; x += 0.5) {
				const id = speakerIn(speakers, x, x + 0.5)?.speaker?.id ?? 'none'
				tally.set(id, (tally.get(id) ?? 0) + 1)
			}
			const mine = [...tally].sort((a, b) => b[1] - a[1])[0][0]
			for (let t = from + 1; t < to - 1; t += 0.5) {
				total++
				if (speakerIn(speakers, t, t + 0.5)?.speaker?.id === mine) right++
			}
		}
		expect(right / total).toBeGreaterThan(0.9)
		const given = new Set(SCHEDULE.map(([from, , who]) => speakerIn(speakers, from + 5, from + 6)?.speaker?.id))
		expect(given.size).toBe(3)

		// Closeness: the voice that Cam02's microphone hears loud (the bright 210 Hz one) is placed on Cam02.
		const bright = speakers.people.find((p) => p.pitchHz! > 190)!
		expect(bright.camera).toBe('Cam02')
	}, 120_000)

	it('puts silence in no one’s mouth and reports how much it was unsure of', async () => {
		const { group: g, media } = group()
		const speakers = await diarizeGroup(g, media, { speakers: 3 })
		// Breaths between turns: 0.5 s before each turn end and 0.3 s after each start.
		for (const [from, to] of SCHEDULE) expect(speakerIn(speakers, to - 0.4, to - 0.05)?.speaker ?? null).toBeNull()
		expect(speakers.analysis.unsureShare).toBeLessThan(0.1)
		expect(speakers.analysis.cameras).toEqual(['Cam01', 'Cam02'])
	}, 120_000)

	it('keeps the names and the hand-fixed turns of an earlier run', async () => {
		const { group: g, media } = group()
		const first = await diarizeGroup(g, media, { speakers: 3 })
		const bright = first.people.find((p) => p.pitchHz! > 190)!
		const named: MulticamGroup = {
			...g,
			speakers: {
				...first,
				people: first.people.map((p) => (p.id === bright.id ? { ...p, name: 'Somi', framing: 'alone on her camera' } : p)),
				turns: [...first.turns, { start: 90, end: 95, speaker: bright.id, confidence: 1, fixed: true }]
			}
		}
		const again = await diarizeGroup(named, media, { speakers: 3, keepFrom: named.speakers })
		const somi = again.people.find((p) => p.name === 'Somi')!
		expect(somi.pitchHz!).toBeGreaterThan(190)
		expect(somi.framing).toBe('alone on her camera')
		expect(again.turns.find((t) => t.fixed)).toMatchObject({ start: 90, end: 95, speaker: somi.id })
	}, 120_000)
})
