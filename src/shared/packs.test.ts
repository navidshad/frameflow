import { describe, expect, it } from 'vitest'
import { escapeFilterPath, parsePack, starterManifest, STARTER_LOOKS, toCube } from './packs'
import { effectDef } from './effects'

const resolve = (name: string) => (name.endsWith('.cube') ? `/packs/demo/${name}` : null)

const manifest = (effects: unknown[]) => ({ name: 'Demo Pack', version: 1, effects })

describe('parsePack', () => {
	it('turns a LUT entry into an effect that points at the file', () => {
		const { effects, problems } = parsePack(
			manifest([{ kind: 'demo-warm', label: 'Warm', lut: 'warm.cube' }]),
			resolve
		)
		expect(problems).toEqual([])
		expect(effects[0].kind).toBe('demo-warm')
		expect(effects[0].group).toBe('Demo Pack')
		expect(effects[0].build({})).toBe('lut3d=file=/packs/demo/warm.cube')
	})

	it('turns a preset entry into the built-in it names', () => {
		const { effects } = parsePack(
			manifest([{ kind: 'demo-punch', label: 'Punch', base: 'contrast', params: { amount: 1.6 } }]),
			resolve
		)
		expect(effects[0].build({})).toBe('eq=contrast=1.6')
		// The preset is fixed: it has no sliders of its own.
		expect(effects[0].params).toEqual([])
	})

	it('clamps a preset with the base effect’s own limits', () => {
		// A pack cannot smuggle a value past the range the built-in declares.
		const { effects } = parsePack(
			manifest([{ kind: 'demo-wild', label: 'Wild', base: 'saturation', params: { amount: 999 } }]),
			resolve
		)
		expect(effects[0].build({})).toBe('eq=saturation=3')
	})

	it('carries the base’s monitor approximation too', () => {
		const { effects } = parsePack(
			manifest([{ kind: 'demo-mono', label: 'Mono', base: 'saturation', params: { amount: 0 } }]),
			resolve
		)
		expect(effects[0].css?.({})).toBe('saturate(0)')
	})
})

describe('what a pack is not allowed to do', () => {
	it('cannot supply a raw filter string', () => {
		// The one rule that keeps a downloaded pack from reading the filesystem:
		// `movie=` and `subtitles=` are filters, and a filtergraph is not a
		// sandbox. Only a LUT or a preset of something we already render.
		const { effects, problems } = parsePack(
			manifest([{ kind: 'evil', label: 'Evil', filter: 'movie=/etc/passwd' }]),
			resolve
		)
		expect(effects).toEqual([])
		expect(problems[0].reason).toContain('unknown base effect')
	})

	it('cannot walk out of its own directory', () => {
		const { effects, problems } = parsePack(
			manifest([{ kind: 'escape', label: 'Escape', lut: '../../../.ssh/id_rsa.cube' }]),
			resolve
		)
		expect(effects).toEqual([])
		expect(problems[0].reason).toContain('.cube file in the pack directory')
	})

	it('cannot name a file that is not a LUT', () => {
		const { problems } = parsePack(
			manifest([{ kind: 'sneaky', label: 'Sneaky', lut: 'payload.sh' }]),
			resolve
		)
		expect(problems[0].reason).toContain('.cube')
	})

	it('cannot use a kind that is not a plain slug', () => {
		for (const kind of ['UPPER', 'has space', 'a', '../x', '']) {
			const { problems } = parsePack(manifest([{ kind, label: 'X', lut: 'a.cube' }]), resolve)
			expect(problems[0].reason, kind).toContain('slug')
		}
	})

	it('reports a missing file instead of emitting a broken filter', () => {
		const { effects, problems } = parsePack(
			manifest([{ kind: 'gone', label: 'Gone', lut: 'gone.cube' }]),
			() => null
		)
		expect(effects).toEqual([])
		expect(problems[0].reason).toContain('missing file')
	})

	it('survives a manifest that is not a manifest', () => {
		expect(parsePack(null, resolve).effects).toEqual([])
		expect(parsePack({ name: 'x' }, resolve).problems[0].entry).toBe('(manifest)')
		expect(parsePack('nope', resolve).effects).toEqual([])
	})

	it('keeps the good entries when one is bad', () => {
		const { effects, problems } = parsePack(
			manifest([
				{ kind: 'bad', label: 'Bad', lut: 'nope.txt' },
				{ kind: 'good', label: 'Good', lut: 'good.cube' }
			]),
			resolve
		)
		expect(effects.map((e) => e.kind)).toEqual(['good'])
		expect(problems).toHaveLength(1)
	})
})

describe('escapeFilterPath', () => {
	it('hides a colon from both parsers, exactly as the subtitles path does', () => {
		expect(escapeFilterPath('/tmp/a: b/x.cube')).toBe('/tmp/a\\\\: b/x.cube')
	})
})

describe('the starter pack', () => {
	it('describes files it actually generates', () => {
		const declared = starterManifest().effects.map((e) => (e as { lut: string }).lut).sort()
		const generated = STARTER_LOOKS.map((l) => `${l.kind}.cube`).sort()
		expect(declared).toEqual(generated)
	})

	it('parses through the same loader a third-party pack would', () => {
		const { effects, problems } = parsePack(starterManifest(), (n) => `/packs/starter/${n}`)
		expect(problems).toEqual([])
		expect(effects).toHaveLength(STARTER_LOOKS.length)
		expect(effects[0].build({})).toMatch(/^lut3d=file=/)
	})

	it('does not collide with a built-in kind', () => {
		for (const look of STARTER_LOOKS) expect(effectDef(look.kind)).toBeUndefined()
	})
})

describe('toCube', () => {
	const cube = toCube('Test', 5, (r, g, b) => [r, g, b])

	it('writes a header and size³ samples', () => {
		expect(cube).toContain('TITLE "Test"')
		expect(cube).toContain('LUT_3D_SIZE 5')
		const samples = cube.trim().split('\n').filter((l) => /^[\d.]/.test(l))
		expect(samples).toHaveLength(125)
	})

	it('varies red fastest, which is what the format specifies', () => {
		const samples = cube.trim().split('\n').filter((l) => /^[\d.]/.test(l))
		expect(samples[0]).toBe('0.000000 0.000000 0.000000')
		expect(samples[1]).toBe('0.250000 0.000000 0.000000')
		expect(samples[5]).toBe('0.000000 0.250000 0.000000')
		expect(samples[25]).toBe('0.000000 0.000000 0.250000')
	})

	it('clamps a map that leaves the cube', () => {
		const wild = toCube('Wild', 2, (r) => [r * 10 - 5, -1, 2])
		for (const line of wild.trim().split('\n').filter((l) => /^[\d.]/.test(l))) {
			for (const v of line.split(' ').map(Number)) {
				expect(v).toBeGreaterThanOrEqual(0)
				expect(v).toBeLessThanOrEqual(1)
			}
		}
	})

	it('leaves black and white where they are, for every starter look', () => {
		// A look that shifts pure black or clips pure white reads as a fault.
		for (const look of STARTER_LOOKS) {
			const [wr, wg, wb] = look.map(1, 1, 1)
			expect(Math.min(wr, wg, wb), look.kind).toBeGreaterThan(0.75)
		}
	})
})
