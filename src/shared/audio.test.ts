import { describe, expect, it } from 'vitest'
import {
	bucketPeaks, dbToGain, formatLufs, gainToDb, isTrackRole, parseLoudness, peaksForRange, roleSpec, TRACK_ROLES,
	waveformPath
} from './audio'

describe('track roles', () => {
	it('only a music bed ducks, and sits lower than the voice', () => {
		expect(TRACK_ROLES.filter((r) => r.ducks).map((r) => r.id)).toEqual(['music'])
		expect(roleSpec('voice')!.offsetLU).toBe(0)
		expect(roleSpec('music')!.offsetLU).toBeLessThan(0)
		expect(roleSpec('sfx')!.offsetLU).toBeLessThan(0)
	})

	it('recognises exactly the three roles', () => {
		expect(['voice', 'music', 'sfx'].every(isTrackRole)).toBe(true)
		expect([undefined, null, 'bed', ''].some(isTrackRole)).toBe(false)
		expect(roleSpec(undefined)).toBeUndefined()
	})
})

describe('level maths', () => {
	it('round-trips gain and decibels', () => {
		expect(gainToDb(1)).toBeCloseTo(0)
		expect(gainToDb(0.5)).toBeCloseTo(-6.02, 1)
		expect(dbToGain(-12)).toBeCloseTo(0.251, 2)
		expect(dbToGain(gainToDb(1.7))).toBeCloseTo(1.7)
		expect(gainToDb(0)).toBe(-Infinity)
	})
})

describe('bucketPeaks', () => {
	it('keeps the loudest sample of each bucket as a percentage of full scale', () => {
		const samples = [0, 16384, -32768, 100, 0, 0, 8192, -8192]
		expect(bucketPeaks(samples, 4)).toEqual([100, 25])
	})

	it('handles a final short bucket and an empty input', () => {
		expect(bucketPeaks([32767, 0, 0], 2)).toEqual([100, 0])
		expect(bucketPeaks([], 160)).toEqual([])
	})
})

describe('parseLoudness', () => {
	const summary = `
[Parsed_ebur128_0 @ 0x1] t: 11.9  TARGET:-23 LUFS  M: -17.0 S: -16.2  I: -16.5 LUFS  LRA: 1.0 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -15.1 LUFS
    Threshold: -25.1 LUFS

  Loudness range:
    LRA:         3.2 LU
    Threshold: -35.1 LUFS

  True peak:
    Peak:       -1.6 dBFS
`
	it('reads the verdict, not the per-frame lines before it', () => {
		expect(parseLoudness(summary)).toEqual({ lufs: -15.1, lra: 3.2, truePeakDb: -1.6 })
	})

	it('reports nothing it did not see, and survives silence', () => {
		expect(parseLoudness('no summary here')).toEqual({ lufs: null, lra: null, truePeakDb: null })
		expect(parseLoudness('Summary:\n I: -inf LUFS\n')).toMatchObject({ lufs: null })
	})
})

describe('peaksForRange', () => {
	const a = { peakRate: 10, peaks: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90] } // 1 second

	it('takes the loudest bucket under each output bar', () => {
		expect(peaksForRange(a, 0, 1, 5)).toEqual([10, 30, 50, 70, 90])
	})

	it('plays only the trimmed part of the source', () => {
		expect(peaksForRange(a, 0.5, 1, 5)).toEqual([50, 60, 70, 80, 90])
	})

	it('gives a flat line for nothing to draw', () => {
		expect(peaksForRange({ peakRate: 10, peaks: [] }, 0, 1, 3)).toEqual([0, 0, 0])
		expect(peaksForRange(a, 1, 1, 3)).toEqual([0, 0, 0])
		expect(peaksForRange(a, 0, 1, 0)).toEqual([])
	})

	it('never reads past the end of the source', () => {
		expect(peaksForRange(a, 0.8, 2, 4).every((v) => Number.isFinite(v))).toBe(true)
	})
})

describe('waveformPath', () => {
	it('draws one centred bar per value, clamped to the box', () => {
		const d = waveformPath([100, 0], 20, 3, 1)
		expect(d).toBe('M1 0.0V20.0M4 9.0V11.0')
	})

	it('scales by gain but never overflows the box', () => {
		expect(waveformPath([80], 20, 3, 4)).toBe('M1 0.0V20.0')
	})
})

describe('formatLufs', () => {
	it('uses a real minus and an em dash for unknown', () => {
		expect(formatLufs(-15.12)).toBe('−15.1 LUFS')
		expect(formatLufs(null)).toBe('—')
		expect(formatLufs(Number.NaN)).toBe('—')
	})
})
