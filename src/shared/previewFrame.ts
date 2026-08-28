import type { Seam, TransitionWindow } from './transitionPlan'
import { transitionAt } from './transitionPlan'

/**
 * What the preview monitor should show at a given instant.
 *
 * Pure — no DOM, no Node/Electron. The renderer has no automated test path
 * (vitest here is node-only by policy), so the decision lives here where it can
 * be asserted, and `useEdlPlayback` is left to move elements around.
 *
 * Three modes, in priority order:
 *   cached  — a transition window whose exact render is ready; play that file
 *   blend   — a transition window with no render yet; cross-fade the A/B pair
 *   single  — no window in flight; today's behaviour, one element
 */

export type PreviewMode = 'single' | 'blend' | 'cached'

/** Readiness of the background render for one junction. */
export type PreviewStatus = 'rendering' | 'ready' | 'error'

export interface PreviewEntry {
	status: PreviewStatus
	/** Playable URL of the rendered window. Present only when ready. */
	src?: string
}

export interface PreviewFrame {
	mode: PreviewMode
	/** The window in flight, for 'blend' and 'cached'. */
	window?: TransitionWindow
	/** 0..1 across the window. incoming opacity = progress, outgoing = 1 - progress. */
	progress: number
	/** For 'cached': the file to play, and how far into it the playhead is. */
	cachedSrc?: string
	cachedTime?: number
	/**
	 * True while a window is showing the fallback because its exact render has
	 * not landed yet. The monitor says so, otherwise a dissolve standing in for a
	 * wipe reads as wrong rather than pending.
	 */
	pending: boolean
}

const SINGLE: PreviewFrame = { mode: 'single', progress: 0, pending: false }

/**
 * Resolve the frame at time `t`.
 *
 * `playableItemIds` guards a real mismatch: `seams` is built from the timeline
 * and keeps items whose media has no resolvable path, while the EDL segments
 * drop them. A window naming an unplayable clip must fall through to `single`
 * rather than blending against nothing.
 */
export function resolvePreviewFrame(
	seams: readonly Seam[],
	previews: ReadonlyMap<string, PreviewEntry>,
	t: number,
	playableItemIds: ReadonlySet<string>
): PreviewFrame {
	const mix = transitionAt(seams, t)
	if (!mix) return SINGLE

	const { window, progress } = mix
	if (!playableItemIds.has(window.outgoing.item.id) || !playableItemIds.has(window.incoming.item.id)) {
		return SINGLE
	}

	const entry = previews.get(window.junctionId)
	if (entry?.status === 'ready' && entry.src) {
		return {
			mode: 'cached',
			window,
			progress,
			cachedSrc: entry.src,
			// The cached file IS the window, so its timeline starts at window.start.
			cachedTime: Math.max(0, t - window.start),
			pending: false
		}
	}

	// No render yet (or it failed): cross-fade the two source elements. Correct
	// duration and timing, approximate motion for anything but a dissolve.
	return { mode: 'blend', window, progress, pending: entry?.status !== 'error' }
}

/**
 * A stable fingerprint of the resolved windows, for the playback engine's
 * re-resolve watcher.
 *
 * That watcher fingerprints the EDL segments, which carry nothing about
 * transitions — so adding, retiming or clearing one produces a byte-identical
 * string and the preview never re-resolves while paused. This closes that hole.
 * Deliberately NOT a watch on `seams` itself, which is a computed that rebuilds
 * on every document change and would fire constantly.
 */
export function seamFingerprint(seams: readonly Seam[]): string {
	return seams
		.map((s) => s.window)
		.filter((w): w is TransitionWindow => !!w)
		.map((w) => `${w.junctionId}|${w.start.toFixed(3)}|${w.end.toFixed(3)}|${w.kind}`)
		.join(',')
}
