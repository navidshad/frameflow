import type { MotionDefinition, MotionFrameState } from '@shared/motion'
import { composeMotionPage, settingValues } from '@shared/motion'
import { openMotionCapture } from './capture'

/**
 * The runtime check behind "Same frame twice gives the same pixels".
 *
 * A static lint cannot see everything that makes a page draw differently on a
 * second visit to the same instant — state left behind by an earlier seek, a
 * font that loads late, a layout that depends on a measurement. So the page is
 * actually drawn: in the same hidden window the export uses, at a handful of
 * instants, once forwards and once in reverse order, and every instant's two
 * renders must match to the pixel. A page that throws fails too, and says what.
 *
 * Probing at a reduced size is deliberate: determinism does not depend on the
 * frame's size, and a page that passes at 640 wide should not make the person
 * wait for it at 4K.
 */

export interface MotionProbeInput {
	html: string
	definition: MotionDefinition
	frame: { width: number; height: number }
}

export interface MotionProbeResult {
	/** `skipped`: nothing to draw (the page never defines itself). */
	determinism: 'pass' | 'fail' | 'skipped'
	/** Page seconds of the first instant that drew two ways. */
	differsAt?: number
	/** The page threw, or logged an error, while it loaded or drew. */
	error?: string
}

const PROBE_WIDTH = 640
const PROBE_INSTANTS = [0, 0.25, 0.5, 0.75, 1]

/** Probes run one at a time: each opens a window, and typing queues one per keystroke. */
let chain: Promise<unknown> = Promise.resolve()

export function probeMotionPage(input: MotionProbeInput): Promise<MotionProbeResult> {
	const run = chain.then(() => probeNow(input), () => probeNow(input))
	chain = run.catch(() => undefined)
	return run
}

const tidyError = (message: string): string =>
	message.replace(/^Error invoking remote method[^:]*:\s*/, '').replace(/^(Uncaught )?Error:\s*/, '').trim().slice(0, 400)

async function probeNow(input: MotionProbeInput): Promise<MotionProbeResult> {
	if (!/\bframeflow\s*\.\s*define\s*\(/.test(input.html)) return { determinism: 'skipped' }

	const width = Math.min(PROBE_WIDTH, Math.max(2, Math.round(input.frame.width)))
	const height = Math.max(2, Math.round(width * input.frame.height / Math.max(1, input.frame.width)))
	// `renderVersion` draws a spec's passing version; make the candidate it.
	const spec = { html: input.html, definition: input.definition, passed: { html: input.html, definition: input.definition } }
	const page = composeMotionPage(spec, { width, height })
	const settings = settingValues(spec, input.definition)
	const duration = input.definition.duration
	const instants = PROBE_INSTANTS.map((f): MotionFrameState => ({ t: f * duration, settings, opacity: 1 }))

	let capture
	try {
		capture = await openMotionCapture(page, { width, height }, { readyTimeoutMs: 4000 })
	} catch (error: any) {
		return { determinism: 'fail', error: tidyError(String(error?.message || error)) }
	}
	try {
		const first: Buffer[] = []
		for (const state of instants) first.push(await capture.frame(state))
		// Reverse order, so a page that remembers where it was last seeked shows it.
		for (let k = instants.length - 1; k >= 0; k--) {
			const again = await capture.frame(instants[k])
			if (!again.equals(first[k])) return { determinism: 'fail', differsAt: instants[k].t }
		}
		const logged = capture.errors()
		if (logged.length) return { determinism: 'fail', error: tidyError(logged[0]) }
		return { determinism: 'pass' }
	} catch (error: any) {
		return { determinism: 'fail', error: tidyError(String(error?.message || error)) }
	} finally {
		capture.close()
	}
}
