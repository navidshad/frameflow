import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { extractMotionDefinition } from '@shared/motionCode'
import { newMotionSpec, resolveDefinition } from '@shared/motion'
import { userMotionTemplates } from '@shared/motionTemplates'
import { deleteUserTemplate, loadUserTemplates, saveUserTemplate } from './templatesStore'

const PAGE = [
	'<div id="n"></div>',
	'<script>frameflow.define({ duration: 4, settings: [{ key: "value", type: "number", default: 3, animate: true }],',
	'  moments: [{ name: "in", duration: 0.5 }, { name: "hold", duration: 3, flex: true }, { name: "out", duration: 0.5 }],',
	'  seek(t, s) { document.getElementById("n").textContent = String(s.value) } })</script>'
].join('\n')

let dir: string
beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ff-templates-')), 'motion-templates') })
afterEach(() => { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); loadUserTemplates(dir) })

describe('saved motion templates', () => {
	it('round-trips through disk, and a layer made from one is a self-contained custom page', () => {
		const saved = saveUserTemplate(dir, { label: 'Triage stat', html: PAGE, definition: extractMotionDefinition(PAGE).definition, author: 'Claude Code' })
		expect(saved.ok).toBe(true)
		if (!saved.ok) return
		expect(saved.template.id).toBe('my-triage-stat')
		expect(fs.existsSync(path.join(dir, 'my-triage-stat.json'))).toBe(true)
		// Fresh process: only the folder remembers.
		expect(loadUserTemplates(dir).map((t) => t.id)).toEqual(['my-triage-stat'])
		expect(userMotionTemplates()[0].author).toBe('Claude Code')
		const spec = newMotionSpec('my-triage-stat')
		expect(spec.template).toBeUndefined()
		expect(resolveDefinition(spec).settings.map((s) => s.key)).toEqual(['value'])
	})

	it('gives a second template of the same name its own id', () => {
		saveUserTemplate(dir, { label: 'Same', html: PAGE })
		const second = saveUserTemplate(dir, { label: 'Same', html: PAGE })
		expect(second.ok && second.template.id).toBe('my-same-2')
		expect(loadUserTemplates(dir)).toHaveLength(2)
	})

	it('refuses a page that fails its checks, and a nameless one', () => {
		const bad = saveUserTemplate(dir, { label: 'Clocky', html: PAGE.replace('String(s.value)', 'String(Date.now())') })
		expect(bad.ok).toBe(false)
		expect(!bad.ok && bad.error).toMatch(/passes its checks/)
		expect(saveUserTemplate(dir, { label: '  ', html: PAGE }).ok).toBe(false)
		expect(fs.existsSync(dir)).toBe(false)
	})

	it('skips a damaged file and a page that has stopped linting clean', () => {
		saveUserTemplate(dir, { label: 'Good', html: PAGE })
		fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json')
		fs.writeFileSync(path.join(dir, 'tampered.json'), JSON.stringify({ id: 'tampered', label: 'T', html: '<script>setTimeout(f,1);frameflow.define({})</script>' }))
		expect(loadUserTemplates(dir).map((t) => t.id)).toEqual(['my-good'])
	})

	it('deletes a template, and only ever inside its own folder', () => {
		saveUserTemplate(dir, { label: 'Gone', html: PAGE })
		const outside = path.join(path.dirname(dir), 'precious.json')
		fs.writeFileSync(outside, '{}')
		deleteUserTemplate(dir, '../precious')
		expect(fs.existsSync(outside)).toBe(true)
		expect(deleteUserTemplate(dir, 'my-gone')).toEqual([])
	})
})
