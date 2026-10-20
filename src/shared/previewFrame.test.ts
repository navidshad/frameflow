import { describe, expect, it } from 'vitest'
import type { TimelineItem } from './types'
import { planTransitions, type Seam } from './transitionPlan'
import { resolvePreviewFrame, seamFingerprint, type PreviewEntry } from './previewFrame'

// ===== Fixtures =====

const clip = (start: number, over: Partial<TimelineItem> = {}): TimelineItem => {
	const inSec = over.in ?? 5
	const outSec = over.out ?? inSec + 10
	return {
		id: over.id ?? 'x', trackId: 'v1', sourceAssetId: 'a',
		timelineStart: start, in: inSec, out: outSec, speed: 1, preservePitch: true,
		duration: outSec - inSec, ...over
	}
}

/** Two butt-joined clips with handles either side, dissolving at t=10. */
const seams = (duration = 2): Seam[] => planTransitions(
	[
		clip(0, { id: 'A', transition: { out: { kind: 'fade', duration } } }),
		clip(10, { id: 'B' })
	],
	new Map([['a', 100]])
)

const playable = new Set(['A', 'B'])
const ready = (src = 'media://cache/win.mp4'): Map<string, PreviewEntry> =>
	new Map([['A->B', { status: 'ready', src }]])
const rendering = (): Map<string, PreviewEntry> =>
	new Map([['A->B', { status: 'rendering' }]])
const none = (): Map<string, PreviewEntry> => new Map()

// ===== resolvePreviewFrame =====

describe('resolvePreviewFrame — outside a window', () => {
	it('shows one element when no transition is in flight', () => {
		const frame = resolvePreviewFrame(seams(), ready(), 3, playable)
		expect(frame.mode).toBe('single')
		expect(frame.pending).toBe(false)
	})

	it('shows one element on a timeline with no transitions at all', () => {
		const plain = planTransitions([clip(0, { id: 'A' }), clip(10, { id: 'B' })], new Map([['a', 100]]))
		expect(resolvePreviewFrame(plain, none(), 10, playable).mode).toBe('single')
	})

	it('treats the window end as outside', () => {
		// The span is half-open, so the last instant belongs to the next clip.
		expect(resolvePreviewFrame(seams(), ready(), 11, playable).mode).toBe('single')
	})
})

describe('resolvePreviewFrame — the cached render', () => {
	it('plays the rendered window when it is ready', () => {
		const frame = resolvePreviewFrame(seams(), ready(), 10, playable)
		expect(frame.mode).toBe('cached')
		expect(frame.cachedSrc).toBe('media://cache/win.mp4')
		expect(frame.pending).toBe(false)
	})

	it('maps the playhead onto the cached file, which starts at the window', () => {
		// The file contains ONLY the window, so its zero is window.start (9s here).
		expect(resolvePreviewFrame(seams(), ready(), 9, playable).cachedTime).toBeCloseTo(0, 6)
		expect(resolvePreviewFrame(seams(), ready(), 10, playable).cachedTime).toBeCloseTo(1, 6)
		expect(resolvePreviewFrame(seams(), ready(), 10.5, playable).cachedTime).toBeCloseTo(1.5, 6)
	})

	it('never seeks the cached file before its start', () => {
		const frame = resolvePreviewFrame(seams(), ready(), 9, playable)
		expect(frame.cachedTime).toBeGreaterThanOrEqual(0)
	})
})

describe('resolvePreviewFrame — the fallback', () => {
	it('cross-fades while the render is still going, and says it is pending', () => {
		const frame = resolvePreviewFrame(seams(), rendering(), 10, playable)
		expect(frame.mode).toBe('blend')
		expect(frame.pending).toBe(true)
	})

	it('cross-fades when no render has been requested yet', () => {
		expect(resolvePreviewFrame(seams(), none(), 10, playable).mode).toBe('blend')
	})

	it('stops claiming to be pending once the render has failed', () => {
		// A dissolve standing in for a wipe reads as WRONG unless we say it is
		// temporary — and after an error it is not temporary.
		const failed: Map<string, PreviewEntry> = new Map([['A->B', { status: 'error' }]])
		const frame = resolvePreviewFrame(seams(), failed, 10, playable)
		expect(frame.mode).toBe('blend')
		expect(frame.pending).toBe(false)
	})

	it('ramps linearly across the window', () => {
		expect(resolvePreviewFrame(seams(), none(), 9, playable).progress).toBeCloseTo(0, 6)
		expect(resolvePreviewFrame(seams(), none(), 10, playable).progress).toBeCloseTo(0.5, 6)
		expect(resolvePreviewFrame(seams(), none(), 10.5, playable).progress).toBeCloseTo(0.75, 6)
	})

	it('does not assume the crossover sits at the cut', () => {
		// An off-centre window (one clip trimmed, the other not) puts the 50/50
		// point away from the cut. A player that assumed otherwise would show the
		// handover in the wrong place.
		const off = planTransitions(
			[
				clip(0, { id: 'A', in: 0, out: 10, transition: { out: { kind: 'fade', duration: 2 } } }),
				clip(10, { id: 'B', in: 0, out: 10 })
			],
			new Map([['a', 11.8]])   // 1.8s of tail handle, no head handle
		)
		const atCut = resolvePreviewFrame(off, none(), 10, playable).progress
		expect(atCut).toBeGreaterThan(0)
		expect(atCut).toBeLessThan(0.5)
	})
})

describe('resolvePreviewFrame — unplayable media', () => {
	it('falls back to one element when a side has no playable source', () => {
		// `seams` keeps items whose media has no resolvable path; the EDL drops
		// them. Blending against a source that will never load shows black.
		expect(resolvePreviewFrame(seams(), ready(), 10, new Set(['A'])).mode).toBe('single')
		expect(resolvePreviewFrame(seams(), ready(), 10, new Set(['B'])).mode).toBe('single')
		expect(resolvePreviewFrame(seams(), ready(), 10, new Set()).mode).toBe('single')
	})
})

// ===== seamFingerprint =====

describe('seamFingerprint', () => {
	it('changes when a transition is added', () => {
		// REGRESSION. The playback engine re-resolves on a fingerprint of the EDL
		// segments, which carry nothing about transitions — so dropping one in
		// produced a byte-identical string and the preview never updated.
		const without = planTransitions([clip(0, { id: 'A' }), clip(10, { id: 'B' })], new Map([['a', 100]]))
		expect(seamFingerprint(seams())).not.toBe(seamFingerprint(without))
	})

	it('changes when the duration changes', () => {
		expect(seamFingerprint(seams(2))).not.toBe(seamFingerprint(seams(3)))
	})

	it('changes when the preset changes', () => {
		const wipe = planTransitions(
			[clip(0, { id: 'A', transition: { out: { kind: 'wipeleft', duration: 2 } } }), clip(10, { id: 'B' })],
			new Map([['a', 100]])
		)
		expect(seamFingerprint(seams(2))).not.toBe(seamFingerprint(wipe))
	})

	it('is stable across rebuilds of the same timeline', () => {
		expect(seamFingerprint(seams())).toBe(seamFingerprint(seams()))
	})

	it('is empty when nothing resolved', () => {
		const plain = planTransitions([clip(0, { id: 'A' }), clip(10, { id: 'B' })], new Map([['a', 100]]))
		expect(seamFingerprint(plain)).toBe('')
	})
})
