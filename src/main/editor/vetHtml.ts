import type { EditorDocument, EditorOps } from '@shared/types'
import { BLANK_MOTION_DEFINITION, lintMotionHtml, lintMotionKit, type MotionKit } from '@shared/motion'
import { extractMotionDefinition } from '@shared/motionCode'
import type { MotionProbeInput, MotionProbeResult } from '../motion/probe'
import { kitsAfterSet, mergeKitRequest } from './kitOps'

/**
 * One rule for every page a machine writes: CHECK IT BEFORE IT REPLACES
 * ANYTHING.
 *
 * A person's edit in the code view is checked — the lint, then the page drawn
 * twice in the hidden window — before it becomes anything but a working copy.
 * This gives an AI's or an agent's `addMotion` / `updateMotion` with `html` the
 * same treatment, ahead of the diff rather than after it: a page that fails
 * either check is not applied at all. The layer keeps the page it had (or is
 * never added), and the writer is told exactly what to fix so it can try again.
 *
 * It runs in front of `opsToDiff` on both paths that write pages — MCP
 * `apply_ops`, which the built-in Claude Code engine shares, and the editor's
 * own AI turn — so there is no way to land a page that skipped the checks.
 */

export type MotionProbe = (input: MotionProbeInput) => Promise<MotionProbeResult>

export interface VetResult {
	/** The ops with every rejected page's op taken out. Everything else is untouched. */
	ops: EditorOps
	/** One precise reason per rejected op, written for the agent that sent it. */
	dropped: string[]
}

const isPage = (html: unknown): html is string => typeof html === 'string' && html.trim() !== ''

/** Why this page may not be applied, or null when it may. */
export async function whyPageFails(
	html: string,
	frame: { width: number; height: number },
	probe?: MotionProbe,
	/** The project kit the page uses: drawn with it, as it will be shown. */
	kit?: MotionKit
): Promise<string | null> {
	const lint = lintMotionHtml(html)
	if (!lint.ok) {
		const first = lint.issues[0]
		const more = lint.issues.length > 1 ? ` (and ${lint.issues.length - 1} more)` : ''
		const line = first.excerpt ? ` — “${first.excerpt}”` : ''
		return `line ${first.line}${line}: ${first.message}${more}`
	}
	// No window to draw in (a test, or a platform without one): the lint decides.
	if (!probe) return null

	const definition = extractMotionDefinition(html).definition ?? BLANK_MOTION_DEFINITION
	const result = await probe({ html, definition, frame, kit })
	if (result.error) return `the page throws when it runs: ${result.error}`
	if (result.determinism === 'fail') {
		const at = result.differsAt === undefined ? '' : ` at t = ${result.differsAt.toFixed(2)}s`
		return `drawing the same frame twice gave different pixels${at}. Something in seek(t, settings) depends on state left by an earlier call (a counter, an accumulated value, an element that is moved relative to where it was). Make the picture a pure function of t and settings`
	}
	return null
}

/** How many of a kit's pages are drawn with a changed kit before it lands. */
const KIT_PROBE_SAMPLE = 3

/** Up to `n` spread out across the list: the first, the last, the middle. */
const sample = <T>(list: T[], n: number): T[] =>
	list.length <= n ? list : [...new Set(Array.from({ length: n }, (_, k) => Math.round((k * (list.length - 1)) / (n - 1))))].map((i) => list[i])

export async function vetHtmlOps(
	ops: EditorOps,
	doc: Pick<EditorDocument, 'timelineMeta'> & Partial<Pick<EditorDocument, 'timeline' | 'motionKits'>>,
	probe?: MotionProbe
): Promise<VetResult> {
	const dropped: string[] = []
	const frame = { width: doc.timelineMeta?.width || 1920, height: doc.timelineMeta?.height || 1080 }
	const timeline = doc.timeline ?? []

	// ---- Kits first: the pages below are drawn with the kits that will be. ----
	// A changed kit is linted, then drawn with a few of the pages that use it (a
	// kit that throws breaks every one of them). Sampled, not all: a series of 28
	// layers would otherwise mean 28 probes for one restyle.
	const setKits: NonNullable<EditorOps['setMotionKits']> = []
	let accepted: MotionKit[] = [...(doc.motionKits ?? [])]
	for (const [i, request] of (ops.setMotionKits ?? []).entries()) {
		const id = String(request?.id ?? '').trim()
		const kit = mergeKitRequest(accepted.find((k) => k.id === id), request)
		const problems = lintMotionKit(kit)
		let reason: string | null = problems.length
			? `${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`
			: null
		if (!reason && probe) {
			const pages = [...new Map(timeline
				.filter((item) => item.motion?.kit === id && !item.motion.template && item.motion.passed?.html)
				.map((item) => [item.motion!.passed!.html, item])).values()]
			for (const item of sample(pages, KIT_PROBE_SAMPLE)) {
				const why = await whyPageFails(item.motion!.passed!.html, frame, probe, kit)
				if (why) { reason = `with this kit, layer "${item.label || item.id}" fails: ${why}`; break }
			}
		}
		if (reason) {
			dropped.push(`setMotionKits[${i}] ("${id}") rejected, the kit is unchanged: ${reason}. Fix it and send it again.`)
			continue
		}
		setKits.push(request)
		accepted = kitsAfterSet({ setMotionKits: [request] }, accepted)
	}
	const kitNamed = (kit: string | undefined) => (kit ? accepted.find((k) => k.id === kit) : undefined)

	const added: NonNullable<EditorOps['addMotion']> = []
	for (const [i, request] of (ops.addMotion ?? []).entries()) {
		if (!isPage(request?.html)) { added.push(request); continue }
		const reason = await whyPageFails(request.html, frame, probe, kitNamed(request.kit))
		if (reason) {
			dropped.push(`addMotion[${i}] (custom page) rejected, nothing was added: ${reason}. Fix the page and send it again.`)
			continue
		}
		added.push(request)
	}

	const updated: NonNullable<EditorOps['updateMotion']> = []
	for (const request of ops.updateMotion ?? []) {
		const item = timeline.find((i) => i.id === request?.id)
		// The kit this layer will draw with: the one the op names, else the one it has.
		const kit = kitNamed(request?.kit !== undefined ? request.kit : item?.motion?.kit)
		// A page moved onto a kit without new text is drawn with it too.
		const html = isPage(request?.html)
			? request.html
			: request?.kit && item?.motion && !item.motion.template && item.motion.passed?.html
				? item.motion.passed.html
				: null
		if (!html) { updated.push(request); continue }
		const reason = await whyPageFails(html, frame, probe, kit)
		if (reason) {
			dropped.push(`updateMotion ${request.id} rejected, the layer keeps its previous page: ${reason}. Fix the page and send it again.`)
			continue
		}
		updated.push(request)
	}

	if (!dropped.length) return { ops, dropped }
	const vetted: EditorOps = { ...ops }
	if (ops.setMotionKits) vetted.setMotionKits = setKits.length ? setKits : undefined
	if (ops.addMotion) vetted.addMotion = added.length ? added : undefined
	if (ops.updateMotion) vetted.updateMotion = updated.length ? updated : undefined
	return { ops: vetted, dropped }
}
