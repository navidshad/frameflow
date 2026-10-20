import { describe, expect, it } from 'vitest'
import {
	describeRecipe, isSoundKind, normaliseRecipe, presetOf, recipeKey, SOUND_GROUPS, SOUND_PRESETS, soundFinish,
	soundGraph, soundLead, soundLength, soundPeakDb
} from './synth'

describe('the palette', () => {
	it('has the sixteen sounds and the bed', () => {
		expect(SOUND_PRESETS).toHaveLength(17)
		expect(SOUND_PRESETS.filter((p) => p.kind !== 'bed')).toHaveLength(16)
	})

	it('puts every sound in a known group, with a level that sits under full scale', () => {
		for (const p of SOUND_PRESETS) {
			expect(SOUND_GROUPS, p.kind).toContain(p.group)
			expect(p.level, p.kind).toBeLessThan(0)
			expect(p.lead, p.kind).toBeGreaterThanOrEqual(0)
			expect(p.variants, p.kind).toBeGreaterThanOrEqual(1)
		}
	})

	it('knows its own kinds', () => {
		expect(isSoundKind('whoosh')).toBe(true)
		expect(isSoundKind('toString')).toBe(false)
		expect(isSoundKind(7)).toBe(false)
	})
})

describe('a recipe', () => {
	it('spells the same sound one way: defaults are written out', () => {
		expect(recipeKey({ kind: 'whoosh' })).toBe(recipeKey({ kind: 'whoosh', pitch: 0, seed: 0, variant: 0, levelDb: -17, air: 0.4 }))
		expect(recipeKey({ kind: 'whoosh' })).not.toBe(recipeKey({ kind: 'whoosh', pitch: 2 }))
		expect(recipeKey({ kind: 'whoosh' })).not.toBe(recipeKey({ kind: 'swish' }))
	})

	it('clamps a take to the ones the sound has, and drops a length it does not follow', () => {
		expect(normaliseRecipe({ kind: 'click', variant: 4 }).variant).toBe(0)
		expect(normaliseRecipe({ kind: 'key', variant: 9 }).variant).toBe(4)
		expect(normaliseRecipe({ kind: 'pop', durationSec: 3 }).durationSec).toBe(0)
		expect(normaliseRecipe({ kind: 'flight', durationSec: 1.2345 }).durationSec).toBe(1.235)
	})

	it('measures how long it lasts, following the motion where it should', () => {
		expect(soundLength({ kind: 'click' })).toBeCloseTo(0.12)
		expect(soundLength({ kind: 'whoosh' })).toBeCloseTo(0.5)
		expect(soundLength({ kind: 'flight', durationSec: 1 })).toBeCloseTo(1.12)
		expect(soundLength({ kind: 'rise', durationSec: 2 })).toBeCloseTo(2.35)
		expect(soundLength({ kind: 'bed', durationSec: 30 })).toBe(30)
	})

	it('starts a whoosh early so its hit lands on the cue', () => {
		expect(soundLead({ kind: 'whoosh' })).toBeGreaterThan(soundLead({ kind: 'click' }))
	})
})

describe('the graph', () => {
	it('is deterministic: the same recipe is the same text', () => {
		for (const p of SOUND_PRESETS) {
			expect(soundGraph({ kind: p.kind, durationSec: 2 }), p.kind).toBe(soundGraph({ kind: p.kind, durationSec: 2 }))
		}
	})

	it('ends every graph at [out], for the renderer to finish', () => {
		for (const p of SOUND_PRESETS) {
			expect(soundGraph({ kind: p.kind, durationSec: 2 }), p.kind).toMatch(/\[out\]$/)
		}
		expect(soundFinish({ kind: 'whoosh' })).toBe('[out]pan=stereo|c0=c0|c1=c0[final]')
		// The bed is already stereo.
		expect(soundFinish({ kind: 'bed', durationSec: 8 })).toBe('[out]anull[final]')
		// The level is the peak the renderer scales to.
		expect(soundPeakDb({ kind: 'whoosh' })).toBe(-17)
		expect(soundPeakDb({ kind: 'whoosh', levelDb: -9 })).toBe(-9)
	})

	it('moves with the seed, the pitch and the air', () => {
		const base = soundGraph({ kind: 'whoosh' })
		expect(soundGraph({ kind: 'whoosh', seed: 3 })).not.toBe(base)
		expect(soundGraph({ kind: 'whoosh', pitch: 2 })).not.toBe(base)
		expect(soundGraph({ kind: 'whoosh', air: 0.8 })).not.toBe(base)
		// A tonal sound has no noise to seed.
		expect(soundGraph({ kind: 'blip', seed: 3 })).toBe(soundGraph({ kind: 'blip' }))
	})

	it('lays the bed out as one chord every four seconds', () => {
		const g = soundGraph({ kind: 'bed', durationSec: 10 })
		expect(g.match(/aevalsrc=/g)).toHaveLength(3)
		expect(g).toContain('adelay=4000|4000')
		expect(g).toContain('adelay=8000|8000')
		expect(g).toContain('atrim=duration=10')
	})
})

describe('describeRecipe', () => {
	it('reads as words', () => {
		expect(describeRecipe({ kind: 'whoosh' })).toBe('whoosh, −17 dB')
		expect(describeRecipe({ kind: 'key', variant: 2, pitch: -3, seed: 5 })).toBe('key, take 3, pitch −3, −18 dB, seed 5')
		expect(presetOf('bed').follows).toBe(true)
	})
})
