import { describe, expect, it } from 'vitest'
import type { TimelineItem, Track } from './types'
import {
	BLANK_MOTION_HTML, MOTION_CSP, MOTION_TEMPLATES, composeMotionPage, isMotionTrack, lintMotionHtml,
	colourKeyValue, keyedSettingValue, keyValueColour, settingKeyValue,
	lengthAfterPageChange, momentAt, motionAnimatablePaths, motionClipLabel, motionFramePlan, motionFrameState,
	motionRenderRecipe, newMotionSpec, normaliseDefinition, pageTime, resolveDefinition,
	resolveMoments, sameMotion, settingValues, type MotionSpec
} from './motion'
import { motionSections } from './motionTemplates'
import { extractMotionDefinition, writtenSpec } from './motionCode'
import { applyTimelineDiff, diffTimelines, findOrphanItems } from './timeline'
import { canHostItem, isCompositedItem, itemFamily } from './tracks'
import { hasKeyframes, isAnimatableOn } from './keyframes'

const motionItem = (spec: MotionSpec, duration = 4, extra: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'm1', trackId: 'tM', sourceAssetId: '',
	timelineStart: 3, in: 0, out: duration, speed: 1, preservePitch: true, duration,
	label: 'Lower third', motion: spec, ...extra
})

describe('the template library', () => {
	it('is the seven board-1 templates, in two sections', () => {
		expect(MOTION_TEMPLATES.map((t) => t.label)).toEqual([
			'Lower third', 'Title card', 'Chapter card', 'Pull quote',
			'Stat counter', 'Callout ring', 'Bar reveal'
		])
		expect(motionSections().map((s) => s.section)).toEqual(['Text', 'Data and callouts'])
		expect(new Set(MOTION_TEMPLATES.map((t) => t.id)).size).toBe(MOTION_TEMPLATES.length)
	})

	it('shows the durations the design draws on each tile', () => {
		const durations = Object.fromEntries(MOTION_TEMPLATES.map((t) => [t.id, t.definition.duration]))
		expect(durations).toEqual({
			'lower-third': 4, 'title-card': 3, 'chapter-card': 2, 'pull-quote': 5,
			'stat-counter': 4, 'callout-ring': 2.5, 'bar-reveal': 3.5
		})
	})

	for (const template of MOTION_TEMPLATES) {
		describe(template.id, () => {
			it('lints clean — a pure function of t, no network', () => {
				expect(lintMotionHtml(template.html).issues).toEqual([])
			})

			it('has moments that partition its duration, one of them flexible', () => {
				const { moments, duration } = template.definition
				expect(moments.reduce((sum, m) => sum + m.duration, 0)).toBeCloseTo(duration, 9)
				expect(moments.filter((m) => m.flex)).toHaveLength(1)
				// Already normal, so the catalogue and the page agree on every window.
				expect(normaliseDefinition(template.definition).moments.map((m) => m.duration))
					.toEqual(moments.map((m) => m.duration))
			})

			it('has defaults that survive their own sanitising', () => {
				const values = settingValues({ template: template.id })
				for (const s of template.definition.settings) {
					expect(values[s.key]).toEqual(typeof s.default === 'string' && s.type === 'color'
						? s.default.toUpperCase()
						: s.default)
				}
			})

			it('never marks text as animatable — a string has no keyframe lane', () => {
				for (const s of template.definition.settings) {
					if (s.animate) expect(s.type).not.toBe('text')
				}
			})
		})
	}
})

describe('normaliseDefinition', () => {
	it('gives a page with no moments one flexible window over everything', () => {
		const def = normaliseDefinition({ duration: 2 })
		expect(def.moments).toEqual([{ name: 'all', duration: 2, flex: true }])
	})

	it('lets the flexible window take up whatever the others leave', () => {
		const def = normaliseDefinition({
			duration: 5,
			moments: [{ name: 'in', duration: 1 }, { name: 'hold', duration: 9 }, { name: 'out', duration: 1 }]
		})
		expect(def.moments.map((m) => [m.name, m.duration, m.flex])).toEqual([
			['in', 1, false], ['hold', 3, true], ['out', 1, false]
		])
	})

	it('shrinks fixed windows that overrun the page instead of overrunning it', () => {
		const def = normaliseDefinition({
			duration: 1,
			moments: [{ name: 'in', duration: 1 }, { name: 'hold', duration: 0, flex: true }, { name: 'out', duration: 1 }]
		})
		expect(def.moments.map((m) => m.duration)).toEqual([0.5, 0, 0.5])
	})

	it('falls back to a sane duration and drops settings it cannot type', () => {
		const def = normaliseDefinition({
			duration: -1,
			settings: [{ key: 'ok', label: 'Ok', type: 'number', default: 1 }, { key: 'bad', type: 'banana' } as any]
		})
		expect(def.duration).toBe(3)
		expect(def.settings.map((s) => s.key)).toEqual(['ok'])
	})
})

describe('moments: clip time onto page time', () => {
	const spec: MotionSpec = { template: 'lower-third' } // in 0.4, hold 3.2 (flex), out 0.4

	it('maps one to one when the clip is the page’s own length', () => {
		for (const u of [0, 0.2, 0.4, 1, 3.6, 3.8, 4]) expect(pageTime(spec, 4, u)).toBeCloseTo(u, 9)
	})

	it('puts a longer clip’s extra length into the hold, leaving the entrance alone', () => {
		const moments = resolveMoments(spec, 6)
		const r = (n: number) => Math.round(n * 1e9) / 1e9
		expect(moments.map((m) => [m.name, r(m.start), r(m.duration)])).toEqual([
			['in', 0, 0.4], ['hold', 0.4, 5.2], ['out', 5.6, 0.4]
		])
		expect(pageTime(spec, 6, 0.2)).toBeCloseTo(0.2, 9)          // entrance at full speed
		expect(pageTime(spec, 6, 5.8)).toBeCloseTo(3.8, 9)          // exit at full speed
		expect(pageTime(spec, 6, 3)).toBeCloseTo(0.4 + (2.6 / 5.2) * 3.2, 9) // hold stretched
	})

	it('rescales a retimed window: a 0.8s entrance plays the page’s 0.4s at half speed', () => {
		const slow: MotionSpec = { ...spec, moments: { in: 0.8 } }
		expect(resolveMoments(slow, 4).map((m) => m.duration)).toEqual([0.8, 2.8, 0.4])
		expect(pageTime(slow, 4, 0.4)).toBeCloseTo(0.2, 9)
		expect(pageTime(slow, 4, 0.8)).toBeCloseTo(0.4, 9)
	})

	it('squeezes the fixed windows proportionally when the clip is shorter than them', () => {
		const moments = resolveMoments(spec, 0.4)
		expect(moments.map((m) => m.duration)).toEqual([0.2, 0, 0.2])
		expect(pageTime(spec, 0.4, 0.1)).toBeCloseTo(0.2, 9)
	})

	it('holds the first and last frame outside the clip', () => {
		expect(pageTime(spec, 4, -1)).toBe(0)
		expect(pageTime(spec, 4, 99)).toBe(4)
	})

	it('names the window under the playhead and how far through it is', () => {
		expect(momentAt(spec, 4, 0.248)).toEqual({ name: 'in', progress: expect.closeTo(0.62, 6) })
		expect(momentAt(spec, 4, 2)?.name).toBe('hold')
		expect(momentAt(spec, 4, 3.9)?.name).toBe('out')
		expect(momentAt(spec, 4, 4)).toBeNull()
	})
})

describe('settings', () => {
	it('clamps numbers, validates colours and enums, keeps text', () => {
		const values = settingValues({
			template: 'lower-third',
			settings: { slide: 500, accent: 'red', style: 'neon', name: 'Navid' }
		})
		expect(values).toEqual({
			name: 'Navid', role: 'Founder, BytePets', accent: '#EC4899', style: 'bar', slide: 60
		})
	})

	it('reads a numeric setting written as a string, the way an agent may send it', () => {
		expect(settingValues({ template: 'stat-counter', settings: { value: '12.5' } }).value).toBe(12.5)
	})
})

describe('motionFrameState — the one evaluator', () => {
	it('interpolates an animated setting and the opacity from keyframes', () => {
		const item = motionItem({ template: 'lower-third' }, 4, {
			keyframes: {
				'motion.slide': [{ t: 0, value: 0 }, { t: 2, value: 40 }],
				opacity: [{ t: 1, value: 1 }, { t: 3, value: 0 }]
			}
		})
		const state = motionFrameState(item, 1)
		expect(state.settings.slide).toBe(20)
		expect(state.opacity).toBe(1)
		expect(motionFrameState(item, 2).opacity).toBe(0.5)
		expect(motionFrameState(item, 3).opacity).toBe(0)
	})

	it('ignores keys on a setting the page did not mark animatable', () => {
		const item = motionItem({ template: 'lower-third' }, 4, {
			keyframes: { 'motion.name': [{ t: 0, value: 1 }, { t: 1, value: 2 }] }
		})
		expect(motionFrameState(item, 0.5).settings.name).toBe('Sara Ahmadi')
	})

	it('clamps a keyed setting to its range, as the slider would', () => {
		const item = motionItem({ template: 'lower-third' }, 4, {
			keyframes: { 'motion.slide': [{ t: 0, value: -50 }, { t: 1, value: 999 }] }
		})
		expect(motionFrameState(item, 0).settings.slide).toBe(0)
		expect(motionFrameState(item, 1).settings.slide).toBe(60)
	})

	it('is exactly what the export captures at every frame — monitor and export agree', () => {
		const item = motionItem({ template: 'callout-ring', moments: { in: 1 } }, 3.3, {
			keyframes: {
				'motion.x': [{ t: 0, value: 0.2 }, { t: 2, value: 0.8, ease: 'ease' }],
				opacity: [{ t: 0, value: 0.5 }, { t: 3, value: 1 }]
			}
		})
		const fps = 30
		const plan = motionFramePlan(item, fps)
		expect(plan).toHaveLength(99)
		// What the monitor would draw with the playhead sitting on each frame.
		plan.forEach((frame, k) => {
			const playhead = item.timelineStart + k / fps
			expect(motionFrameState(item, playhead - item.timelineStart)).toEqual(frame)
		})
	})
})

describe('keyframe paths', () => {
	it('offers opacity and the animatable settings on a motion item only', () => {
		const paths = motionAnimatablePaths(motionItem({ template: 'callout-ring' }))
		expect(paths).toEqual(['opacity', 'motion.x', 'motion.y', 'motion.size', 'motion.accent'])
		expect(isAnimatableOn('motion.x', paths)).toBe(true)
		expect(isAnimatableOn('motion.label', paths)).toBe(false)
		expect(isAnimatableOn('opacity', [])).toBe(false)
		expect(isAnimatableOn('transform.x', [])).toBe(true)
	})

	it('keys a colour as its 0xRRGGBB number and hands the page the hex', () => {
		expect(colourKeyValue('#EC4899')).toBe(0xec4899)
		expect(keyValueColour(0x8b5cf6)).toBe('#8B5CF6')
		expect(keyValueColour(colourKeyValue('#00FF7F'))).toBe('#00FF7F')
	})

	it('holds a keyed colour — there is no halfway between two colours', () => {
		const item = motionItem({ template: 'lower-third' }, 4, {
			keyframes: {
				// Even a key asking to ease is held: the evaluator decides, not the key.
				'motion.accent': [{ t: 0, value: 0xec4899, ease: 'ease' }, { t: 2, value: 0x8b5cf6 }]
			}
		})
		expect(motionFrameState(item, 0).settings.accent).toBe('#EC4899')
		expect(motionFrameState(item, 1.99).settings.accent).toBe('#EC4899')
		expect(motionFrameState(item, 2).settings.accent).toBe('#8B5CF6')
		expect(motionFrameState(item, 3.5).settings.accent).toBe('#8B5CF6')
	})

	it('reads an enum key as its option index, held', () => {
		const style = { key: 'style', label: 'Style', type: 'enum' as const, default: 'bar',
			options: [{ value: 'bar', label: 'Bar' }, { value: 'pill', label: 'Pill' }], animate: true }
		expect(settingKeyValue(style, 'pill')).toBe(1)
		expect(keyedSettingValue(style, 1)).toBe('pill')
		expect(keyedSettingValue(style, 7)).toBe('pill') // clamped to the options
	})

	it('counts a keyed opacity as animation', () => {
		expect(hasKeyframes({ opacity: [{ t: 0, value: 0 }, { t: 1, value: 1 }] })).toBe(true)
	})
})

describe('composeMotionPage', () => {
	const page = composeMotionPage({ template: 'lower-third' }, { width: 1920, height: 1080 })

	it('bans the network in the page itself', () => {
		expect(page).toContain(`<meta http-equiv="Content-Security-Policy" content="${MOTION_CSP}">`)
		expect(MOTION_CSP).toMatch(/^default-src 'none'/)
	})

	it('pins the viewport to the sequence frame and inlines the fonts', () => {
		expect(page).toContain('width:1920px;height:1080px')
		expect(page).toContain("font-family:'Inter';src:url(data:font/woff2;base64,")
		expect(page).not.toMatch(/https?:\/\/fonts\./)
	})

	it('runs the runtime before the page’s own script', () => {
		expect(page.indexOf('window.frameflow = ff')).toBeLessThan(page.indexOf('frameflow.define({'))
		expect(page.indexOf('window.frameflow = ff')).toBeGreaterThan(0)
	})

	it('hands the page the catalogue definition', () => {
		expect(page).toContain('"name":"in","duration":0.4')
	})

	it('injects into a page that brings its own <head>', () => {
		const own = composeMotionPage(
			{ html: '<!doctype html><html><head><title>x</title></head><body><script>frameflow.define({seek(){}})</script></body></html>' },
			{ width: 100, height: 100 }
		)
		expect(own.indexOf('<head>')).toBeLessThan(own.indexOf('window.frameflow = ff'))
		expect(own.indexOf('window.frameflow = ff')).toBeLessThan(own.indexOf('<title>x</title>'))
	})

	it('cannot be broken out of by a definition containing </script>', () => {
		const sneaky = composeMotionPage(
			{ html: BLANK_MOTION_HTML, definition: { duration: 1, moments: [], settings: [{ key: 'a', label: '</script><script>alert(1)</script>', type: 'text', default: '' }] } },
			{ width: 100, height: 100 }
		)
		const runtime = sneaky.slice(sneaky.indexOf('<script>'), sneaky.indexOf('window.frameflow = ff'))
		expect(runtime).not.toContain('</script>')
	})

	it('lays a blank custom layer out the same way', () => {
		expect(composeMotionPage(newMotionSpec(), { width: 640, height: 360 })).toContain('Custom motion')
	})
})

describe('lintMotionHtml', () => {
	const rules = (html: string) => lintMotionHtml(`${html}\n<script>frameflow.define({seek(){}})</script>`).issues.map((i) => i.rule)

	it('rejects CSS animations and transitions', () => {
		expect(rules('<style>@keyframes spin { to { transform: rotate(1turn) } }</style>')).toContain('css-animation')
		expect(rules('<style>.a { animation: spin 1s infinite }</style>')).toContain('css-animation')
		expect(rules('<div style="transition: opacity 1s"></div>')).toContain('css-animation')
		expect(rules('<script>el.animate([{opacity:0}], 300)</script>')).toContain('css-animation')
	})

	it('rejects timers, clocks, randomness and animation frames', () => {
		expect(rules('<script>setTimeout(f, 10)</script>')).toEqual(['timer'])
		expect(rules('<script>setInterval(f, 10)</script>')).toEqual(['timer'])
		expect(rules('<script>const t = Date.now()</script>')).toEqual(['clock'])
		expect(rules('<script>const t = performance.now()</script>')).toEqual(['clock'])
		expect(rules('<script>const r = Math.random()</script>')).toEqual(['random'])
		expect(rules('<script>requestAnimationFrame(draw)</script>')).toEqual(['animation-frame'])
	})

	it('rejects the network and remote files', () => {
		expect(rules('<script>fetch("/api")</script>')).toEqual(['network'])
		expect(rules('<script>new WebSocket("ws://x")</script>')).toEqual(['network'])
		expect(rules('<img src="https://example.com/a.png">')).toEqual(['remote-url'])
		expect(rules('<link rel="stylesheet" href="//cdn.example.com/a.css">')).toEqual(['remote-url'])
		expect(rules('<style>@import url(x.css)</style>')).toContain('remote-url')
		expect(rules('<style>.a { background: url(https://x.test/b.png) }</style>')).toEqual(['remote-url'])
	})

	it('accepts data: URLs and properties that merely contain the words', () => {
		expect(rules('<img src="data:image/png;base64,AAAA">')).toEqual([])
		expect(rules('<script>el.style.transform = "x"; const transitions = 3</script>')).toEqual([])
	})

	it('ignores comments, so a note about a rule is not a breach of it', () => {
		expect(rules('<!-- never setTimeout() here --><script>// Date.now() is banned\n/* Math.random() */</script>')).toEqual([])
	})

	it('reports where, so the author can find it', () => {
		const result = lintMotionHtml('<div></div>\n<script>\nsetTimeout(f)\n</script>')
		const timer = result.issues.find((i) => i.rule === 'timer')!
		expect(timer.line).toBe(3)
		expect(timer.excerpt).toBe('setTimeout(f)')
	})

	it('requires the page to define itself', () => {
		const result = lintMotionHtml('<div>static</div>')
		expect(result.ok).toBe(false)
		expect(result.issues.map((i) => i.rule)).toEqual(['no-define'])
	})
})

describe('the rendering recipe (export cache key)', () => {
	const frame = { width: 1920, height: 1080, fps: 30 }
	const base = motionItem({ template: 'lower-third' })

	it('is stable for the same clip', () => {
		expect(motionRenderRecipe(base, frame)).toBe(motionRenderRecipe({ ...base }, frame))
	})

	it('changes with anything that changes a pixel', () => {
		const recipe = motionRenderRecipe(base, frame)
		const variants: TimelineItem[] = [
			{ ...base, motion: { template: 'lower-third', settings: { name: 'Navid' } } },
			{ ...base, motion: { template: 'lower-third', moments: { in: 1 } } },
			{ ...base, keyframes: { opacity: [{ t: 0, value: 0 }, { t: 1, value: 1 }] } },
			{ ...base, duration: 5, out: 5 }
		]
		for (const v of variants) expect(motionRenderRecipe(v, frame)).not.toBe(recipe)
		expect(motionRenderRecipe(base, { ...frame, fps: 25 })).not.toBe(recipe)
		expect(motionRenderRecipe(base, { ...frame, width: 1080, height: 1920 })).not.toBe(recipe)
	})

	it('ignores what does not reach the page: where the clip sits, its label', () => {
		const recipe = motionRenderRecipe(base, frame)
		const moved: TimelineItem = { ...base, timelineStart: 99, label: 'Other' }
		expect(motionRenderRecipe(moved, frame)).toBe(recipe)
	})
})

describe('the document model', () => {
	const tracks: Track[] = [
		{ id: 'tV', kind: 'video', name: 'V1', order: 0, muted: false, locked: false, hidden: false, height: 64 },
		{ id: 'tM', kind: 'video', name: 'M1', order: 1, muted: false, locked: false, hidden: false, height: 64 },
		{ id: 'tA', kind: 'audio', name: 'A1', order: 0, muted: false, locked: false, hidden: false, height: 48 }
	]

	it('is a picture layer on a video track, with no media behind it', () => {
		const item = motionItem({ template: 'lower-third' })
		expect(itemFamily(item)).toBe('video')
		expect(isCompositedItem(item)).toBe(true)
		expect(canHostItem(tracks[2], item).ok).toBe(false)
		expect(isMotionTrack(tracks[1])).toBe(true)
		expect(isMotionTrack(tracks[0])).toBe(false)
	})

	it('is not an orphan, so autosave does not prune it', () => {
		expect(findOrphanItems([motionItem({ template: 'lower-third' })], new Set())).toEqual([])
	})

	it('can be added through a diff that is checked against the project’s media', () => {
		const state = { tracks: [...tracks], timeline: [] as TimelineItem[] }
		const result = applyTimelineDiff(state, { schemaVersion: 1, addItems: [motionItem({ template: 'lower-third' })] }, [])
		expect(result.errors).toEqual([])
		expect(state.timeline).toHaveLength(1)
	})

	it('records a settings edit in undo and revisions, and undoes it exactly', () => {
		const before = { tracks, timeline: [motionItem({ template: 'lower-third' })] }
		const after = { tracks, timeline: [motionItem({ template: 'lower-third', settings: { name: 'Navid' } })] }
		const diff = diffTimelines(before, after)
		expect(diff?.forward.updateItems).toEqual([{ id: 'm1', motion: { template: 'lower-third', settings: { name: 'Navid' } } }])
		expect(diff?.inverse.updateItems).toEqual([{ id: 'm1', motion: { template: 'lower-third' } }])
	})

	it('compares by value, not by reference', () => {
		expect(sameMotion({ template: 'a', settings: { x: 1, y: 2 } }, { settings: { y: 2, x: 1 }, template: 'a' })).toBe(true)
		expect(sameMotion({ template: 'a' }, { template: 'a', settings: { x: 1 } })).toBe(false)
		expect(diffTimelines(
			{ tracks, timeline: [motionItem({ template: 'lower-third' })] },
			{ tracks, timeline: [motionItem({ template: 'lower-third' })] }
		)).toBeNull()
	})
})

describe('labels', () => {
	it('captions a clip by its template and its first line of text', () => {
		expect(motionClipLabel(motionItem({ template: 'lower-third' }))).toBe('Lower third · Sara Ahmadi')
		expect(motionClipLabel(motionItem({ template: 'stat-counter' }, 4, { label: 'Stat' }))).toBe('Stat · faster triage')
	})

	it('falls back to the blank custom definition', () => {
		expect(resolveDefinition(newMotionSpec()).duration).toBe(3)
		expect(motionClipLabel(motionItem(newMotionSpec(), 3, { label: '' }))).toBe('Custom HTML')
	})
})

describe('lengthAfterPageChange', () => {
	const page = (duration: number) => ({
		html: `<script>frameflow.define({ duration: ${duration}, settings: [], moments: [{ name: "all", duration: ${duration}, flex: true }], seek() {} })</script>`,
		definition: { duration, settings: [], moments: [{ name: 'all', duration, flex: true }] }
	})
	const spec = (duration: number, extra: Partial<MotionSpec> = {}): MotionSpec => {
		const p = page(duration)
		return { ...p, passed: { html: p.html, definition: p.definition }, ...extra }
	}

	it('follows the page when the clip sat at the old page’s length', () => {
		expect(lengthAfterPageChange(spec(3), spec(8), 3)).toBe(8)
		expect(lengthAfterPageChange(spec(8), spec(5), 8)).toBe(5)
	})

	it('treats a fresh blank layer as sitting at its natural 3 s', () => {
		expect(lengthAfterPageChange(newMotionSpec(), spec(8), 3)).toBe(8)
	})

	it('leaves a trimmed or lengthened clip, and a retimed one, alone', () => {
		expect(lengthAfterPageChange(spec(3), spec(8), 2)).toBe(2)
		expect(lengthAfterPageChange(spec(3), spec(8), 12)).toBe(12)
		expect(lengthAfterPageChange(spec(3, { moments: { all: 1 } }), spec(8), 3)).toBe(3)
	})

	it('does not move while the new page is failing: the drawn page is still the old one', () => {
		const failing: MotionSpec = { ...spec(3), html: spec(8).html }
		expect(lengthAfterPageChange(spec(3), failing, 3)).toBe(3)
	})
})

describe('reading a page’s definition when define() uses expressions (gap 4)', () => {
	const page = (duration: string) =>
		`<div id="n"></div><script>var SPEC = { duration: 9 };\nframeflow.define({ duration: ${duration}, moments: [{ name: "in", duration: 1 }, { name: "hold", duration: 7, flex: true }, { name: "out", duration: 1 }], seek(t) { n.textContent = String(t) } })</script>`
	const runtime = normaliseDefinition({ duration: 9, settings: [], moments: [{ name: 'in', duration: 1 }, { name: 'hold', duration: 7, flex: true }, { name: 'out', duration: 1 }] })
	const writer = { by: 'Claude Code' }

	it('knows an expression is not read: the text alone says 3 s and "incomplete"', () => {
		const read = extractMotionDefinition(page('SPEC.duration'))
		expect(read.complete).toBe(false)
		expect(read.definition!.duration).toBe(3)
		expect(read.problems.join(' ')).toMatch(/duration is not a literal/)
		expect(extractMotionDefinition(page('9')).complete).toBe(true)
	})

	it('lets what the page reported at run time win over the text', () => {
		expect(resolveDefinition(writtenSpec(newMotionSpec(), page('SPEC.duration'), writer, runtime)).duration).toBe(9)
		expect(resolveDefinition(writtenSpec(newMotionSpec(), page('SPEC.duration'), writer)).duration).toBe(3)
	})

	it('follows the run-time length, and only that, when a 9 s layer gets the page again', () => {
		const before = writtenSpec(newMotionSpec(), page('9'), writer)
		const after = writtenSpec(before, page('SPEC.duration'), writer, runtime)
		expect(lengthAfterPageChange(before, after, 9)).toBe(9)
		// The misread one would have cut it to 3 — which is why the ops path does
		// not follow a definition it could not read (see ops.test.ts).
		expect(lengthAfterPageChange(before, writtenSpec(before, page('SPEC.duration'), writer), 9)).toBe(3)
	})
})
