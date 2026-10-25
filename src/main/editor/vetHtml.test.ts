import { describe, expect, it } from 'vitest'
import type { EditorOps } from '@shared/types'
import { vetHtmlOps, vetPage, whyPageFails, type MotionProbe } from './vetHtml'

const PAGE = [
	'<div id="n"></div>',
	'<script>frameflow.define({ duration: 4, settings: [{ key: "value", type: "number", default: 3 }],',
	'  moments: [{ name: "in", duration: 0.5 }, { name: "hold", duration: 3, flex: true }, { name: "out", duration: 0.5 }],',
	'  seek(t, s) { n.textContent = String(ease(clamp(t / 2)) * s.value) } })</script>'
].join('\n')
const doc = { timelineMeta: { width: 1280, height: 720, fps: 30, duration: 10 } }
const pass: MotionProbe = async () => ({ determinism: 'pass' })

describe('whyPageFails', () => {
	it('passes a clean page that draws the same twice', async () => {
		expect(await whyPageFails(PAGE, { width: 1280, height: 720 }, pass)).toBeNull()
	})

	it('names the rule, the line and the offending text for the lint', async () => {
		const reason = await whyPageFails(PAGE.replace('String(', 'String(Date.now() + '), { width: 1, height: 1 }, pass)
		expect(reason).toMatch(/^line 4 — “seek\(t, s\) \{ n\.textContent = String\(Date\.now\(\)/)
		expect(reason).toMatch(/wall clock/)
	})

	it('says how many more there are', async () => {
		const reason = await whyPageFails(PAGE.replace('String(', 'String(Date.now() + Math.random() + '), { width: 1, height: 1 })
		expect(reason).toMatch(/\(and 1 more\)/)
	})

	it('does not draw a page the lint already rejected', async () => {
		let drawn = 0
		await whyPageFails(PAGE.replace('String(', 'String(Date.now() + '), { width: 1, height: 1 }, async () => { drawn++; return { determinism: 'pass' } })
		expect(drawn).toBe(0)
	})

	it('draws a clean page once, at the sequence size, with the definition read from its text', async () => {
		const seen: any[] = []
		await whyPageFails(PAGE, { width: 1280, height: 720 }, async (input) => { seen.push(input); return { determinism: 'pass' } })
		expect(seen).toHaveLength(1)
		expect(seen[0].frame).toEqual({ width: 1280, height: 720 })
		expect(seen[0].definition.settings.map((s: any) => s.key)).toEqual(['value'])
	})

	it('gives the probe’s reasons: a page that throws, and a frame that differs', async () => {
		expect(await whyPageFails(PAGE, { width: 1, height: 1 }, async () => ({ determinism: 'fail', error: 'x is not defined' })))
			.toBe('the page throws when it runs: x is not defined')
		const differs = await whyPageFails(PAGE, { width: 1, height: 1 }, async () => ({ determinism: 'fail', differsAt: 2 }))
		expect(differs).toMatch(/same frame twice gave different pixels at t = 2\.00s/)
		expect(differs).toMatch(/depends on state left by an earlier call/)
	})

	it('turns the probe’s evidence into where, how much and the likely cause', async () => {
		const difference = { box: { x: 30, y: 60, width: 3, height: 90 }, pixels: 30, share: 0.0001, maxDelta: 40, meanDelta: 22, scale: 3, looksSubPixel: true, image: 'PNGDATA' }
		const verdict = await vetPage(PAGE, { width: 1, height: 1 }, async () => ({ determinism: 'fail', differsAt: 3.9, difference }))
		expect(verdict.reason).toMatch(/at t = 3\.90s: 30 pixels differ \(<0\.1% of the frame, probed at 1\/3 size\), in a box 3×90 px at x 30, y 60/)
		expect(verdict.reason).toMatch(/largest change is 40\/255, the average 22\/255/)
		expect(verdict.reason).toMatch(/This looks like a sub-pixel position: .*Math\.round/)
		expect(verdict.image).toBe('PNGDATA')
		const state = await vetPage(PAGE, { width: 1, height: 1 }, async () => ({ determinism: 'fail', differsAt: 1, difference: { ...difference, looksSubPixel: false } }))
		expect(state.reason).toMatch(/This looks like state: .*layout MEASURED before it is UPDATED/)
	})

	it('lets the lint decide alone where there is no window, and when the probe cannot run', async () => {
		expect(await whyPageFails(PAGE, { width: 1, height: 1 })).toBeNull()
		expect(await whyPageFails(PAGE, { width: 1, height: 1 }, async () => ({ determinism: 'skipped' }))).toBeNull()
	})
})

describe('vetHtmlOps', () => {
	const bad: MotionProbe = async (input) => (input.html.includes('BAD') ? { determinism: 'fail', differsAt: 1 } : { determinism: 'pass' })
	const BAD = PAGE.replace('<div id="n">', '<div id="BAD">')

	it('takes a failing page’s op out, keeps every other op, and gives one reason each', async () => {
		const ops: EditorOps = {
			rationale: 'Two graphics',
			removeItemIds: ['x'],
			addMotion: [{ template: 'lower-third', atSec: 1 }, { template: 'custom', atSec: 2, html: BAD }, { template: 'custom', atSec: 3, html: PAGE }],
			updateMotion: [{ id: 'a', html: BAD }, { id: 'b', settings: { name: 'Sara' } }, { id: 'c', html: PAGE }]
		}
		const { ops: vetted, dropped } = await vetHtmlOps(ops, doc, bad)
		expect(vetted.addMotion!.map((a) => a.atSec)).toEqual([1, 3])
		expect(vetted.updateMotion!.map((u) => u.id)).toEqual(['b', 'c'])
		expect(vetted.removeItemIds).toEqual(['x'])
		expect(vetted.rationale).toBe('Two graphics')
		expect(dropped).toHaveLength(2)
		expect(dropped[0]).toMatch(/^addMotion\[1\] \(custom page\) rejected, nothing was added: drawing the same frame twice/)
		expect(dropped[1]).toMatch(/^updateMotion a rejected, the layer keeps its previous page: drawing the same frame twice/)
		// Not mutated: the caller's ops are what the agent sent.
		expect(ops.addMotion).toHaveLength(3)
	})

	it('drops the whole op, settings and timing included — "the diff for that op is not applied"', async () => {
		const { ops: vetted } = await vetHtmlOps({ updateMotion: [{ id: 'a', html: BAD, settings: { name: 'x' }, atSec: 9, durationSec: 2 }] }, doc, bad)
		expect(vetted.updateMotion).toBeUndefined()
	})

	it('returns the very same ops when nothing is wrong, and never draws a page-free call', async () => {
		let drawn = 0
		const probe: MotionProbe = async () => { drawn++; return { determinism: 'pass' } }
		const plain: EditorOps = { addMotion: [{ template: 'lower-third', atSec: 1 }], updateMotion: [{ id: 'a', settings: { name: 'x' } }] }
		const result = await vetHtmlOps(plain, doc, probe)
		expect(result.ops).toBe(plain)
		expect(result.dropped).toEqual([])
		expect(drawn).toBe(0)
		expect((await vetHtmlOps({ addMotion: [{ template: 'custom', atSec: 1, html: PAGE }] }, doc, probe)).dropped).toEqual([])
		expect(drawn).toBe(1)
	})

	it('hands back what each passing page reported at run time, and the image of each that drew two ways', async () => {
		const reported = { duration: 9, settings: [], moments: [] }
		const probe: MotionProbe = async (input) => input.html.includes('BAD')
			? { determinism: 'fail', differsAt: 1, difference: { box: { x: 0, y: 0, width: 1, height: 1 }, pixels: 1, share: 0, maxDelta: 255, meanDelta: 255, scale: 1, looksSubPixel: false, image: 'IMG' } }
			: { determinism: 'pass', definition: reported }
		const result = await vetHtmlOps({ addMotion: [{ template: 'custom', atSec: 1, html: PAGE }], updateMotion: [{ id: 'a', html: BAD }] }, doc, probe)
		expect(result.definitions.get(PAGE)).toEqual(reported)
		expect(result.images).toEqual([{ op: 'updateMotion a', data: 'IMG', mimeType: 'image/png' }])
	})

	it('treats a blank html as no page', async () => {
		const { ops: vetted, dropped } = await vetHtmlOps({ addMotion: [{ template: 'custom', atSec: 1, html: '   ' }] }, doc, bad)
		expect(dropped).toEqual([])
		expect(vetted.addMotion).toHaveLength(1)
	})
})
