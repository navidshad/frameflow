import type { EditorDocument, EditorOps } from '@shared/types'
import type { MotionDefinition } from '@shared/motion'
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

/** A picture that goes back with a rejection, as MCP image content. */
export interface VetImage {
	/** The op it belongs to, as named in `dropped`. */
	op: string
	data: string
	mimeType: 'image/png'
}

export interface VetResult {
	/** The ops with every rejected page's op taken out. Everything else is untouched. */
	ops: EditorOps
	/** One precise reason per rejected op, written for the agent that sent it. */
	dropped: string[]
	/**
	 * What each page that passed reported to `define` when it RAN, by its html.
	 * The text read misses `duration: SPEC.duration`; the run does not, so the
	 * mapping uses this ahead of the text (see `opsToDiff`'s `pageDefinitions`).
	 */
	definitions: Map<string, MotionDefinition>
	/** The two renders of a frame that drew two ways, one per rejected op. */
	images: VetImage[]
}

export interface PageVerdict {
	reason: string | null
	/** What the page passed to `define` at run time, when the probe ran it. */
	definition?: MotionDefinition
	/** PNG, base64, when the page drew one frame two ways. */
	image?: string
}

const isPage = (html: unknown): html is string => typeof html === 'string' && html.trim() !== ''

const px = (n: number) => `${Math.round(n)}`

/** "drawing the same frame twice gave different pixels at t = …", with what and where. */
function differenceReason(result: MotionProbeResult): string {
	const at = result.differsAt === undefined ? '' : ` at t = ${result.differsAt.toFixed(2)}s`
	const d = result.difference
	const head = `drawing the same frame twice gave different pixels${at}`
	if (!d || !d.pixels) {
		return `${head}. Something in seek(t, settings) depends on state left by an earlier call (a counter, an accumulated value, an element that is moved relative to where it was). Make the picture a pure function of t and settings`
	}
	const box = `${px(d.box.width)}×${px(d.box.height)} px at x ${px(d.box.x)}, y ${px(d.box.y)} (sequence pixels)`
	const share = d.share < 0.001 ? '<0.1%' : `${(d.share * 100).toFixed(1)}%`
	const facts = `${d.pixels} pixels differ (${share} of the frame, probed at 1/${d.scale} size), in a box ${box}; the largest change is ${d.maxDelta}/255, the average ${d.meanDelta}/255`
	const image = d.image ? ' The attached image shows that area drawn the first time (left), the second time (middle), and the differing pixels in red (right).' : ''
	const subPixel = 'faint changes along edges are a sub-pixel position: something near rest sits at a fraction of a pixel (an eased translate, scale or left/top that is not quite 0 or 1), and the browser anti-aliases it a little differently each time. Round positions to whole pixels (Math.round) and snap to the rest value when the motion is within a pixel of it'
	const state = 'a shape that moved or changed is state from the previous seek, so seek(t, settings) depends on state left by an earlier call: a counter or accumulated value, an element moved relative to where it was, or layout MEASURED before it is UPDATED for this t (getBoundingClientRect/offsetWidth read before you set the text or size, so a revisit reads the previous seek\'s layout). Set everything for t first, then measure, and make the picture a pure function of t and settings'
	const causes = d.looksSubPixel
		? `This looks like a sub-pixel position: ${subPixel}. If it is not that, ${state}`
		: `This looks like state: ${state}. If the change is only faint edges, ${subPixel}`
	return `${head}: ${facts}.${image} ${causes}`
}

/** Why this page may not be applied (or null when it may), with what the run showed. */
export async function vetPage(
	html: string,
	frame: { width: number; height: number },
	probe?: MotionProbe
): Promise<PageVerdict> {
	const lint = lintMotionHtml(html)
	if (!lint.ok) {
		const first = lint.issues[0]
		const more = lint.issues.length > 1 ? ` (and ${lint.issues.length - 1} more)` : ''
		const line = first.excerpt ? ` — “${first.excerpt}”` : ''
		return { reason: `line ${first.line}${line}: ${first.message}${more}` }
	}
	// No window to draw in (a test, or a platform without one): the lint decides.
	if (!probe) return { reason: null }

	const definition = extractMotionDefinition(html).definition ?? BLANK_MOTION_DEFINITION
	const result = await probe({ html, definition, frame })
	if (result.error) return { reason: `the page throws when it runs: ${result.error}`, definition: result.definition }
	if (result.determinism === 'fail') {
		return { reason: differenceReason(result), definition: result.definition, image: result.difference?.image }
	}
	return { reason: null, definition: result.definition }
}

/** Why this page may not be applied, or null when it may. */
export async function whyPageFails(
	html: string,
	frame: { width: number; height: number },
	probe?: MotionProbe
): Promise<string | null> {
	return (await vetPage(html, frame, probe)).reason
}

export async function vetHtmlOps(
	ops: EditorOps,
	doc: Pick<EditorDocument, 'timelineMeta'>,
	probe?: MotionProbe
): Promise<VetResult> {
	const dropped: string[] = []
	const definitions = new Map<string, MotionDefinition>()
	const images: VetImage[] = []
	const frame = { width: doc.timelineMeta?.width || 1920, height: doc.timelineMeta?.height || 1080 }

	const added: NonNullable<EditorOps['addMotion']> = []
	for (const [i, request] of (ops.addMotion ?? []).entries()) {
		if (!isPage(request?.html)) { added.push(request); continue }
		const verdict = await vetPage(request.html, frame, probe)
		if (verdict.reason) {
			dropped.push(`addMotion[${i}] (custom page) rejected, nothing was added: ${verdict.reason}. Fix the page and send it again.`)
			if (verdict.image) images.push({ op: `addMotion[${i}]`, data: verdict.image, mimeType: 'image/png' })
			continue
		}
		if (verdict.definition) definitions.set(request.html, verdict.definition)
		added.push(request)
	}

	const updated: NonNullable<EditorOps['updateMotion']> = []
	for (const request of ops.updateMotion ?? []) {
		if (!isPage(request?.html)) { updated.push(request); continue }
		const verdict = await vetPage(request.html, frame, probe)
		if (verdict.reason) {
			dropped.push(`updateMotion ${request.id} rejected, the layer keeps its previous page: ${verdict.reason}. Fix the page and send it again.`)
			if (verdict.image) images.push({ op: `updateMotion ${request.id}`, data: verdict.image, mimeType: 'image/png' })
			continue
		}
		if (verdict.definition) definitions.set(request.html, verdict.definition)
		updated.push(request)
	}

	if (!dropped.length) return { ops, dropped, definitions, images }
	const vetted: EditorOps = { ...ops }
	if (ops.addMotion) vetted.addMotion = added.length ? added : undefined
	if (ops.updateMotion) vetted.updateMotion = updated.length ? updated : undefined
	return { ops: vetted, dropped, definitions, images }
}
