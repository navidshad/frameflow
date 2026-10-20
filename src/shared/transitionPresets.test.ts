import { describe, expect, it } from 'vitest'
import {
	FEATURED_KINDS,
	TRANSITION_PRESETS,
	isTransitionKind,
	transitionGroups,
	transitionLabel,
	transitionPreset
} from './transitionPresets'

describe('TRANSITION_PRESETS', () => {
	it('carries every xfade preset the bundled build offers', () => {
		// 58 named transitions, `custom` excluded — it needs an expression, not a
		// name. renderPipeline.test.ts checks this against the real binary.
		expect(TRANSITION_PRESETS).toHaveLength(58)
	})

	it('has no duplicate kinds', () => {
		const kinds = TRANSITION_PRESETS.map((p) => p.kind)
		expect(new Set(kinds).size).toBe(kinds.length)
	})

	it('gives every preset a label distinct from its raw name', () => {
		for (const preset of TRANSITION_PRESETS) {
			expect(preset.label.length).toBeGreaterThan(0)
			expect(preset.label).not.toBe(preset.kind)
		}
	})

	it('gives every preset an icon', () => {
		for (const preset of TRANSITION_PRESETS) expect(preset.icon).toBeTruthy()
	})

	it('lists the featured three first, in order', () => {
		expect(TRANSITION_PRESETS.slice(0, 3).map((p) => p.kind)).toEqual([...FEATURED_KINDS])
	})

	it('marks exactly the featured three as featured', () => {
		const featured = TRANSITION_PRESETS.filter((p) => p.group === 'featured').map((p) => p.kind)
		expect(featured).toEqual([...FEATURED_KINDS])
	})
})

describe('isTransitionKind', () => {
	it('accepts a real preset', () => {
		expect(isTransitionKind('fade')).toBe(true)
		expect(isTransitionKind('revealdown')).toBe(true)
	})

	it('rejects a name ffmpeg would not understand', () => {
		// The guard that keeps a bad kind from reaching `xfade=transition=` and
		// failing the whole render. Reachable from a hand-edited or AI-written doc.
		expect(isTransitionKind('crossfade')).toBe(false)
		expect(isTransitionKind('')).toBe(false)
	})

	it('rejects custom, which needs an expression rather than a name', () => {
		expect(isTransitionKind('custom')).toBe(false)
	})
})

describe('transitionPreset / transitionLabel', () => {
	it('resolves a known kind', () => {
		expect(transitionPreset('zoomin')?.label).toBe('Zoom In')
		expect(transitionLabel('slideleft')).toBe('Slide Left')
	})

	it('falls back to the raw name so the UI never renders blank', () => {
		expect(transitionPreset('nope')).toBeUndefined()
		expect(transitionLabel('nope')).toBe('nope')
	})
})

describe('transitionGroups', () => {
	it('opens with Featured', () => {
		expect(transitionGroups()[0].group).toBe('featured')
	})

	it('accounts for every preset exactly once', () => {
		const grouped = transitionGroups().flatMap((g) => g.presets)
		expect(grouped).toHaveLength(TRANSITION_PRESETS.length)
		expect(new Set(grouped.map((p) => p.kind)).size).toBe(TRANSITION_PRESETS.length)
	})

	it('omits no group and labels each one', () => {
		for (const group of transitionGroups()) {
			expect(group.presets.length).toBeGreaterThan(0)
			expect(group.label.length).toBeGreaterThan(0)
		}
	})
})
