import fs from 'fs'
import path from 'path'
import { lintMotionHtml, normaliseDefinition } from '@shared/motion'
import { templateId } from '@shared/motionCode'
import { setUserMotionTemplates, type MotionUserTemplate } from '@shared/motionTemplates'

/**
 * "Save as template": custom layers promoted to the library for every project.
 *
 * One JSON file per template under `<userData>/motion-templates/`. Plain `fs`
 * and a directory argument, no Electron, so the round trip is tested for real;
 * `motion/ipc.ts` supplies the directory.
 *
 * Files are read back as untrusted: a hand-edited or damaged one is skipped
 * rather than trusted, and a page that no longer lints clean never reaches the
 * library — the same gate a layer has to pass to be saved in the first place.
 */

export interface SaveTemplateInput {
	label: string
	description?: string
	html: string
	definition?: MotionUserTemplate['definition']
	author?: string
}

function readTemplate(file: string): MotionUserTemplate | null {
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
		if (!raw || typeof raw.id !== 'string' || typeof raw.label !== 'string' || typeof raw.html !== 'string') return null
		if (!lintMotionHtml(raw.html).ok) return null
		return {
			id: raw.id,
			label: raw.label,
			description: typeof raw.description === 'string' ? raw.description : '',
			html: raw.html,
			definition: normaliseDefinition(raw.definition),
			savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
			author: typeof raw.author === 'string' ? raw.author : undefined
		}
	} catch {
		return null
	}
}

/** Every saved template, oldest first. Also refreshes the shared registry. */
export function loadUserTemplates(dir: string): MotionUserTemplate[] {
	let names: string[] = []
	try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')) } catch { /* no folder yet */ }
	const list = names
		.map((n) => readTemplate(path.join(dir, n)))
		.filter((t): t is MotionUserTemplate => !!t)
		.sort((a, b) => a.savedAt - b.savedAt)
	setUserMotionTemplates(list)
	return list
}

export function saveUserTemplate(dir: string, input: SaveTemplateInput): { ok: true; template: MotionUserTemplate } | { ok: false; error: string } {
	const label = input.label.trim()
	if (!label) return { ok: false, error: 'Give the template a name.' }
	const lint = lintMotionHtml(input.html)
	if (!lint.ok) {
		return { ok: false, error: `Only a page that passes its checks can be a template (line ${lint.issues[0].line}: ${lint.issues[0].message})` }
	}
	const taken = loadUserTemplates(dir).map((t) => t.id)
	const template: MotionUserTemplate = {
		id: templateId(label, taken),
		label,
		description: input.description?.trim() || 'A custom layer saved from a project.',
		html: input.html,
		definition: normaliseDefinition(input.definition),
		savedAt: Date.now(),
		author: input.author
	}
	fs.mkdirSync(dir, { recursive: true })
	// Written to a sibling and renamed, so a crash never leaves half a template.
	const file = path.join(dir, `${template.id}.json`)
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(template, null, 2))
	fs.renameSync(`${file}.tmp`, file)
	loadUserTemplates(dir)
	return { ok: true, template }
}

export function deleteUserTemplate(dir: string, id: string): MotionUserTemplate[] {
	// The id names a file: never let one walk out of the folder.
	if (/^[a-z0-9][a-z0-9-]*$/.test(id)) {
		try { fs.unlinkSync(path.join(dir, `${id}.json`)) } catch { /* already gone */ }
	}
	return loadUserTemplates(dir)
}
