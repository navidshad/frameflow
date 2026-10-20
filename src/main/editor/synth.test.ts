import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { presetOf, SOUND_PRESETS, soundLength, type SoundKind } from '../../shared/synth'
import { analyzeAudioFile, previewPeaks } from './audioAnalysis'
import { ensureSoundFile, soundAssetId, soundHash } from './synth'

/**
 * Every sound, rendered by the real bundled ffmpeg. These are the facts a
 * palette has to keep: each recipe makes a file, of the length it says, with
 * something in it, and makes the same file every time.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-synth-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const kinds = SOUND_PRESETS.filter((p) => p.kind !== 'bed').map((p) => p.kind)

describe('every sound in the palette renders', () => {
	it.each(kinds)('%s: a file of its length, with signal in it', async (kind: SoundKind) => {
		const recipe = { kind, durationSec: 0.8 }
		const out = await ensureSoundFile(dir, recipe)
		expect(fs.existsSync(out.path)).toBe(true)
		const a = await analyzeAudioFile(out.path)
		expect(a.hasAudio).toBe(true)
		const want = soundLength(recipe)
		// 50 buckets a second, so a tenth of a second is five bars: allow a few of slack.
		expect(Math.abs(a.durationSec - want)).toBeLessThan(0.12)
		expect(Math.max(...a.peaks), kind).toBeGreaterThan(0)
		// A recipe's level is its peak: every sound lands on its own preset's level.
		// (The meter's true peak, not the 8 kHz waveform's: a click's top end is above it.)
		expect(Math.abs(a.truePeakDb! - presetOf(kind).level), kind).toBeLessThan(1.5)
	}, 30000)
})

describe('a recipe is a file', () => {
	it('renders once, then answers from the cache', async () => {
		const first = await ensureSoundFile(dir, { kind: 'pop' })
		const second = await ensureSoundFile(dir, { kind: 'pop' })
		expect(first.cached).toBe(true) // rendered by the palette test above
		expect(second.path).toBe(first.path)
	})

	it('makes the same samples every time', async () => {
		const a = path.join(dir, 'a')
		const b = path.join(dir, 'b')
		const one = await ensureSoundFile(a, { kind: 'whoosh', seed: 4 })
		const two = await ensureSoundFile(b, { kind: 'whoosh', seed: 4 })
		expect(fs.readFileSync(one.path).equals(fs.readFileSync(two.path))).toBe(true)
	})

	it('makes a different sound from a different seed', async () => {
		const one = await ensureSoundFile(dir, { kind: 'whoosh', seed: 1 })
		const two = await ensureSoundFile(dir, { kind: 'whoosh', seed: 2 })
		expect(fs.readFileSync(one.path).equals(fs.readFileSync(two.path))).toBe(false)
	})

	it('names the file and the asset by the recipe', () => {
		expect(soundHash({ kind: 'whoosh' })).toBe(soundHash({ kind: 'whoosh', pitch: 0 }))
		expect(soundHash({ kind: 'whoosh' })).not.toBe(soundHash({ kind: 'whoosh', pitch: 1 }))
		expect(soundAssetId({ kind: 'whoosh' })).toMatch(/^synth-[0-9a-f]{16}$/)
	})

	it('peaks at the level the recipe asks for, and moves with it', async () => {
		const quiet = await analyzeAudioFile((await ensureSoundFile(dir, { kind: 'chime', levelDb: -30 })).path)
		const loud = await analyzeAudioFile((await ensureSoundFile(dir, { kind: 'chime', levelDb: -10 })).path)
		expect(loud.truePeakDb!).toBeGreaterThan(-12)
		expect(loud.truePeakDb!).toBeLessThan(-8)
		expect(quiet.truePeakDb!).toBeLessThan(-28)
		expect(loud.lufs! - quiet.lufs!).toBeGreaterThan(15)
	})

	it('makes a click and a chime of the same level equally loud at the peak', async () => {
		const click = await analyzeAudioFile((await ensureSoundFile(dir, { kind: 'click', levelDb: -12 })).path)
		const chime = await analyzeAudioFile((await ensureSoundFile(dir, { kind: 'chime', levelDb: -12 })).path)
		expect(Math.abs(click.truePeakDb! - chime.truePeakDb!)).toBeLessThan(1.5)
	})
})

describe('the ambient bed', () => {
	it('is as long as it is asked to be, and sounds like a bed rather than a click', async () => {
		const out = await ensureSoundFile(dir, { kind: 'bed', durationSec: 9 })
		const a = await analyzeAudioFile(out.path)
		expect(a.durationSec).toBeGreaterThan(8.8)
		expect(a.durationSec).toBeLessThan(9.2)
		// Steady: every one of its seconds (bar the fade at the end) has sound in it,
		// where a click would be silent after its first few milliseconds.
		for (let second = 0; second < 7; second++) {
			const loudest = Math.max(...a.peaks.slice(second * 50, (second + 1) * 50))
			expect(loudest, `second ${second}`).toBeGreaterThanOrEqual(3)
		}
		// A bed peaks at its level (−14 dBFS) and sits well under a voice.
		expect(a.truePeakDb!).toBeGreaterThan(-16)
		expect(a.truePeakDb!).toBeLessThan(-12)
		expect(a.lufs!).toBeLessThan(-22)
	}, 60000)
})

describe('previewPeaks', () => {
	it('reduces a short sound to the bars asked for', async () => {
		const out = await ensureSoundFile(dir, { kind: 'click' })
		const bars = await previewPeaks(out.path, 40)
		expect(bars).toHaveLength(40)
		expect(Math.max(...bars)).toBeGreaterThan(0)
	})
})
