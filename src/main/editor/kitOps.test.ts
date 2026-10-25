import { describe, expect, it } from 'vitest'
import type { EditorDocument, EditorOps, TimelineItem, Track } from '@shared/types'
import { applyTimelineDiff, diffTimelines, type TimelineState } from '@shared/timeline'
import { composeMotionPage, normaliseDefinition, type MotionKit, type MotionSpec } from '@shared/motion'
import { opsToDiff } from './ops'
import { opsWriteKits } from './kitOps'
import { vetHtmlOps, type MotionProbe } from './vetHtml'
import type { MotionProbeInput } from '../motion/probe'

const KIT: MotionKit = {
	id: 'nomad',
	css: '.card { background: #FFF7EC; color: #1D1A17 }',
	js: 'window.nomad = { fade: function (el, t) { el.style.opacity = String(Math.min(1, t)) } }'
}
const page = (word: string) =>
	`<div class="card" id="c">${word}</div><script>const c = document.getElementById("c")\n` +
	'frameflow.define({ duration: 4, moments: [{ name: "in", duration: 0.5 }, { name: "hold", duration: 3, flex: true }, { name: "out", duration: 0.5 }], settings: [], seek(t) { nomad.fade(c, t) } })</script>'

const track: Track = { id: 'm1', kind: 'video', name: 'M1', order: 1, muted: false, locked: false, hidden: false, height: 64 }
const layer = (id: string, word: string, kit?: string): TimelineItem => {
	const html = page(word)
	const definition = normaliseDefinition({ duration: 4 })
	const motion: MotionSpec = { html, definition, passed: { html, definition, verified: true }, ...(kit ? { kit } : {}) }
	return {
		id, trackId: 'm1', sourceAssetId: '', timelineStart: Number(id.slice(1)) * 5, in: 0, out: 4, speed: 1,
		preservePitch: true, duration: 4, label: word, motion
	}
}
const makeDoc = (timeline: TimelineItem[], kits: MotionKit[] = [KIT]): EditorDocument => ({
	schemaVersion: 2, media: [], tracks: [track], timeline, motionKits: kits,
	timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 },
	activePersonaId: 'p', turns: [], historyRef: { currentStepId: '', stepCount: 0 }
})
/** The document after a diff, as the editor applies it. */
const applied = (doc: EditorDocument, ops: EditorOps) => {
	const result = opsToDiff(ops, doc, { by: 'Claude Code' })
	const state: TimelineState = { tracks: [...doc.tracks], timeline: [...doc.timeline], motionKits: [...(doc.motionKits ?? [])] }
	applyTimelineDiff(state, result.diff)
	return { ...result, state }
}

describe('setMotionKits', () => {
	const series = Array.from({ length: 6 }, (_, i) => layer(`i${i}`, `word ${i}`, 'nomad'))
	const doc = makeDoc([...series, layer('i9', 'standalone')])

	it('restyles every layer that uses the kit in ONE diff that touches no layer', () => {
		const { diff, state, notes, droppedOps } = applied(doc, { setMotionKits: [{ id: 'nomad', css: '.card { background: #1D1A17; color: #FFF7EC }' }] })
		expect(droppedOps).toEqual([])
		expect(diff.setMotionKits).toHaveLength(1)
		expect(diff.updateItems).toBeUndefined()
		expect(diff.addItems).toBeUndefined()
		// Fields not sent keep their value: the js is still there.
		expect(state.motionKits![0]).toEqual({ id: 'nomad', css: '.card { background: #1D1A17; color: #FFF7EC }', js: KIT.js })
		expect(notes.join(' ')).toMatch(/Kit "nomad" updated: 6 layers use it/)

		// What each layer draws changed with it — and only for the layers that use it.
		const frame = { width: 1920, height: 1080 }
		for (const item of series) {
			expect(composeMotionPage(item.motion, frame, state.motionKits)).toContain('background: #1D1A17')
		}
		const loner = state.timeline.find((i) => i.id === 'i9')!
		expect(composeMotionPage(loner.motion, frame, state.motionKits)).toBe(composeMotionPage(loner.motion, frame, doc.motionKits))
	})

	it('is one undo step: the inverse puts the old kit back', () => {
		const { state } = applied(doc, { setMotionKits: [{ id: 'nomad', css: 'x{}' }] })
		const step = diffTimelines({ tracks: doc.tracks, timeline: doc.timeline, motionKits: doc.motionKits }, state)!
		const undone: TimelineState = { ...state, motionKits: [...state.motionKits!] }
		applyTimelineDiff(undone, step.inverse)
		expect(undone.motionKits).toEqual([KIT])
	})

	it('adds a kit and a layer that uses it in the same call', () => {
		const empty = makeDoc([], [])
		const { state, droppedOps } = applied(empty, {
			setMotionKits: [{ id: 'nomad', css: KIT.css, js: KIT.js }],
			addMotion: [{ template: 'custom', atSec: 1, html: page('hello'), kit: 'nomad' }]
		})
		expect(droppedOps).toEqual([])
		expect(state.motionKits!.map((k) => k.id)).toEqual(['nomad'])
		expect(state.timeline[0].motion?.kit).toBe('nomad')
		expect(state.timeline[0].duration).toBe(4)
	})

	it('drops a page that names a kit the project does not have, and says which exist', () => {
		const { diff, droppedOps } = applied(doc, { addMotion: [{ template: 'custom', atSec: 1, html: page('x'), kit: 'nope' }] })
		expect(diff.addItems).toBeUndefined()
		expect(droppedOps[0]).toMatch(/no kit "nope" \(kits: nomad\)/)
	})

	it('moves a layer onto a kit and off it again', () => {
		const on = applied(doc, { updateMotion: [{ id: 'i9', kit: 'nomad' }] })
		expect(on.state.timeline.find((i) => i.id === 'i9')!.motion?.kit).toBe('nomad')
		const off = applied(doc, { updateMotion: [{ id: 'i0', kit: '' }] })
		expect(off.state.timeline.find((i) => i.id === 'i0')!.motion?.kit).toBeUndefined()
	})

	it('keeps the kit when a page is rewritten without naming one', () => {
		const { state } = applied(doc, { updateMotion: [{ id: 'i1', html: page('rewritten') }] })
		const motion = state.timeline.find((i) => i.id === 'i1')!.motion!
		expect(motion.html).toContain('rewritten')
		expect(motion.kit).toBe('nomad')
	})

	it('ignores a kit on a template layer, and says so', () => {
		const { state, notes } = applied(makeDoc([]), { addMotion: [{ template: 'lower-third', atSec: 0, kit: 'nomad' }] })
		expect(state.timeline[0].motion).toEqual({ template: 'lower-third' })
		expect(notes.join(' ')).toMatch(/templates keep their own look/)
	})

	it('refuses a kit that breaks the page rules', () => {
		const { diff, droppedOps } = applied(doc, { setMotionKits: [{ id: 'nomad', js: 'setInterval(function () {}, 10)' }] })
		expect(diff.setMotionKits).toBeUndefined()
		expect(droppedOps[0]).toMatch(/setMotionKits\[0\] \("nomad"\) rejected.*js line 1/)
	})

	it('will not delete a kit that layers still use', () => {
		const used = applied(doc, { removeMotionKits: ['nomad'] })
		expect(used.diff.removeMotionKitIds).toBeUndefined()
		expect(used.droppedOps[0]).toMatch(/still used by "word 0", "word 1"/)
		// Once the last user is gone, it goes.
		const lone = makeDoc([layer('i1', 'only', 'nomad')])
		const freed = applied(lone, { removeItemIds: ['i1'], removeMotionKits: ['nomad'] })
		expect(freed.state.motionKits).toEqual([])
	})

	it('needs the HTML permission, like a page', () => {
		expect(opsWriteKits({ setMotionKits: [{ id: 'k', css: 'a{}' }] })).toBe(true)
		expect(opsWriteKits({ updateMotion: [{ id: 'x', kit: '' }] })).toBe(true)
		expect(opsWriteKits({ addMotion: [{ template: 'lower-third', atSec: 0 }] })).toBe(false)
	})
})

describe('vetting kits before they land', () => {
	const series = Array.from({ length: 9 }, (_, i) => layer(`i${i}`, `word ${i}`, 'nomad'))
	const doc = makeDoc(series)
	const recording = (fail?: (input: MotionProbeInput) => string | undefined) => {
		const calls: MotionProbeInput[] = []
		const probe: MotionProbe = async (input) => {
			calls.push(input)
			const error = fail?.(input)
			return error ? { determinism: 'fail', error } : { determinism: 'pass' }
		}
		return { calls, probe }
	}

	it('draws a changed kit with a few of its pages, not all of them', async () => {
		const { calls, probe } = recording()
		const ops: EditorOps = { setMotionKits: [{ id: 'nomad', css: 'x{}' }] }
		const vetted = await vetHtmlOps(ops, doc, probe)
		expect(vetted.dropped).toEqual([])
		expect(calls).toHaveLength(3)
		// First, middle and last of the series, each with the NEW kit.
		expect(calls.map((c) => /word \d/.exec(c.html)![0])).toEqual(['word 0', 'word 4', 'word 8'])
		for (const call of calls) expect(call.kit).toEqual({ id: 'nomad', css: 'x{}', js: KIT.js })
	})

	it('rejects a kit that makes its pages throw, and the kit stays as it was', async () => {
		const { probe } = recording((input) => (input.kit?.js?.includes('boom') ? 'nomad.fade is not a function' : undefined))
		const vetted = await vetHtmlOps({ setMotionKits: [{ id: 'nomad', js: 'window.boom = 1' }] }, doc, probe)
		expect(vetted.ops.setMotionKits).toBeUndefined()
		expect(vetted.dropped[0]).toMatch(/kit is unchanged: with this kit, layer "word 0" fails: the page throws when it runs: nomad\.fade/)
	})

	it('draws a page with the kit it will use: named in the op, set in the same call, or already its own', async () => {
		const { calls, probe } = recording()
		await vetHtmlOps({
			setMotionKits: [{ id: 'fresh', css: 'y{}' }],
			addMotion: [{ template: 'custom', atSec: 0, html: page('new'), kit: 'fresh' }],
			updateMotion: [{ id: 'i2', html: page('again') }, { id: 'i3', kit: 'fresh' }]
		}, doc, probe)
		const byWord = (w: string) => calls.find((c) => c.html.includes(w))!
		expect(byWord('new').kit?.id).toBe('fresh')
		expect(byWord('again').kit).toEqual(KIT)
		// Moved onto a kit with no new text: its current page is drawn with that kit.
		expect(byWord('word 3').kit?.id).toBe('fresh')
	})
})
