import type { EditorDocument, EditorOps } from '@shared/types'
import { BLANK_MOTION_DEFINITION, lintMotionHtml } from '@shared/motion'
import { extractMotionDefinition } from '@shared/motionCode'
import type { MotionProbeInput, MotionProbeResult } from '../motion/probe'

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
	probe?: MotionProbe
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
	const result = await probe({ html, definition, frame })
	if (result.error) return `the page throws when it runs: ${result.error}`
	if (result.determinism === 'fail') {
		const at = result.differsAt === undefined ? '' : ` at t = ${result.differsAt.toFixed(2)}s`
		return `drawing the same frame twice gave different pixels${at}. Something in seek(t, settings) depends on state left by an earlier call (a counter, an accumulated value, an element that is moved relative to where it was). Make the picture a pure function of t and settings`
	}
	return null
}

export async function vetHtmlOps(
	ops: EditorOps,
	doc: Pick<EditorDocument, 'timelineMeta'>,
	probe?: MotionProbe
): Promise<VetResult> {
	const dropped: string[] = []
	const frame = { width: doc.timelineMeta?.width || 1920, height: doc.timelineMeta?.height || 1080 }

	const added: NonNullable<EditorOps['addMotion']> = []
	for (const [i, request] of (ops.addMotion ?? []).entries()) {
		if (!isPage(request?.html)) { added.push(request); continue }
		const reason = await whyPageFails(request.html, frame, probe)
		if (reason) {
			dropped.push(`addMotion[${i}] (custom page) rejected, nothing was added: ${reason}. Fix the page and send it again.`)
			continue
		}
		added.push(request)
	}

	const updated: NonNullable<EditorOps['updateMotion']> = []
	for (const request of ops.updateMotion ?? []) {
		if (!isPage(request?.html)) { updated.push(request); continue }
		const reason = await whyPageFails(request.html, frame, probe)
		if (reason) {
			dropped.push(`updateMotion ${request.id} rejected, the layer keeps its previous page: ${reason}. Fix the page and send it again.`)
			continue
		}
		updated.push(request)
	}

	if (!dropped.length) return { ops, dropped }
	const vetted: EditorOps = { ...ops }
	if (ops.addMotion) vetted.addMotion = added.length ? added : undefined
	if (ops.updateMotion) vetted.updateMotion = updated.length ? updated : undefined
	return { ops: vetted, dropped }
}
