import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TimelineItem } from './types'
import {
	BLANK_MOTION_HTML, composeCandidatePage, composeMotionPage, lintMotionKit, motionKitFor, motionRenderRecipe,
	normaliseDefinition, type MotionKit, type MotionSpec
} from './motion'
import { MOTION_FONT_CSS, MOTION_FONT_FAMILIES } from './motion-templates/fonts'
import { applyTimelineDiff, diffTimelines, type TimelineState } from './timeline'

const FONTS_DIR = join(__dirname, 'motion-templates', 'fonts')
const frame = { width: 640, height: 360 }

const PAGE = '<div id="card"></div><script>frameflow.define({ duration: 2, moments: [], settings: [], seek(t) { nomad.draw(t) } })</script>'
const KIT: MotionKit = {
	id: 'nomad',
	label: 'Nomad',
	css: '#card { color: #FF6A3D; font: 700 40px Inter, sans-serif }',
	js: 'window.nomad = { draw: function (t) { document.getElementById("card").textContent = String(t) } }'
}
const custom = (over: Partial<MotionSpec> = {}): MotionSpec => {
	const definition = normaliseDefinition({ duration: 2 })
	return { html: PAGE, definition, passed: { html: PAGE, definition, verified: true }, ...over }
}
const item = (id: string, spec: MotionSpec): TimelineItem => ({
	id, trackId: 'm', sourceAssetId: '', timelineStart: 0, in: 0, out: 2, speed: 1, preservePitch: true, duration: 2, motion: spec
})

describe('the bundled fonts', () => {
	const faces = MOTION_FONT_CSS.split('\n')
	const b64Of = (face: string) => /base64,([A-Za-z0-9+/=]+)\)/.exec(face)![1]

	it('bundle Vazirmatn for Arabic script beside Inter and Outfit', () => {
		expect(MOTION_FONT_FAMILIES).toEqual(['Inter', 'Outfit', 'Vazirmatn'])
		expect(faces).toHaveLength(4)
		expect(faces.filter((f) => f.includes("font-family:'Vazirmatn'"))).toHaveLength(1)
	})

	it('embed each file byte for byte, as a woff2', () => {
		const vazir = faces.find((f) => f.includes("font-family:'Vazirmatn'"))!
		const bytes = Buffer.from(b64Of(vazir), 'base64')
		expect(bytes.equals(readFileSync(join(FONTS_DIR, 'Vazirmatn-arabic.woff2')))).toBe(true)
		expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2')
		// A subset, not the whole 241 KB family: Latin is Inter's job.
		expect(bytes.length).toBeLessThan(50_000)
	})

	it('draw Persian in Vazirmatn inside any Inter stack, and leave Inter’s Latin alone', () => {
		const interFaces = faces.filter((f) => f.includes("font-family:'Inter'"))
		expect(interFaces).toHaveLength(2)
		// Inter's own face first, with no range: it is what Latin text uses.
		expect(interFaces[0]).not.toContain('unicode-range')
		// The Vazirmatn copy inside Inter covers only Arabic script, and comes later
		// (the last matching face is tried first for a character).
		expect(interFaces[1]).toContain('unicode-range:U+0600-06FF')
		expect(b64Of(interFaces[1])).toBe(b64Of(faces.find((f) => f.includes("font-family:'Vazirmatn'"))!))
		// Vazirmatn on its own spaces and punctuates Persian itself; inside Inter, Inter does.
		expect(faces.find((f) => f.includes("font-family:'Vazirmatn'"))).toContain('unicode-range:U+0020-0021,')
		expect(interFaces[1]).not.toContain('U+0020')
		for (const face of faces) expect(face).toContain('font-weight:100 900')
	})

	it('ship their licences and provenance', () => {
		const ofl = readFileSync(join(FONTS_DIR, 'OFL-Vazirmatn.txt'), 'utf8')
		expect(ofl).toMatch(/Copyright 2015 The Vazirmatn Project Authors/)
		expect(ofl).toMatch(/SIL Open Font License, Version 1\.1/)
		const readme = readFileSync(join(FONTS_DIR, 'README.md'), 'utf8')
		expect(readme).toMatch(/v33\.003/)
		expect(readme).toMatch(/github\.com\/rastikerdar\/vazirmatn/)
	})

	it('are in every composed page', () => {
		const page = composeMotionPage({ template: 'lower-third' }, frame)
		expect(page).toContain("font-family:'Vazirmatn';src:url(data:font/woff2;base64,")
	})
})

describe('composing a page with a motion kit', () => {
	const kits = [KIT, { id: 'other', css: '.x{}' }]
	const page = composeMotionPage(custom({ kit: 'nomad' }), frame, kits)

	it('inlines the kit’s css and js after the runtime and before the page', () => {
		const runtime = page.indexOf('window.frameflow = ff')
		const css = page.indexOf(`<style data-ff-kit="nomad">${KIT.css}</style>`)
		const js = page.indexOf(`<script data-ff-kit="nomad">${KIT.js}</script>`)
		const own = page.indexOf('<div id="card">')
		expect(runtime).toBeGreaterThan(0)
		expect(css).toBeGreaterThan(runtime)
		expect(js).toBeGreaterThan(css)
		expect(own).toBeGreaterThan(js)
		expect(page).not.toContain('.x{}')
	})

	it('leaves a page without a kit exactly as it was', () => {
		const plain = custom()
		expect(composeMotionPage(plain, frame, kits)).toBe(composeMotionPage(plain, frame))
		expect(composeMotionPage(plain, frame)).not.toContain('data-ff-kit')
	})

	it('never gives a template a kit', () => {
		const template: MotionSpec = { template: 'lower-third', kit: 'nomad' }
		expect(motionKitFor(template, kits)).toBeUndefined()
		expect(composeMotionPage(template, frame, kits)).toBe(composeMotionPage({ template: 'lower-third' }, frame))
	})

	it('says so in the page when the kit is missing', () => {
		expect(composeMotionPage(custom({ kit: 'gone' }), frame, kits)).toContain('<!-- motion kit "gone" is not in this project -->')
	})

	it('cannot be broken out of by kit text', () => {
		const sneaky = composeMotionPage(custom({ kit: 'k' }), frame, [{ id: 'k', css: 'a{}</style><script>alert(1)</script>', js: 'var s = "</script><b>"' }])
		const head = sneaky.slice(0, sneaky.indexOf('<div id="card">'))
		expect(head.match(/<\/style>/g)).toHaveLength(2) // the base styles' and the kit's own
		expect(head).not.toContain('</script><b>')
	})

	it('composes the monitor’s, the export’s and the probe’s page identically', () => {
		const spec = custom({ kit: 'nomad' })
		// The monitor: the layer's spec and the project's kits.
		const monitor = composeMotionPage(spec, frame, kits)
		// The export: the slice carries the one kit the item uses (renderBuilders.motionJobsFor).
		const exported = composeMotionPage(spec, frame, [motionKitFor(spec, kits)!])
		// The probe: the candidate text as the passing version, with its kit.
		const probed = composeCandidatePage(PAGE, spec.definition!, frame, motionKitFor(spec, kits))
		expect(exported).toBe(monitor)
		expect(probed).toBe(monitor)
	})
})

describe('kits and the render cache', () => {
	const fps = 30
	const users = item('a', custom({ kit: 'nomad' }))
	const loner = item('b', custom())
	const restyled: MotionKit = { ...KIT, css: '#card { color: #1E8A5A; font: 700 40px Inter, sans-serif }' }

	it('re-renders exactly the clips whose pages use the edited kit', () => {
		const before = [KIT]
		const after = [restyled]
		expect(motionRenderRecipe(users, { ...frame, fps }, after)).not.toBe(motionRenderRecipe(users, { ...frame, fps }, before))
		expect(motionRenderRecipe(loner, { ...frame, fps }, after)).toBe(motionRenderRecipe(loner, { ...frame, fps }, before))
		// An unrelated kit appearing changes nothing either.
		expect(motionRenderRecipe(users, { ...frame, fps }, [KIT, { id: 'z', css: 'b{}' }])).toBe(motionRenderRecipe(users, { ...frame, fps }, before))
	})
})

describe('kits in the timeline diff', () => {
	const base = (kits?: MotionKit[]): TimelineState => ({ tracks: [], timeline: [item('a', custom({ kit: 'nomad' }))], motionKits: kits })

	it('is one undoable step that round-trips', () => {
		const before = base([KIT])
		const after = base([{ ...KIT, css: 'b{}' }, { id: 'new', js: 'window.x = 1' }])
		const diffed = diffTimelines(before, after)!
		expect(diffed.forward.setMotionKits?.map((k) => k.id)).toEqual(['nomad', 'new'])
		expect(diffed.inverse.setMotionKits).toEqual([KIT])
		expect(diffed.inverse.removeMotionKitIds).toEqual(['new'])
		expect(diffed.forward.updateItems).toBeUndefined()

		const redo = base([KIT])
		applyTimelineDiff(redo, diffed.forward)
		expect(redo.motionKits).toEqual(after.motionKits)
		applyTimelineDiff(redo, diffed.inverse)
		expect(redo.motionKits).toEqual([KIT])
	})

	it('removes and restores a kit', () => {
		const diffed = diffTimelines(base([KIT]), base([]))!
		expect(diffed.forward.removeMotionKitIds).toEqual(['nomad'])
		const state = base([])
		applyTimelineDiff(state, diffed.inverse)
		expect(state.motionKits).toEqual([KIT])
	})

	it('never reads a state built without kits as "every kit was deleted"', () => {
		expect(diffTimelines(base([KIT]), base(undefined))).toBeNull()
		expect(diffTimelines(base(undefined), base([KIT]))).toBeNull()
	})
})

describe('lintMotionKit', () => {
	it('holds a kit to the page rules, without asking it to define anything', () => {
		expect(lintMotionKit(KIT)).toEqual([])
		expect(lintMotionKit({ id: 'k', js: 'window.t = Date.now()' })[0]).toMatch(/^js line 1 .*wall clock/)
		expect(lintMotionKit({ id: 'k', css: 'a{}\n.b { transition: opacity 1s }' })[0]).toMatch(/^css line 2/)
		expect(lintMotionKit({ id: 'k', css: '@import url(x.css);' })).toHaveLength(1)
	})

	it('wants a usable id and bare css/js', () => {
		expect(lintMotionKit({ id: 'bad id' })[0]).toMatch(/kit id/)
		expect(lintMotionKit({ id: 'k', css: '<style>a{}</style>' })[0]).toMatch(/<\/style>/)
		expect(lintMotionKit({ id: 'k', js: '<script>1</script>' })[0]).toMatch(/<\/script>/)
	})

	it('does not need the page lint’s define', () => {
		expect(lintMotionKit({ id: 'k', js: BLANK_MOTION_HTML.replace(/<\/?script>/g, '') })).toEqual([])
	})
})
