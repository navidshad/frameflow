import type { TimelineItem, TransitionRef } from './types'
import { itemDuration, itemEnd } from './timeline'

/**
 * Transition window geometry (ROADMAP Phase 1 §Transitions, item 1).
 * Pure — no Node/Electron imports. Used by BOTH main (export region planning)
 * and the renderer (seam affordance, preview ramp), so what the user is shown
 * can never disagree with what the export produces. Canonical unit: seconds.
 *
 * The model is the pro-NLE one. A transition is an ANNOTATION on a cut, stored
 * on the OUTGOING item as `transition.out`; no item ever moves and the sequence
 * length never changes. The window straddles the cut, and the extra frames each
 * side needs come from its HANDLES — source media trimmed away beyond in/out.
 *
 * Where a handle runs out, the boundary frame is REPEATED rather than the
 * transition being refused (Premiere's behaviour). That matters because a clip
 * dragged straight onto the timeline has no handles at all, which is exactly
 * what a beginner's project looks like — refusing there would make the feature
 * appear broken.
 */

export const MIN_TRANSITION_SEC = 0.1     // below this a junction renders as a plain cut
export const MAX_TRANSITION_SEC = 5       // UI ceiling; also clamps a hand-edited document
export const DEFAULT_TRANSITION_SEC = 2   // matches Filmora's default
export const JUNCTION_GAP_EPS = 0.05      // adjacency tolerance; mirrors GAP_EPS in render.ts

/** Float slack. Anything smaller is zero — a femtosecond of freeze is not freeze. */
const EPS = 1e-9

const snap = (v: number): number => (v > EPS ? v : 0)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Asset id -> probed source duration. A miss means "no tail handle", never "no transition". */
export type SourceDurations = ReadonlyMap<string, number>

export interface Junction {
	id: string                  // `${outgoing.id}->${incoming.id}` — deterministic, safe as a UI key
	trackId: string
	outgoing: TimelineItem
	incoming: TimelineItem
	cut: number                 // itemEnd(outgoing)
}

export interface JunctionLimits {
	maxDuration: number         // longest window the geometry allows, capped at MAX_TRANSITION_SEC
	freeDuration: number        // longest window that repeats NO frames
	tailHandle: number          // on-timeline seconds available after outgoing.out
	headHandle: number          // on-timeline seconds available before incoming.in
}

export interface TransitionSide {
	/** Carried whole, not copied — same rule as SourceSlice, so no field goes stale. */
	item: TimelineItem
	in: number                  // SOURCE seconds
	out: number
	/** On-timeline seconds of a repeated boundary frame. Outgoing holds its LAST
	 *  frame at the window's end; incoming holds its FIRST frame at the start. */
	freeze: number
}

export interface TransitionWindow {
	junctionId: string
	trackId: string
	kind: string
	cut: number
	start: number               // cut - front
	end: number                 // cut + back; the span is half-open [start, end)
	duration: number            // front + back
	front: number
	back: number
	outgoing: TransitionSide
	incoming: TransitionSide
}

export interface Seam {
	junction: Junction
	limits: JunctionLimits
	/** The annotation on the outgoing clip, if any — present even when it did not resolve. */
	requested?: TransitionRef
	/** Absent when unannotated, or when the geometry cannot reach MIN_TRANSITION_SEC.
	 *  `requested && !window` is the "set, but this cut is too short for it" state,
	 *  which the UI must show rather than silently dropping the badge. */
	window?: TransitionWindow
}

export interface TransitionMix {
	window: TransitionWindow
	/** 0..1 across [start, end). incomingOpacity = progress, outgoingOpacity = 1 - progress. */
	progress: number
}

/**
 * Build the lookup `junctionLimits`/`planTransition` need. Entries are omitted
 * rather than zeroed when unusable, so a lookup miss has ONE meaning everywhere.
 */
export function sourceDurationsFrom(
	media: readonly { id: string; metadata?: { duration?: number } }[]
): Map<string, number> {
	const map = new Map<string, number>()
	for (const asset of media) {
		const duration = asset.metadata?.duration
		if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
			map.set(asset.id, duration)
		}
	}
	return map
}

/**
 * Adjacent same-track pairs, in cut order. The CALLER filters to the tracks it
 * cares about — this module knows nothing about track kinds, so passing an
 * unfiltered timeline would happily pair up audio items.
 */
export function findJunctions(
	items: readonly TimelineItem[],
	gapEps = JUNCTION_GAP_EPS
): Junction[] {
	const byTrack = new Map<string, TimelineItem[]>()
	for (const item of items) {
		if (itemDuration(item) <= 0) continue // zero/inverted ranges cannot carry a window
		const list = byTrack.get(item.trackId) || []
		list.push(item)
		byTrack.set(item.trackId, list)
	}

	const junctions: Junction[] = []
	for (const [trackId, list] of byTrack) {
		const sorted = [...list].sort((a, b) => a.timelineStart - b.timelineStart)
		for (let i = 1; i < sorted.length; i++) {
			const outgoing = sorted[i - 1]
			const incoming = sorted[i]
			// Anchor on the OUTGOING item's end: the annotation lives there, so the
			// window stays put when the incoming clip is nudged within tolerance.
			const cut = itemEnd(outgoing)
			if (Math.abs(incoming.timelineStart - cut) > gapEps) continue
			junctions.push({ id: `${outgoing.id}->${incoming.id}`, trackId, outgoing, incoming, cut })
		}
	}
	return junctions.sort((a, b) => a.cut - b.cut)
}

/** Handles in ON-TIMELINE seconds. Both are floored at 0 — `applyTimelineDiff`
 *  tolerates an out-point slightly past the probed duration, which would
 *  otherwise yield a negative handle and an inverted source range. */
function handles(junction: Junction, sources: SourceDurations): { tail: number; head: number } {
	const { outgoing, incoming } = junction
	// `|| 1`, not `?? 1` — matches itemDuration, so a junk speed of 0 cannot divide by zero.
	const outSpeed = outgoing.speed || 1
	const inSpeed = incoming.speed || 1
	const srcDuration = sources.get(outgoing.sourceAssetId)
	return {
		// Only the TAIL handle needs the asset. The head handle is `in`, which the
		// item already carries — so unprobed media loses half the geometry, not all.
		tail: srcDuration === undefined ? 0 : snap((srcDuration - outgoing.out) / outSpeed),
		head: snap(incoming.in / inSpeed)
	}
}

/**
 * What this junction could support, for the seam affordance shown while dragging.
 *
 * TWO numbers, because repeated frames changed what "longest" means: every seam
 * now supports up to `maxDuration`, so that alone no longer warns about anything.
 * `freeDuration` is the number that does — how long before frames start repeating.
 */
export function junctionLimits(junction: Junction, sources: SourceDurations): JunctionLimits {
	const { tail, head } = handles(junction, sources)
	// A window may never eat more than half of either neighbour. That single rule
	// is what stops two windows sharing a clip from overlapping each other: they
	// can at worst touch at its midpoint, so each junction stays independent.
	const maxFront = itemDuration(junction.outgoing) / 2
	const maxBack = itemDuration(junction.incoming) / 2
	const maxDuration = Math.min(MAX_TRANSITION_SEC, maxFront + maxBack)
	// Freeze-free needs front <= min(maxFront, head) AND back <= min(maxBack, tail),
	// so the reachable no-freeze length is the sum of those — NOT head + tail, which
	// over-reports whenever one clip is too short to spend the handle it has.
	const freeDuration = Math.min(maxDuration, Math.min(maxFront, head) + Math.min(maxBack, tail))
	return { maxDuration, freeDuration, tailHandle: tail, headHandle: head }
}

/**
 * Geometry for one junction at a requested length, or null when it degrades to
 * a plain cut.
 *
 * Choosing where to put the window is a minimisation, not a branch. Total
 * repeated footage as a function of `front` is
 *   F(front) = max(0, front - head) + max(0, (D - front) - tail)
 * which is convex piecewise-linear with kinks at `head` and `D - tail`. Its
 * minimum is the whole interval between those two kinks, in either order — when
 * the handles cover D that interval is the freeze-free range, and when they do
 * not, F is CONSTANT across it (equal to the deficit), so the split decides only
 * where the repeated frames land, never how many there are.
 *
 * So: take the point of that interval nearest the cut, then force it into the
 * geometry. The geometric clamp must come LAST or the half-clip invariant breaks.
 * Freezing where it must, the window stays as centred on the cut as it can be
 * without repeating a frame it did not have to.
 */
export function planTransition(
	junction: Junction,
	ref: TransitionRef,
	sources: SourceDurations
): TransitionWindow | null {
	const requested = Number(ref?.duration)
	if (!Number.isFinite(requested) || requested <= 0) return null

	const limits = junctionLimits(junction, sources)
	const duration = Math.min(requested, limits.maxDuration)
	if (duration < MIN_TRANSITION_SEC) return null

	const { outgoing, incoming } = junction
	const outSpeed = outgoing.speed || 1
	const inSpeed = incoming.speed || 1
	const maxFront = itemDuration(outgoing) / 2
	const maxBack = itemDuration(incoming) / 2

	const lo = Math.max(0, duration - maxBack)   // geometric range for `front`
	const hi = Math.min(duration, maxFront)
	const kinkA = duration - limits.tailHandle   // below this the outgoing clip must repeat
	const kinkB = limits.headHandle              // above this the incoming clip must repeat
	const front = clamp(
		clamp(duration / 2, Math.min(kinkA, kinkB), Math.max(kinkA, kinkB)),
		lo,
		hi
	)
	const back = duration - front

	const incomingFreeze = snap(front - limits.headHandle)
	const outgoingFreeze = snap(back - limits.tailHandle)

	return {
		junctionId: junction.id,
		trackId: junction.trackId,
		kind: ref.kind,
		cut: junction.cut,
		start: junction.cut - front,
		end: junction.cut + back,
		duration,
		front,
		back,
		outgoing: {
			item: outgoing,
			in: outgoing.out - front * outSpeed,
			out: outgoing.out + (back - outgoingFreeze) * outSpeed,
			freeze: outgoingFreeze
		},
		incoming: {
			item: incoming,
			in: incoming.in - (front - incomingFreeze) * inSpeed,
			out: incoming.in + back * inSpeed,
			freeze: incomingFreeze
		}
	}
}

/**
 * Every junction in `items`, each with its limits and its resolved window (if
 * annotated). One sorted list serves all three callers: export takes
 * `seams.flatMap((s) => s.window ?? [])`, the timeline UI draws a hit zone per
 * seam, and the preview passes the whole thing to `transitionAt`.
 */
export function planTransitions(items: readonly TimelineItem[], sources: SourceDurations): Seam[] {
	return findJunctions(items).map((junction) => {
		const limits = junctionLimits(junction, sources)
		const requested = junction.outgoing.transition?.out
		if (!requested) return { junction, limits }
		return { junction, limits, requested, window: planTransition(junction, requested, sources) ?? undefined }
	})
}

/** The blend in flight at time `t`, or null when the playhead is outside every window. */
export function transitionAt(seams: readonly Seam[], t: number): TransitionMix | null {
	for (const seam of seams) {
		const window = seam.window
		if (!window) continue
		if (t >= window.start - EPS && t < window.end) {
			return { window, progress: clamp((t - window.start) / window.duration, 0, 1) }
		}
	}
	return null
}
