import { describe, expect, it } from 'vitest'
import {
	allEffects, defaultParams, effectChain, effectCss, effectDef, effectGroups, kelvinGains,
	hasRenderableEffects, isEffectKind, previewFidelity, registerEffects, type EffectDef
} from './effects'

const applied = (kind: string, params?: Record<string, number | string>) =>
	[{ id: 'e1', kind, params }]

describe('the catalogue', () => {
	it('ships a usable set rather than a demo', () => {
		expect(allEffects().length).toBeGreaterThanOrEqual(21)
		expect(effectGroups('video').map((g) => g.group)).toEqual(['Adjust', 'Looks', 'Detail'])
	})

	it('gates unknown kinds', () => {
		expect(isEffectKind('saturation')).toBe(true)
		expect(isEffectKind('teleport')).toBe(false)
	})

	it('starts every parameterised effect at a value that changes nothing', () => {
		// Dragging an effect onto a clip must not alter the picture until a slider
		// moves — otherwise "add" and "apply" are the same gesture and there is no
		// way to see what your own adjustment did.
		for (const def of allEffects()) {
			if (!def.params.length) continue
			expect(def.build(defaultParams(def)), def.kind).toBe('')
		}
	})

	it('applies a look the moment it lands, because it has nothing to adjust', () => {
		const vintage = effectDef('look-vintage')!
		expect(vintage.params).toEqual([])
		expect(vintage.build({})).toBe('curves=preset=vintage')
	})
})

describe('audio repair', () => {
	it('is offered on the audio stream only', () => {
		expect(effectGroups('audio').map((g) => g.group)).toEqual(['Repair'])
		expect(effectGroups('video').map((g) => g.group)).not.toContain('Repair')
	})

	it('writes the filter each control names', () => {
		expect(effectChain(applied('denoise', { amount: 12 }), 'audio')).toEqual(['afftdn=nr=12:nf=-40'])
		expect(effectChain(applied('rumble', { hz: 80 }), 'audio')).toEqual(['highpass=f=80'])
		expect(effectChain(applied('level', { strength: 3 }), 'audio')).toEqual(['speechnorm=e=3:p=0.95'])
	})

	it('starts off, like every other effect', () => {
		expect(effectChain(applied('denoise', { amount: 0 }), 'audio')).toEqual([])
		expect(effectChain(applied('rumble', { hz: 0 }), 'audio')).toEqual([])
		expect(effectChain(applied('compress', { ratio: 1 }), 'audio')).toEqual([])
	})
})

describe('build', () => {
	it('writes the filter the parameter asks for', () => {
		expect(effectChain(applied('saturation', { amount: 0 }), 'video')).toEqual(['eq=saturation=0'])
		expect(effectChain(applied('contrast', { amount: 1.4 }), 'video')).toEqual(['eq=contrast=1.4'])
		expect(effectChain(applied('exposure', { amount: -0.25 }), 'video')).toEqual(['eq=brightness=-0.25'])
		expect(effectChain(applied('hue', { degrees: 90 }), 'video')).toEqual(['hue=h=90'])
		expect(effectChain(applied('blur', { radius: 4 }), 'video')).toEqual(['gblur=sigma=4'])
	})

	it('clamps a parameter that is out of range rather than emitting nonsense', () => {
		expect(effectChain(applied('saturation', { amount: 99 }), 'video')).toEqual(['eq=saturation=3'])
		expect(effectChain(applied('saturation', { amount: -99 }), 'video')).toEqual(['eq=saturation=0'])
	})

	it('falls back to the identity value for a missing or unreadable parameter', () => {
		expect(effectChain(applied('contrast', {}), 'video')).toEqual([])
		expect(effectChain(applied('contrast', { amount: NaN }), 'video')).toEqual([])
		expect(effectChain(applied('contrast', { amount: 'wat' }), 'video')).toEqual([])
	})

	it('keeps the user’s order, because a filter chain is not commutative', () => {
		const chain = effectChain([
			{ id: 'a', kind: 'blur', params: { radius: 3 } },
			{ id: 'b', kind: 'sharpen', params: { amount: 1 } }
		], 'video')
		expect(chain).toEqual(['gblur=sigma=3', 'unsharp=5:5:1:5:5:0'])
	})

	it('skips an unknown kind instead of throwing', () => {
		// A project made with a pack installed has to open without it.
		expect(effectChain([
			{ id: 'a', kind: 'from-some-pack' },
			{ id: 'b', kind: 'saturation', params: { amount: 2 } }
		], 'video')).toEqual(['eq=saturation=2'])
	})

	it('keeps the two streams apart', () => {
		expect(effectChain(applied('saturation', { amount: 2 }), 'audio')).toEqual([])
	})
})

describe('the monitor’s approximation', () => {
	it('matches the export at midtone for the eq family', () => {
		// eq ADDS to a pixel, CSS MULTIPLIES it. A 0.5 pixel with brightness=0.1
		// becomes 0.6 either way; that is the equivalence, and it is deliberate
		// that they part company at the extremes.
		expect(effectCss(applied('exposure', { amount: 0.1 }))).toBe('brightness(1.2)')
		expect(effectCss(applied('contrast', { amount: 1.4 }))).toBe('contrast(1.4)')
		expect(effectCss(applied('saturation', { amount: 0 }))).toBe('saturate(0)')
	})

	it('says nothing for effects it cannot approximate', () => {
		expect(effectCss(applied('gamma', { amount: 2 }))).toBe('')
		expect(effectCss(applied('look-vintage'))).toBe('')
	})

	it('shows warmth as the same per-channel gain ffmpeg applies', () => {
		expect(effectCss(applied('warmth', { kelvin: 6500 }))).toBe('')
		const css = effectCss(applied('warmth', { kelvin: 9000 }))
		expect(css.startsWith('url("data:image/svg+xml,')).toBe(true)
		const svg = decodeURIComponent(css.slice('url("data:image/svg+xml,'.length, css.lastIndexOf('#w')))
		// Linear-light interpolation would make the monitor darker than the export.
		expect(svg).toContain("color-interpolation-filters='sRGB'")
		expect(svg).toContain("values='0.8219 0 0 0 0 0 0.874 0 0 0 0 0 1 0 0 0 0 0 1 0'")
		expect(previewFidelity(effectDef('warmth')!)).toBe('approximate')
	})

	it('cools above 6500 K and warms below it', () => {
		const [r9, , b9] = kelvinGains(9000)
		expect(r9).toBeLessThan(b9)
		const [r3, , b3] = kelvinGains(3000)
		expect(r3).toBeGreaterThan(b3)
	})

	it('composes, in the same order', () => {
		expect(effectCss([
			{ id: 'a', kind: 'saturation', params: { amount: 0 } },
			{ id: 'b', kind: 'contrast', params: { amount: 2 } }
		])).toBe('saturate(0) contrast(2)')
	})
})

describe('hasRenderableEffects', () => {
	it('is what keeps a graded clip off the fast path', () => {
		expect(hasRenderableEffects(undefined)).toBe(false)
		expect(hasRenderableEffects([])).toBe(false)
		// Added but untouched: nothing to render, so the fast path is still fine.
		expect(hasRenderableEffects(applied('contrast', { amount: 1 }))).toBe(false)
		expect(hasRenderableEffects(applied('contrast', { amount: 1.5 }))).toBe(true)
		expect(hasRenderableEffects(applied('look-vintage'))).toBe(true)
	})
})

describe('registerEffects', () => {
	it('is the door a pack comes in through', () => {
		const fake: EffectDef = {
			kind: 'test-only-look', label: 'Test', group: 'Packs', stream: 'video',
			description: 'x', params: [], build: () => 'curves=preset=negative'
		}
		expect(registerEffects([fake])).toEqual([])
		expect(effectChain(applied('test-only-look'), 'video')).toEqual(['curves=preset=negative'])
		// Registering the same kind again reports what it displaced, so an
		// override is deliberate rather than silent.
		expect(registerEffects([fake])).toEqual(['test-only-look'])
	})
})

describe('previewFidelity', () => {
	it('gives every registered kind a verdict, derived rather than listed', () => {
		// A curated "what previews" list is the bug class the transition cache
		// key fell into; this is derived from whether a CSS approximation
		// exists, so it cannot go stale.
		for (const def of allEffects()) {
			expect(['approximate', 'export-only'], def.kind).toContain(previewFidelity(def))
		}
	})

	it('matches the facts the catalogue states', () => {
		expect(previewFidelity(effectDef('saturation')!)).toBe('approximate')
		expect(previewFidelity(effectDef('gamma')!)).toBe('export-only')
		expect(previewFidelity(effectDef('look-vintage')!)).toBe('export-only')
		expect(previewFidelity(effectDef('denoise')!)).toBe('export-only')
	})
})
