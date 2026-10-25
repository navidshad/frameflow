import type { EditorDocument, EditorOps, TimelineDiff, TimelineItem } from '@shared/types'
import type { JsonSchema } from '@shared/agent'
import { lintMotionKit, motionTemplate, sameMotionKit, tidyMotionKit, type MotionKit, type MotionSpec } from '@shared/motion'

/**
 * Motion kits over the ops contract: `setMotionKits` / `removeMotionKits`, and
 * the `kit` an `addMotion` / `updateMotion` names.
 *
 * A kit is the project's shared look — CSS and JS stored once on the document
 * and inlined into every page that names it when the page is composed. So a
 * restyle of 28 layers is ONE kit edit: one op, one revision, and only the
 * clips whose pages use the kit compose differently and re-render.
 *
 * Pure, like the rest of the ops mapping. The checks that need a window (the
 * probe) run first, in `vetHtmlOps`; this maps what survived onto the diff.
 */

type KitRequest = NonNullable<EditorOps['setMotionKits']>[number]

/** Added to apply_ops over MCP only, beside the sound ops. */
export const MOTION_KIT_OPS_SCHEMA: Record<string, JsonSchema> = {
	setMotionKits: {
		type: 'array',
		description:
			'Add or change a project motion kit: CSS and JS stored ONCE and shared by every custom page that names it ' +
			'(addMotion / updateMotion `kit`). Use one when several layers share a look: the pages stay small, and a ' +
			'restyle is one edit here instead of re-sending every page. Fields you send replace the kit’s own; fields ' +
			'you leave out keep theirs; "" empties one. The kit is checked like a page (no clocks, timers, random, CSS ' +
			'animation or network) and drawn with a few of the pages that use it; a kit that fails is not applied.',
		items: {
			type: 'object',
			properties: {
				id: { type: 'string', description: 'Short and stable, what pages name: "nomad". Letters, digits, - and _.' },
				label: { type: 'string' },
				css: { type: 'string', description: 'Style rules only, no <style> tag. Inlined after the bundled fonts and before the page’s own styles. @font-face with data: URLs for extra fonts.' },
				js: { type: 'string', description: 'Script only, no <script> tag. Runs in the <head> after the frameflow runtime and before the page, so the page’s elements do not exist yet: define helpers (e.g. window.nomad = { … }) and let the page call them.' }
			},
			required: ['id'],
			additionalProperties: false
		}
	},
	removeMotionKits: {
		type: 'array',
		description: 'Kit ids to delete. Refused while a layer still uses the kit.',
		items: { type: 'string' }
	}
}

/** Does this request send code that runs in a page? Kits and kit choices need the HTML permission. */
export function opsWriteKits(ops: Pick<EditorOps, 'setMotionKits' | 'addMotion' | 'updateMotion'>): boolean {
	return !!ops.setMotionKits?.length ||
		!!ops.addMotion?.some((r) => typeof r?.kit === 'string' && r.kit !== '') ||
		!!ops.updateMotion?.some((r) => typeof r?.kit === 'string')
}

/** One `setMotionKits` entry laid over the kit it changes (or a new one). */
export function mergeKitRequest(existing: MotionKit | undefined, request: KitRequest): MotionKit {
	const pick = (field: 'label' | 'css' | 'js') =>
		typeof request[field] === 'string' ? request[field] : existing?.[field]
	return tidyMotionKit({ id: String(request.id ?? '').trim(), label: pick('label'), css: pick('css'), js: pick('js') })
}

/** The project's kits once every `setMotionKits` entry in `ops` is applied, without checking them. */
export function kitsAfterSet(ops: Pick<EditorOps, 'setMotionKits'>, kits: readonly MotionKit[] | undefined): MotionKit[] {
	const byId = new Map((kits ?? []).map((k) => [k.id, k]))
	for (const request of ops.setMotionKits ?? []) {
		const merged = mergeKitRequest(byId.get(String(request?.id ?? '').trim()), request)
		if (merged.id) byId.set(merged.id, merged)
	}
	return [...byId.values()]
}

/** A custom page's spec with the kit an op asks for. Templates never use one. */
export function withKit(spec: MotionSpec, kit: string | undefined): MotionSpec {
	if (kit === undefined || motionTemplate(spec.template)) return spec
	const out = { ...spec }
	if (kit === '') delete out.kit
	else out.kit = kit
	return out
}

/** Every layer that names `kitId` once this diff is applied, for "used by". */
function usersOf(kitId: string, doc: EditorDocument, diff: TimelineDiff, ops: EditorOps): string[] {
	const removed = new Set(diff.removeItemIds ?? [])
	const detached = new Set((ops.updateMotion ?? []).filter((r) => typeof r?.kit === 'string' && r.kit !== kitId).map((r) => r.id))
	const label = (i: TimelineItem) => `"${i.label || i.id}"`
	const existing = doc.timeline
		.filter((i) => !removed.has(i.id) && !detached.has(i.id) && i.motion?.kit === kitId)
		.map(label)
	const attaching = (ops.updateMotion ?? []).filter((r) => r?.kit === kitId)
		.map((r) => doc.timeline.find((i) => i.id === r.id)).filter((i): i is TimelineItem => !!i && !removed.has(i.id))
		.filter((i) => i.motion?.kit !== kitId).map(label)
	const adding = (ops.addMotion ?? []).filter((r) => r?.kit === kitId).map((r) => `"${r.label || 'new layer'}"`)
	return [...existing, ...attaching, ...adding]
}

/**
 * `setMotionKits` / `removeMotionKits` → the diff, and the motion ops with
 * every `kit` checked against the kits the project will have.
 *
 * A page that names a kit the project does not have would draw without its
 * styles and helpers, so that op is dropped with a reason rather than landed
 * half-working. A kit field on a template layer is ignored: templates are
 * fixed, and carry their own look.
 */
export function applyMotionKitOps(
	ops: EditorOps,
	doc: EditorDocument,
	diff: TimelineDiff,
	droppedOps: string[],
	notes: string[]
): EditorOps {
	const before = new Map((doc.motionKits ?? []).map((k) => [k.id, k]))
	const kits = new Map(before)

	for (const [i, request] of (ops.setMotionKits ?? []).entries()) {
		const id = String(request?.id ?? '').trim()
		const merged = mergeKitRequest(kits.get(id), request)
		const problems = lintMotionKit(merged)
		if (problems.length) {
			droppedOps.push(`setMotionKits[${i}] ("${id}") rejected, nothing changed: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`)
			continue
		}
		kits.set(id, merged)
	}

	for (const id of ops.removeMotionKits ?? []) {
		if (!kits.has(id)) { droppedOps.push(`removeMotionKits: there is no kit "${id}"`); continue }
		const users = usersOf(id, doc, diff, ops)
		if (users.length) {
			droppedOps.push(`removeMotionKits: "${id}" is still used by ${users.slice(0, 5).join(', ')}${users.length > 5 ? ` and ${users.length - 5} more` : ''}. Move them off it first (updateMotion kit: "").`)
			continue
		}
		kits.delete(id)
	}

	// The diff, kit by kit: only what really changed.
	for (const [id, kit] of kits) {
		if (sameMotionKit(before.get(id), kit)) continue
		;(diff.setMotionKits ||= []).push(kit)
		const users = usersOf(id, doc, diff, ops).length
		notes.push(before.has(id)
			? `Kit "${id}" updated: ${users} layer${users === 1 ? '' : 's'} use${users === 1 ? 's' : ''} it and redraw${users === 1 ? 's' : ''} with it.`
			: `Kit "${id}" added. Name it with kit: "${id}" on addMotion / updateMotion.`)
	}
	for (const id of before.keys()) {
		if (!kits.has(id)) (diff.removeMotionKitIds ||= []).push(id)
	}

	// Every `kit` an op names must exist once this call is applied.
	const known = (kit: string | undefined) => kit === undefined || kit === '' || kits.has(kit)
	const unknown = (kit: string) =>
		`there is no kit "${kit}"${kits.size ? ` (kits: ${[...kits.keys()].join(', ')})` : ''}. Add it with setMotionKits first, in this call or an earlier one`
	const out: EditorOps = { ...ops }
	if (ops.addMotion) {
		out.addMotion = ops.addMotion.filter((request, i) => {
			if (known(request?.kit)) return true
			droppedOps.push(`addMotion[${i}] rejected, nothing was added: ${unknown(request.kit!)}.`)
			return false
		}).map((request) => {
			const isTemplate = !!motionTemplate(request?.template) && !(typeof request?.html === 'string' && request.html.trim())
			if (!isTemplate || !request.kit) return request
			notes.push(`"${request.label || request.template}" is a template; templates keep their own look, so kit "${request.kit}" was not applied.`)
			return { ...request, kit: undefined }
		})
		if (!out.addMotion.length) out.addMotion = undefined
	}
	if (ops.updateMotion) {
		out.updateMotion = ops.updateMotion.filter((request) => {
			if (known(request?.kit)) return true
			droppedOps.push(`updateMotion ${request.id} rejected, the layer is unchanged: ${unknown(request.kit!)}.`)
			return false
		})
		if (!out.updateMotion.length) out.updateMotion = undefined
	}
	return out
}
