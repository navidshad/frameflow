import { describe, expect, it } from 'vitest'
import {
	FeatureExtractor, INSPECT_RATE, estimateTempo, fftInPlace, quietSpans, summarizeFeatures
} from './audioFeatures'

// ===== Synthetic signals =====

/** Deterministic noise in -1..1, so a test never flakes. */
function rng(seed = 1) {
	let s = seed
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0
		return (s / 0xffffffff) * 2 - 1
	}
}

const samplesFor = (sec: number) => Math.round(sec * INSPECT_RATE)
const tone = (hz: number, sec: number, amp = 0.5) =>
	Array.from({ length: samplesFor(sec) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / INSPECT_RATE) * amp * 32767)
const silence = (sec: number) => new Array<number>(samplesFor(sec)).fill(0)
const noise = (sec: number, amp = 0.5, seed = 7) => {
	const r = rng(seed)
	return Array.from({ length: samplesFor(sec) }, () => r() * amp * 32767)
}
/** A short decaying noise burst every `60 / bpm` seconds: a drum machine with one drum. */
function clicks(bpm: number, sec: number) {
	const out = new Array<number>(samplesFor(sec)).fill(0)
	const r = rng(3)
	const period = (60 / bpm) * INSPECT_RATE
	for (let at = 0; at < out.length; at += period) {
		const start = Math.round(at)
		for (let j = 0; j < 1200 && start + j < out.length; j++) out[start + j] = r() * 0.9 * 32767 * Math.exp(-j / 250)
	}
	return out
}
const join = (...parts: number[][]) => parts.flat()

function features(samples: number[]) {
	const extractor = new FeatureExtractor()
	// In uneven chunks, like a pipe delivers them.
	for (let i = 0; i < samples.length; i += 4099) extractor.push(samples.slice(i, i + 4099))
	return extractor.finish()
}

describe('fftInPlace', () => {
	it('puts a sine in the right bin', () => {
		const n = 1024
		const re = new Float64Array(n), im = new Float64Array(n)
		for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 50 * i) / n)
		fftInPlace(re, im)
		let peak = 0
		for (let k = 1; k < n / 2; k++) if (Math.hypot(re[k], im[k]) > Math.hypot(re[peak], im[peak])) peak = k
		expect(peak).toBe(50)
	})
})

describe('FeatureExtractor', () => {
	it('reports the length it was fed', () => {
		expect(features(tone(440, 3)).durationSec).toBeCloseTo(3, 2)
	})

	it('reads level in dBFS', () => {
		const f = features(tone(440, 2, 0.5)) // a 0.5-amplitude sine is 0.354 RMS = -9 dBFS
		const mid = f.rmsDb[Math.floor(f.rmsDb.length / 2)]
		expect(mid).toBeGreaterThan(-9.6)
		expect(mid).toBeLessThan(-8.4)
	})
})

describe('summarizeFeatures: tonal balance', () => {
	it('calls a 100 Hz tone low and dark', () => {
		const s = summarizeFeatures(features(tone(100, 4)))
		expect(s.balance.lowPct).toBeGreaterThanOrEqual(95)
		expect(s.balance.tone).toBe('dark')
		expect(s.hints.join(' ')).toMatch(/bass-heavy/)
	})

	it('calls a 5 kHz tone high and bright', () => {
		const s = summarizeFeatures(features(tone(5000, 4)))
		expect(s.balance.highPct).toBeGreaterThanOrEqual(95)
		expect(s.balance.tone).toBe('bright')
		expect(s.balance.centroidHz).toBeGreaterThan(4500)
		expect(s.balance.centroidHz).toBeLessThan(5500)
	})

	it('puts a 1 kHz tone in the middle', () => {
		const s = summarizeFeatures(features(tone(1000, 4)))
		expect(s.balance.midPct).toBeGreaterThanOrEqual(95)
	})
})

describe('summarizeFeatures: energy and quiet', () => {
	it('finds the gap in tone, silence, tone', () => {
		const s = summarizeFeatures(features(join(tone(440, 3), silence(2), tone(440, 3))))
		expect(s.quiet.spans).toHaveLength(1)
		expect(s.quiet.spans[0].startSec).toBeGreaterThan(2.7)
		expect(s.quiet.spans[0].startSec).toBeLessThan(3.3)
		expect(s.quiet.spans[0].endSec).toBeGreaterThan(4.7)
		expect(s.quiet.spans[0].endSec).toBeLessThan(5.3)
		expect(s.quiet.sharePct).toBeGreaterThanOrEqual(20)
	})

	it('ignores a dip too short to be a pause', () => {
		const s = summarizeFeatures(features(join(tone(440, 3), silence(0.15), tone(440, 3))))
		expect(s.quiet.spans).toHaveLength(0)
	})

	it('keeps the curve small and in time order', () => {
		const s = summarizeFeatures(features(join(tone(440, 10, 0.05), tone(440, 10, 0.5))))
		expect(s.energy.db.length).toBeLessThanOrEqual(48)
		expect(s.energy.db[0]).toBeLessThan(s.energy.db[s.energy.db.length - 1] - 10)
	})

	it('does not report digital silence as -120 dB or a 100 dB range', () => {
		const s = summarizeFeatures(features(join(tone(440, 3), silence(5), tone(440, 3))))
		expect(s.dynamics.quietDb).toBe(-90)
		expect(s.dynamics.rangeDb).toBeLessThan(90)
	})

	it('shifts every time by the offset, so a trimmed range reads in source seconds', () => {
		const s = summarizeFeatures(features(join(tone(440, 3), silence(2), tone(440, 3))), { offsetSec: 100 })
		expect(s.quiet.spans[0].startSec).toBeGreaterThan(102.7)
		expect(s.sections[0].startSec).toBe(100)
	})
})

describe('quietSpans', () => {
	it('bridges a blink and drops a short span', () => {
		// Indices 2-3 and 5-8 are quiet with a one-frame blink at 4 between them
		// (bridged); the lone quiet frame at 11 is two frames on, and too short.
		const levels = [0, 0, -80, -80, 0, -80, -80, -80, -80, 0, 0, -80, 0]
		expect(quietSpans(levels, -60, 3, 1)).toEqual([[2, 9]])
	})
})

describe('estimateTempo', () => {
	it('finds 120 BPM in a click train', () => {
		const f = features(clicks(120, 24))
		const t = estimateTempo(f.flux, f.fps)
		expect(t).not.toBeNull()
		expect(t!.bpm).toBeGreaterThan(117)
		expect(t!.bpm).toBeLessThan(123)
		expect(t!.confidence).toBeGreaterThan(0.3)
	})

	it('finds a different tempo too', () => {
		const f = features(clicks(96, 24))
		const t = estimateTempo(f.flux, f.fps)
		expect(t!.bpm).toBeGreaterThan(94)
		expect(t!.bpm).toBeLessThan(98)
	})

	it('has no confidence in steady noise', () => {
		const f = features(noise(20))
		const t = estimateTempo(f.flux, f.fps)
		expect(t === null || t.confidence < 0.25).toBe(true)
	})

	it('says nothing about a clip too short to hold a beat', () => {
		const f = features(clicks(120, 4))
		expect(estimateTempo(f.flux, f.fps)).toBeNull()
	})

	it('puts the pulse in the summary and the hints', () => {
		const s = summarizeFeatures(features(clicks(120, 24)))
		expect(s.tempo?.bpm).toBeGreaterThan(117)
		expect(s.hints.join(' ')).toMatch(/steady pulse/i)
	})
})

describe('summarizeFeatures: what it is', () => {
	/** Voice-band bursts of uneven length with pauses between: speech's shape without its words. */
	function talk(sec: number) {
		const r = rng(11)
		const out: number[] = []
		while (out.length < samplesFor(sec)) {
			const burst = 0.25 + Math.abs(r()) * 0.9
			const pause = 0.15 + Math.abs(r()) * 0.5
			const hz = 400 + Math.abs(r()) * 1200
			out.push(...tone(hz, burst, 0.4), ...silence(pause))
		}
		return out.slice(0, samplesFor(sec))
	}

	it('reads voice-band bursts with pauses and no beat as speech, with no tempo', () => {
		const s = summarizeFeatures(features(talk(25)))
		expect(s.tempo).toBeNull()
		expect(s.hints.join(' ')).toMatch(/most likely speech/)
		expect(s.hints.join(' ')).toMatch(/pause/)
	})

	it('does not call a bass-heavy beat speech', () => {
		const s = summarizeFeatures(features(clicks(120, 24)))
		expect(s.hints.join(' ')).not.toMatch(/speech/)
	})

	it('says it found no pulse for a bright steady hiss rather than guessing speech', () => {
		const s = summarizeFeatures(features(noise(12)))
		expect(s.hints.join(' ')).toMatch(/No steady pulse/)
	})
})

describe('summarizeFeatures: sections', () => {
	it('splits quiet bass from loud bright noise at the change', () => {
		const s = summarizeFeatures(features(join(tone(120, 14, 0.06), noise(14, 0.6))))
		expect(s.sections.length).toBeGreaterThanOrEqual(2)
		const boundary = s.sections[1].startSec
		expect(boundary).toBeGreaterThan(12)
		expect(boundary).toBeLessThan(16)
		expect(s.sections[0].level).toBe('quiet')
		expect(s.sections[s.sections.length - 1].level).toBe('loud')
		expect(s.sections[0].character).toContain('bass-heavy')
	})

	it('keeps one steady sound as one section', () => {
		const s = summarizeFeatures(features(tone(440, 30)))
		expect(s.sections).toHaveLength(1)
		expect(s.sections[0].endSec).toBeCloseTo(30, 0)
	})

	it('does not invent sections in a clip that is too short', () => {
		const s = summarizeFeatures(features(join(tone(120, 2, 0.06), noise(2, 0.6))))
		expect(s.sections).toHaveLength(1)
	})
})

describe('summarizeFeatures: size', () => {
	it('stays a few KB for a long mixed file', () => {
		const s = summarizeFeatures(features(join(tone(120, 30, 0.06), noise(30, 0.6), silence(5), clicks(128, 30))))
		expect(JSON.stringify(s).length).toBeLessThan(4000)
	})
})
