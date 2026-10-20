import { describe, expect, it } from 'vitest'
import {
	BLANK_MOTION_HTML, EMPTY_MOTION_HTML, MOTION_TEMPLATES, composeMotionPage, motionFrameState, motionRenderRecipe,
	motionSource, newMotionSpec, renderVersion, resolveDefinition, sameMotion, type MotionSpec
} from './motion'
import {
	buildChecks, bundledFontsUsed, failedSpec, unverifiedPage, verifiedSpec, coerceDefinition, describePrompt, editedSpec, exposedSettings, extractMotionDefinition,
	fixPrompt, htmlHash, humaniseKey, lastPassingOf, motionBadge, motionStatus, parseDefineCall, projectCustomLayers,
	provenanceLabel, saveAsTemplateBlocker, templateId, writtenSpec
} from './motionCode'
import { setUserMotionTemplates } from './motionTemplates'

/** Board 5's page, line for line (line 14 reads the clock). */
const BOARD_PAGE = [
	'<div id="stat"><b id="n"></b><i id="label"></i></div>',
	'<script>',
	'frameflow.define({',
	'  duration: 4,',
	'  settings: {',
	"    value:  { type: 'number', default: 3, animate: true },",
	"    label:  { type: 'text',   default: 'faster triage' },",
	"    accent: { type: 'color',  default: '#EC4899', animate: true }",
	'  },',
	'  moments: { in: [0, 0.6], out: [3.5, 4] },',
	'  seek(t, s) {',
	'    const k = ease(clamp(t / 0.6))',
	"    n.textContent = Math.round(s.value * k) + '×'",
	'    label.style.opacity = Date.now() % 2 ? 1 : 0.9',
	'  }',
	'})',
	'</script>'
].join('\n')

const GOOD_PAGE = BOARD_PAGE.replace('label.style.opacity = Date.now() % 2 ? 1 : 0.9', 'label.style.opacity = "1"')

describe('reading frameflow.define out of the text', () => {
	it('reads board 5’s page: settings as a map, moments as ranges, a method for seek', () => {
		const { found, definition, complete } = extractMotionDefinition(BOARD_PAGE)
		expect(found).toBe(true)
		expect(complete).toBe(true)
		expect(definition!.duration).toBe(4)
		expect(definition!.settings.map((s) => [s.key, s.type, s.default, !!s.animate])).toEqual([
			['value', 'number', 3, true],
			['label', 'text', 'faster triage', false],
			['accent', 'color', '#EC4899', true]
		])
		// [0,0.6] in, [3.5,4] out, and the time between them is the flexible hold.
		expect(definition!.moments.map((m) => [m.name, +m.duration.toFixed(3), !!m.flex])).toEqual([
			['in', 0.6, false], ['hold', 2.9, true], ['out', 0.5, false]
		])
	})

	it('reads the array form the blank layer uses', () => {
		const { definition } = extractMotionDefinition(BLANK_MOTION_HTML)
		expect(definition!.duration).toBe(3)
		expect(definition!.moments.map((m) => m.name)).toEqual(['in', 'hold', 'out'])
		expect(definition!.settings).toEqual([])
	})

	it('reads an array of {key, type, default}, enums with options and units', () => {
		const html = `<script>frameflow.define({
			duration: 2.5,
			settings: [
				{ key: 'name', type: 'text', default: 'Sara', multiline: true },
				{ key: 'size', label: 'Size', type: 'number', default: 12, min: 0, max: 40, step: 1, unit: 'px', animate: true },
				{ key: 'style', type: 'enum', options: ['bar', { value: 'pill', label: 'Pill' }], default: 'pill' }
			],
			moments: [{ name: 'in', duration: 0.5 }, { name: 'hold', duration: 1.5, flex: true }, { name: 'out', duration: 0.5 }],
			seek: function (t, s) {}
		})</script>`
		const { definition } = extractMotionDefinition(html)
		const [name, size, style] = definition!.settings
		expect(name).toMatchObject({ key: 'name', label: 'Name', type: 'text', multiline: true })
		expect(size).toMatchObject({ type: 'number', min: 0, max: 40, step: 1, unit: 'px', animate: true })
		expect(style.options).toEqual([{ value: 'bar', label: 'bar' }, { value: 'pill', label: 'Pill' }])
		expect(style.default).toBe('pill')
	})

	it('says which parts it could not evaluate instead of guessing', () => {
		const html = `<script>const DUR = 4
		frameflow.define({ duration: DUR, settings: [{ key: 'a', type: 'number', default: 1 }], seek(t) {} })</script>`
		const result = extractMotionDefinition(html)
		expect(result.found).toBe(true)
		expect(result.complete).toBe(false)
		expect(result.problems.join(' ')).toMatch(/duration is not a literal/)
		// What it could read still comes through.
		expect(result.definition!.settings.map((s) => s.key)).toEqual(['a'])
	})

	it('survives strings holding commas and braces, and a seek full of both', () => {
		const html = `<script>frameflow.define({
			duration: 3,
			settings: [{ key: 'greeting', type: 'text', default: 'Hi, {there}, "friend"' }],
			seek(t, s) { const o = { a: [1, 2, 3], b: "}" }; if (t > 1) { return } }
		})</script>`
		expect(extractMotionDefinition(html).definition!.settings[0].default).toBe('Hi, {there}, "friend"')
	})

	it('ignores a define call that sits in a comment', () => {
		expect(parseDefineCall('<!-- frameflow.define({ duration: 9 }) -->')).toBeNull()
		expect(extractMotionDefinition('<script>// frameflow.define({ duration: 9 })\n</script>').found).toBe(false)
	})

	it('finds nothing when there is no define, or it does not take an object', () => {
		expect(extractMotionDefinition('<div></div>').found).toBe(false)
		expect(extractMotionDefinition('<script>frameflow.define(config)</script>').found).toBe(false)
	})

	it('repairs a loose definition the way normaliseDefinition does', () => {
		const { definition, problems } = coerceDefinition({
			duration: -1,
			settings: [{ key: 'x', type: 'banana' }, { key: 'y', type: 'colour', default: '#abc' }, { key: 'y', type: 'text' }],
			moments: { in: 0.5, out: 0.5 }
		})
		expect(definition.duration).toBe(3)
		expect(problems.join(' ')).toMatch(/duration/)
		expect(problems.join(' ')).toMatch(/banana/)
		expect(problems.join(' ')).toMatch(/defined twice/)
		expect(definition.settings.map((s) => s.key)).toEqual(['y'])
		// A bad colour falls back, as the inspector's own field does.
		expect(definition.settings[0].default).toBe('#FFFFFF')
		expect(definition.moments.reduce((sum, m) => sum + m.duration, 0)).toBeCloseTo(3, 9)
	})

	it('lists the settings the way the design does, with ◆ for the keyable ones', () => {
		const rows = exposedSettings(extractMotionDefinition(BOARD_PAGE).definition!)
		expect(rows).toEqual([
			{ key: 'value', animate: true, detail: 'number · 3' },
			{ key: 'label', animate: false, detail: 'text' },
			{ key: 'accent', animate: true, detail: 'colour · #EC4899' }
		])
	})

	it('humanises keys', () => {
		expect(humaniseKey('accentColour')).toBe('Accent colour')
		expect(humaniseKey('lower_third')).toBe('Lower third')
	})
})

describe('checks', () => {
	it('passes a clean page', () => {
		const checks = buildChecks(GOOD_PAGE, { determinism: 'pass' })
		expect(checks.passing).toBe(true)
		expect(checks.rows.map((r) => r.status)).toEqual(['pass', 'pass', 'pass'])
		expect(checks.issues).toEqual([])
		expect(checks.failingLines).toEqual([])
	})

	it('reports board 5’s clock read on line 14, with the board’s words', () => {
		const checks = buildChecks(BOARD_PAGE, { determinism: 'pass' })
		expect(checks.passing).toBe(false)
		// The three fixed rows still pass: a clock read is its own issue.
		expect(checks.rows.map((r) => r.status)).toEqual(['pass', 'pass', 'pass'])
		expect(checks.issues).toHaveLength(1)
		expect(checks.issues[0]).toMatchObject({
			title: 'Line 14 reads the clock',
			detail: 'The export would flicker differently from the preview. Draw only from `t`.',
			line: 14
		})
		expect(checks.failingLines).toEqual([14])
	})

	it('fails the timing row for timers and CSS animation, the network row for remote files', () => {
		const timing = buildChecks('<style>#a{transition: opacity 1s}</style><script>setTimeout(f,1);frameflow.define({})</script>')
		expect(timing.rows.find((r) => r.id === 'timing')!.status).toBe('fail')
		expect(timing.rows.find((r) => r.id === 'network')!.status).toBe('pass')
		const network = buildChecks('<img src="https://x.test/a.png"><script>frameflow.define({})</script>')
		expect(network.rows.find((r) => r.id === 'network')!.status).toBe('fail')
		expect(network.issues[0].title).toBe('Line 1 loads a remote file')
	})

	it('names the bundled fonts the page uses, as the design does', () => {
		expect(bundledFontsUsed('<div style="font: 900 18px Outfit, sans-serif">')).toEqual(['Outfit'])
		expect(bundledFontsUsed('<style>b{font-family:"Inter"} i{font-family:Outfit}</style>')).toEqual(['Inter', 'Outfit'])
		expect(bundledFontsUsed('<div style="color:red">')).toEqual([])
		expect(buildChecks('<div style="font-family:Outfit"><script>frameflow.define({})</script>').rows[1].label)
			.toBe('No network; fonts bundled (Outfit)')
		expect(buildChecks('<script>frameflow.define({})</script>').rows[1].label).toBe('No network; fonts bundled')
	})

	it('waits for the determinism probe before it will pass', () => {
		const checks = buildChecks(GOOD_PAGE, { determinism: 'pending' })
		expect(checks.settled).toBe(false)
		expect(checks.passing).toBe(false)
		expect(checks.rows[2].status).toBe('pending')
	})

	it('fails on two renders of one frame that differ, and says where', () => {
		const checks = buildChecks(GOOD_PAGE, { determinism: 'fail', differsAt: 1.5 })
		expect(checks.passing).toBe(false)
		expect(checks.rows[2].status).toBe('fail')
		expect(checks.issues[0].detail).toMatch(/t = 1\.50s/)
		expect(checks.failingLines).toEqual([])
	})

	it('fails on a page that threw', () => {
		const checks = buildChecks(GOOD_PAGE, { determinism: 'pass', error: 'ease is not defined' })
		expect(checks.passing).toBe(false)
		expect(checks.rows[2].status).toBe('fail')
		expect(checks.issues[0]).toMatchObject({ title: 'The page threw an error', detail: 'ease is not defined' })
	})

	it('does not block on a probe that could not run', () => {
		expect(buildChecks(GOOD_PAGE, { determinism: 'skipped' }).passing).toBe(true)
	})

	it('wants a define call', () => {
		const checks = buildChecks('<div>hi</div>', { determinism: 'pass' })
		expect(checks.passing).toBe(false)
		expect(checks.issues[0].title).toBe('The page never calls frameflow.define')
	})

	it('lists every failing line, once each, in order', () => {
		const checks = buildChecks('<script>\nDate.now()\nsetTimeout(f)\nMath.random() + Date.now()\nframeflow.define({})</script>')
		expect(checks.failingLines).toEqual([2, 3, 4])
	})
})

describe('a custom layer draws its last passing version', () => {
	const passingSpec = (): MotionSpec => {
		const definition = extractMotionDefinition(GOOD_PAGE).definition!
		return { html: GOOD_PAGE, definition, passed: { html: GOOD_PAGE, definition }, author: { by: 'Claude Code', turnId: 't8' } }
	}

	it('draws the working text while it passes', () => {
		const spec = passingSpec()
		expect(renderVersion(spec).source).toBe('page')
		expect(motionStatus(spec)).toEqual({ state: 'ok' })
		expect(motionBadge(spec)).toBeNull()
	})

	it('keeps drawing the old version when an edit fails, and says so', () => {
		const spec = editedSpec(passingSpec(), BOARD_PAGE, { passed: false })
		expect(spec.html).toBe(BOARD_PAGE)
		expect(spec.passed!.html).toBe(GOOD_PAGE)
		expect(motionSource(spec)).toBe(GOOD_PAGE)
		expect(motionStatus(spec)).toEqual({ state: 'last-passing' })
		expect(motionBadge(spec)).toBe('Showing last version that passed')
	})

	it('moves to the new version the moment an edit passes', () => {
		const next = GOOD_PAGE.replace('duration: 4', 'duration: 6')
		const spec = editedSpec(editedSpec(passingSpec(), BOARD_PAGE, { passed: false }), next, { passed: true })
		expect(spec.passed!.html).toBe(next)
		expect(resolveDefinition(spec).duration).toBe(6)
		expect(motionStatus(spec)).toEqual({ state: 'ok' })
	})

	it('composes the passing version for the monitor and for the export alike', () => {
		const failing = editedSpec(passingSpec(), BOARD_PAGE, { passed: false })
		const frame = { width: 640, height: 360 }
		const page = composeMotionPage(failing, frame)
		expect(page).toContain('label.style.opacity = "1"')
		expect(page).not.toContain('Date.now() % 2')
		// And the export’s cache key is the passing version’s: a broken edit
		// neither re-renders the clip nor changes what it contains.
		const item = { duration: 4, motion: failing }
		const same = { duration: 4, motion: passingSpec() }
		const key = (i: typeof item) => motionRenderRecipe(i, { ...frame, fps: 30 })
		expect(key(item)).toBe(key(same))
	})

	it('agrees with itself frame by frame, whatever the working text says', () => {
		const failing = editedSpec(passingSpec(), BOARD_PAGE, { passed: false })
		for (const u of [0, 0.3, 2, 3.9]) {
			expect(motionFrameState({ duration: 4, motion: failing }, u))
				.toEqual(motionFrameState({ duration: 4, motion: passingSpec() }, u))
		}
	})

	it('draws nothing when no version has ever passed — never the failing page', () => {
		const spec = writtenSpec(undefined, BOARD_PAGE, { by: 'Claude Code' })
		expect(spec.passed).toBeNull()
		expect(renderVersion(spec).source).toBe('nothing')
		expect(motionSource(spec)).toBe(EMPTY_MOTION_HTML)
		expect(motionStatus(spec)).toEqual({ state: 'nothing' })
		expect(motionBadge(spec)).toBe('No version has passed yet')
		expect(composeMotionPage(spec, { width: 640, height: 360 })).not.toContain('Date.now() % 2')
	})

	it('trusts the text of a layer from before the checks only if it lints clean', () => {
		const clean: MotionSpec = { html: GOOD_PAGE }
		expect(renderVersion(clean).source).toBe('page')
		const dirty: MotionSpec = { html: BOARD_PAGE }
		expect(renderVersion(dirty).source).toBe('nothing')
		expect(lastPassingOf(clean)!.html).toBe(GOOD_PAGE)
		expect(lastPassingOf(dirty)).toBeNull()
	})

	it('keeps a legacy layer’s clean text as the version to fall back on when it is edited badly', () => {
		const spec = editedSpec({ html: GOOD_PAGE }, BOARD_PAGE, { passed: false })
		expect(spec.passed!.html).toBe(GOOD_PAGE)
		expect(motionStatus(spec)).toEqual({ state: 'last-passing' })
	})

	it('is a template’s own page until it is rewritten, and falls back to it', () => {
		const template = MOTION_TEMPLATES[0]
		expect(lastPassingOf({ template: template.id })!.html).toBe(template.html)
		const spec = writtenSpec({ template: template.id }, BOARD_PAGE, { by: 'Claude Code' })
		expect(spec.template).toBeUndefined()
		expect(spec.passed!.html).toBe(template.html)
	})

	it('a fresh blank layer passes and is the user’s', () => {
		const spec = newMotionSpec()
		expect(motionStatus(spec)).toEqual({ state: 'ok' })
		expect(spec.passed!.html).toBe(BLANK_MOTION_HTML)
		expect(spec.author).toEqual({ by: 'you' })
	})
})

describe('writing a page from the ops path', () => {
	it('draws text that lints clean at once, with its definition read out of it', () => {
		const spec = writtenSpec(newMotionSpec(), GOOD_PAGE, { by: 'Claude Code', turnId: 't8' })
		expect(spec.passed!.html).toBe(GOOD_PAGE)
		expect(resolveDefinition(spec).settings.map((s) => s.key)).toEqual(['value', 'label', 'accent'])
		expect(spec.author).toEqual({ by: 'Claude Code', turnId: 't8' })
	})

	it('keeps what passed when the new text does not, and clears “edited by you”', () => {
		const first = writtenSpec(newMotionSpec(), GOOD_PAGE, { by: 'Claude Code', turnId: 't8' })
		const edited = editedSpec(first, GOOD_PAGE + '\n', { passed: true })
		expect(edited.author!.editedByYou).toBe(true)
		const second = writtenSpec(edited, BOARD_PAGE, { by: 'Codex', turnId: 't9' })
		expect(second.passed!.html).toBe(GOOD_PAGE + '\n')
		expect(second.author).toEqual({ by: 'Codex', turnId: 't9' })
	})

	it('rejects a page with no define as failing', () => {
		const spec = writtenSpec(newMotionSpec(), '<div>hello</div>', { by: 'Claude Code' })
		expect(motionStatus(spec)).toEqual({ state: 'last-passing' })
	})

	it('compares by value, so an unchanged write is not a revision', () => {
		const a = writtenSpec(newMotionSpec(), GOOD_PAGE, { by: 'Claude Code', turnId: 't8' })
		const b = writtenSpec(newMotionSpec(), GOOD_PAGE, { by: 'Claude Code', turnId: 't8' })
		expect(sameMotion(a, b)).toBe(true)
	})
})

describe('pages nobody has probed yet', () => {
	it('lands unverified from the ops path, and verified from the editor', () => {
		const written = writtenSpec(newMotionSpec(), GOOD_PAGE, { by: 'Claude Code' })
		expect(unverifiedPage(written)!.html).toBe(GOOD_PAGE)
		expect(unverifiedPage(editedSpec(newMotionSpec(), GOOD_PAGE, { passed: true }))).toBeNull()
		expect(unverifiedPage(newMotionSpec())).toBeNull()
		expect(unverifiedPage({ template: 'lower-third' })).toBeNull()
	})

	it('is verified once the probe passes', () => {
		const written = writtenSpec(newMotionSpec(), GOOD_PAGE, { by: 'Claude Code' })
		const verified = verifiedSpec(written, GOOD_PAGE)
		expect(unverifiedPage(verified)).toBeNull()
		// A probe of some older text says nothing about this one.
		expect(verifiedSpec(written, 'old')).toBe(written)
	})

	it('draws nothing when the probe fails, and keeps the text to fix', () => {
		const written = writtenSpec(newMotionSpec(), GOOD_PAGE, { by: 'Claude Code' })
		const failed = failedSpec(written, GOOD_PAGE)
		expect(failed.passed).toBeNull()
		expect(failed.html).toBe(GOOD_PAGE)
		expect(motionStatus(failed)).toEqual({ state: 'nothing' })
		expect(failedSpec(written, 'old')).toBe(written)
	})
})

describe('who wrote it', () => {
	const versions: Record<string, number> = { t8: 8 }
	const versionOf = (turn: string) => versions[turn] ?? null

	it('says “Written by Claude Code in V8 · edited by you”, as board 5 does', () => {
		expect(provenanceLabel({ by: 'Claude Code', turnId: 't8', editedByYou: true }, versionOf))
			.toBe('Written by Claude Code in V8 · edited by you')
	})

	it('drops what it does not know', () => {
		expect(provenanceLabel({ by: 'Claude Code', turnId: 't8' }, versionOf)).toBe('Written by Claude Code in V8')
		expect(provenanceLabel({ by: 'Claude Code', turnId: 'gone' }, versionOf)).toBe('Written by Claude Code')
		expect(provenanceLabel({ by: 'you' })).toBe('Written by you')
		expect(provenanceLabel(undefined)).toBe('Written by you')
	})

	it('does not credit an edit to a person who wrote it themselves twice over', () => {
		const mine = editedSpec(newMotionSpec(), GOOD_PAGE, { passed: true })
		expect(provenanceLabel(mine.author)).toBe('Written by you')
	})
})

describe('asking the AI', () => {
	it('sends the error, the line and the page, scoped to the layer', () => {
		const checks = buildChecks(BOARD_PAGE, { determinism: 'pass' })
		const prompt = fixPrompt({ layer: 'Triage stat', itemId: 'ti_1', issue: checks.issues[0], html: BOARD_PAGE })
		expect(prompt).toContain('"Triage stat" (item ti_1)')
		expect(prompt).toContain('Line 14 reads the clock')
		expect(prompt).toContain('Draw only from t.')
		expect(prompt).toContain('label.style.opacity = Date.now()')
		expect(prompt).toContain('updateMotion')
		expect(prompt).toContain('```html')
	})

	it('cuts a very long page rather than the whole request', () => {
		const prompt = fixPrompt({ layer: 'L', itemId: 'x', html: 'a'.repeat(50_000) })
		expect(prompt.length).toBeLessThan(14_000)
		expect(prompt).toContain('(cut)')
	})

	it('asks for a page from a description', () => {
		const prompt = describePrompt({ layer: 'New', itemId: 'ti_2', description: '  a big 3× that counts up  ' })
		expect(prompt).toContain('item ti_2')
		expect(prompt).toContain('a big 3× that counts up')
		expect(prompt).toContain('frameflow.define')
	})
})

describe('the library', () => {
	it('lists the project’s custom layers once per distinct page', () => {
		const spec = writtenSpec(newMotionSpec(), GOOD_PAGE, { by: 'Claude Code' })
		const layers = projectCustomLayers([
			{ id: 'a', label: 'Triage stat', motion: spec },
			{ id: 'b', label: 'Triage stat', motion: spec },
			{ id: 'c', label: 'Lower third', motion: { template: 'lower-third' } },
			{ id: 'd', label: 'Mine', motion: newMotionSpec() },
			{ id: 'e', label: 'No motion' }
		])
		expect(layers.map((l) => [l.itemId, l.name, l.by])).toEqual([
			['a', 'Triage stat', 'custom · by Claude Code'],
			['d', 'Mine', 'custom · by you']
		])
	})

	it('makes unique template ids', () => {
		expect(templateId('Triage stat', [])).toBe('my-triage-stat')
		expect(templateId('Triage stat', ['my-triage-stat'])).toBe('my-triage-stat-2')
		expect(templateId('!!!', [])).toBe('my-layer')
	})

	it('copies a saved template into a layer as a custom page the project owns', () => {
		const definition = extractMotionDefinition(GOOD_PAGE).definition!
		setUserMotionTemplates([{ id: 'my-triage-stat', label: 'Triage stat', description: '', html: GOOD_PAGE, definition, savedAt: 1, author: 'Claude Code' }])
		const spec = newMotionSpec('my-triage-stat')
		expect(spec.template).toBeUndefined()
		expect(spec.passed!.html).toBe(GOOD_PAGE)
		expect(spec.author).toEqual({ by: 'Claude Code' })
		setUserMotionTemplates([])
		expect(newMotionSpec('my-triage-stat').html).toBe(BLANK_MOTION_HTML)
	})

	it('only lets a passing, applied custom layer become a template', () => {
		const passing = buildChecks(GOOD_PAGE, { determinism: 'pass' })
		const failing = buildChecks(BOARD_PAGE, { determinism: 'pass' })
		const ok = writtenSpec(newMotionSpec(), GOOD_PAGE, { by: 'you' })
		expect(saveAsTemplateBlocker(ok, passing)).toBeNull()
		expect(saveAsTemplateBlocker(ok, failing)).toMatch(/failing checks/)
		expect(saveAsTemplateBlocker({ template: 'lower-third' }, passing)).toMatch(/custom layer/)
		expect(saveAsTemplateBlocker(editedSpec(ok, BOARD_PAGE, { passed: false }), passing)).toMatch(/latest edit/)
	})

	it('hashes a text the same way every time, and differently when it changes', () => {
		expect(htmlHash('abc')).toBe(htmlHash('abc'))
		expect(htmlHash('abc')).not.toBe(htmlHash('abd'))
		expect(htmlHash('abc')).toHaveLength(8)
	})
})
