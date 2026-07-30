import { describe, expect, it } from 'vitest'
import type { Clip, EditorDocument, EditorPersona, MediaAsset, TimelineItem, Track } from '@shared/types'
import { repairOverlaps } from '@shared/timeline'
import { composeSystemInstruction, opsToDiff, type PromptStats } from './ops'

// ===== Fixtures =====

/** Clips tile the source: piece i starts where i-1 ended, plus `gap` (negative = overlap). */
function makeAsset(id: string, durations: number[], gap = 0): MediaAsset {
	const clips: Clip[] = []
	let cursor = 0
	durations.forEach((duration, i) => {
		clips.push({
			id: `${id}-c${i + 1}`,
			sourceAssetId: id,
			index: i + 1,
			in: cursor,
			out: cursor + duration,
			duration,
			text: `line ${i + 1}`,
			selected: false
		})
		cursor += duration + gap
	})
	return {
		id,
		kind: 'video',
		name: `${id}.mp4`,
		originalPath: `/tmp/${id}.mp4`,
		metadata: { duration: cursor + 10 } as MediaAsset['metadata'],
		preprocessing: {},
		clips,
		createdAt: 0
	}
}

const uniform = (count: number, duration: number) => new Array(count).fill(duration)

function makeDoc(assets: MediaAsset[], timeline: TimelineItem[] = []): EditorDocument {
	const track: Track = {
		id: 'v1', kind: 'video', name: 'V1', order: 0,
		muted: false, locked: false, hidden: false, height: 72
	}
	return {
		schemaVersion: 1,
		media: assets,
		tracks: [track],
		timeline,
		timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 },
		activePersonaId: 'podcast-editor',
		turns: [],
		historyRef: { currentStepId: 'step-0', stepCount: 0 }
	}
}

const items = (result: ReturnType<typeof opsToDiff>) => result.diff.addItems || []

// ===== Range expansion =====

describe('opsToDiff / addSceneRanges', () => {
	it('merges a fully contiguous span into one item', () => {
		const doc = makeDoc([makeAsset('a', uniform(100, 2))])
		const result = opsToDiff({ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 100 }] }, doc)

		expect(items(result)).toHaveLength(1)
		const [item] = items(result)
		expect(item.in).toBe(0)
		expect(item.out).toBe(200)
		expect(item.duration).toBe(200)
		// A merged run maps to no single detected piece.
		expect(item.sourceClipId).toBeUndefined()
		expect(item.masterSegmentIndex).toBeUndefined()
		expect(item.label).toBe('#1–#100 (100 pieces)')
		expect(result.droppedOps).toEqual([])
	})

	it('bridges residual sub-0.5s transcript gaps but not larger ones', () => {
		const bridged = opsToDiff(
			{ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 5 }] },
			makeDoc([makeAsset('a', uniform(5, 2), 0.4)])
		)
		expect(items(bridged)).toHaveLength(1)

		const split = opsToDiff(
			{ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 5 }] },
			makeDoc([makeAsset('a', uniform(5, 2), 0.9)])
		)
		expect(items(split)).toHaveLength(5)
	})

	it('coalesces slightly overlapping pieces without double-counting', () => {
		const doc = makeDoc([makeAsset('a', uniform(5, 2), -0.2)])
		const result = opsToDiff({ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 5 }] }, doc)

		expect(items(result)).toHaveLength(1)
		const [item] = items(result)
		const last = doc.media[0].clips[4]
		expect(item.out).toBeCloseTo(last.out, 6)
		expect(item.duration).toBeCloseTo(item.out - item.in, 6)
	})

	it('breaks the run at an excluded piece even when it is shorter than the gap tolerance', () => {
		// Piece #3 is 0.3s — shorter than MERGE_GAP_TOL_SEC, so a purely time-based
		// adjacency test would silently swallow the excluded dead air back in.
		const doc = makeDoc([makeAsset('a', [2, 2, 0.3, 2, 2])])
		const result = opsToDiff(
			{ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 5, excludeScenes: [3] }] },
			doc
		)

		expect(items(result)).toHaveLength(2)
		const [first, second] = items(result)
		expect(first.in).toBe(0)
		expect(first.out).toBe(4)
		expect(second.in).toBeCloseTo(4.3, 6)
		expect(second.out).toBeCloseTo(8.3, 6)
		// The excluded span is inside neither item.
		const excluded = doc.media[0].clips[2]
		for (const item of items(result)) {
			expect(item.in <= excluded.in && item.out >= excluded.out).toBe(false)
		}
	})

	it('clamps out-of-range endpoints instead of dropping the range', () => {
		const doc = makeDoc([makeAsset('a', uniform(50, 2))])
		const result = opsToDiff({ addSceneRanges: [{ assetId: 'a', fromScene: 0, toScene: 99999 }] }, doc)

		expect(items(result)).toHaveLength(1)
		expect(items(result)[0].in).toBe(0)
		expect(items(result)[0].out).toBe(100)
		expect(result.droppedOps).toEqual([])
		expect(result.notes).toHaveLength(1)
		expect(result.notes[0]).toContain('clamped to #1–#50')
	})

	it('appends ranges back to back with no gaps and no overlaps', () => {
		const doc = makeDoc([makeAsset('a', uniform(4, 2), 0.9), makeAsset('b', uniform(3, 5), 0.9)])
		const result = opsToDiff({
			addSceneRanges: [
				{ assetId: 'a', fromScene: 1, toScene: 4 },
				{ assetId: 'b', fromScene: 1, toScene: 3 }
			]
		}, doc)

		const placed = items(result)
		expect(placed).toHaveLength(7)
		let expected = 0
		for (const item of placed) {
			expect(item.timelineStart).toBeCloseTo(expected, 6)
			expected += item.duration
		}
		// Nothing for the renderer's overlap repair to do.
		expect(repairOverlaps({ tracks: doc.tracks, timeline: placed })).toBe(false)
	})

	it('lets an explicit atSec push later appends after it (cursor never moves back)', () => {
		const doc = makeDoc([makeAsset('a', uniform(2, 2), 0.9), makeAsset('b', uniform(1, 3))])
		const result = opsToDiff({
			addSceneRanges: [
				{ assetId: 'a', fromScene: 1, toScene: 2, atSec: 1000 },
				{ assetId: 'b', fromScene: 1, toScene: 1 }
			]
		}, doc)

		const placed = items(result)
		expect(placed[0].timelineStart).toBe(1000)
		expect(placed[1].timelineStart).toBeCloseTo(1002, 6)
		expect(placed[2].timelineStart).toBeCloseTo(1004, 6)
	})

	it('respects merge: false', () => {
		const doc = makeDoc([makeAsset('a', uniform(4, 2))])
		const result = opsToDiff(
			{ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 4, merge: false }] },
			doc
		)
		expect(items(result)).toHaveLength(4)
		// Unmerged items stay addressable as individual pieces.
		expect(items(result)[0].sourceClipId).toBe('a-c1')
	})
})

// ===== No duplicated footage =====

describe('opsToDiff / source coverage', () => {
	/** A continuation turn: the material is already on the timeline. */
	function timelineFrom(asset: MediaAsset, from: number, to: number): TimelineItem[] {
		const clips = asset.clips.filter((c) => c.index >= from && c.index <= to)
		let start = 0
		return clips.map((c) => {
			const item: TimelineItem = {
				id: `t-${c.index}`, trackId: 'v1', sourceAssetId: asset.id, sourceClipId: c.id,
				timelineStart: start, in: c.in, out: c.out, speed: 1, preservePitch: true, duration: c.duration
			}
			start += c.duration
			return item
		})
	}

	it('skips pieces already on the timeline instead of re-adding them', () => {
		const asset = makeAsset('a', uniform(10, 2))
		const doc = makeDoc([asset], timelineFrom(asset, 1, 5))
		// The model asks for the whole asset again, as a continuation turn would.
		const result = opsToDiff({ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 10 }] }, doc)

		expect(items(result)).toHaveLength(1)
		expect(items(result)[0].in).toBe(10)   // picks up exactly where the cut ended
		expect(items(result)[0].out).toBe(20)
		expect(result.notes.join(' ')).toContain('Skipped 5 pieces')
	})

	it('reports a range that is entirely on the timeline already', () => {
		const asset = makeAsset('a', uniform(4, 2))
		const doc = makeDoc([asset], timelineFrom(asset, 1, 4))
		const result = opsToDiff({ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 4 }] }, doc)

		expect(result.diff.addItems).toBeUndefined()
		expect(result.droppedOps.join(' ')).toContain('already on the timeline')
	})

	it('re-adds material that the same edit removes', () => {
		const asset = makeAsset('a', uniform(4, 2))
		const timeline = timelineFrom(asset, 1, 4)
		const doc = makeDoc([asset], timeline)
		const result = opsToDiff({
			removeItemIds: timeline.map((i) => i.id),
			addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 4 }]
		}, doc)

		// A rebuild must not be blocked by the material it is replacing.
		expect(items(result)).toHaveLength(1)
		expect(items(result)[0].out).toBe(8)
	})

	it('trims overlapping source so a corrupt transcript cannot replay audio', () => {
		// Shape of a speech-to-text repetition loop: each piece overlaps its
		// predecessor by ~2s, far past the coalescing tolerance.
		const clips: Clip[] = []
		for (let i = 1; i <= 6; i++) {
			const start = (i - 1) * 2
			clips.push({
				id: `a-c${i}`, sourceAssetId: 'a', index: i,
				in: start, out: start + 4.3, duration: 4.3, text: 'the same looped line', selected: false
			})
		}
		const asset: MediaAsset = {
			id: 'a', kind: 'video', name: 'loop.mp4', originalPath: '/x',
			metadata: { duration: 100 } as MediaAsset['metadata'], preprocessing: {}, clips, createdAt: 0
		}
		const result = opsToDiff({ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 6 }] }, makeDoc([asset]))

		const placed = items(result)
		// Source spans must be strictly non-overlapping…
		const spans = [...placed].sort((a, b) => a.in - b.in)
		for (let i = 1; i < spans.length; i++) {
			expect(spans[i].in).toBeGreaterThanOrEqual(spans[i - 1].out - 1e-9)
		}
		// …and total no more than the real source they cover.
		const total = placed.reduce((sum, i) => sum + (i.out - i.in), 0)
		expect(total).toBeCloseTo(14.3, 6)
	})
})

// ===== Gaps =====

describe('opsToDiff / gaps', () => {
	/** An asset laid out contiguously on the timeline. */
	function laidOut(asset: MediaAsset): TimelineItem[] {
		let start = 0
		return asset.clips.map((c) => {
			const item: TimelineItem = {
				id: `t-${c.index}`, trackId: 'v1', sourceAssetId: asset.id, sourceClipId: c.id,
				timelineStart: start, in: c.in, out: c.out, speed: 1, preservePitch: true, duration: c.duration
			}
			start += c.duration
			return item
		})
	}
	const startOf = (result: ReturnType<typeof opsToDiff>, id: string) =>
		(result.diff.updateItems || []).find((u) => u.id === id)?.timelineStart

	it('pulls the rest left when items are removed, leaving no hole', () => {
		const asset = makeAsset('a', uniform(4, 5))
		const timeline = laidOut(asset)
		const result = opsToDiff({ removeItemIds: ['t-2'] }, makeDoc([asset], timeline))

		// t-1 stays at 0; t-3 and t-4 each move up by the removed 5s.
		expect(startOf(result, 't-1')).toBeUndefined()
		expect(startOf(result, 't-3')).toBe(5)
		expect(startOf(result, 't-4')).toBe(10)
	})

	it('pulls the rest left when clips are RETIMED, not just removed', () => {
		// What a "make it shorter" edit actually does: speed up many clips. Each
		// one gets shorter and leaves its own hole unless the track follows.
		const asset = makeAsset('a', uniform(4, 10))
		const timeline = laidOut(asset)          // 0, 10, 20, 30
		const result = opsToDiff({
			updateItems: [{ id: 't-1', speed: 2 }, { id: 't-2', speed: 2 }]
		}, makeDoc([asset], timeline))

		// t-1 and t-2 now play in 5s each, so everything after moves up 10s total.
		expect(startOf(result, 't-2')).toBe(5)
		expect(startOf(result, 't-3')).toBe(10)
		expect(startOf(result, 't-4')).toBe(20)
	})

	it('pulls the rest left when a clip is trimmed shorter', () => {
		const asset = makeAsset('a', uniform(3, 10))
		const timeline = laidOut(asset)
		const result = opsToDiff({
			updateItems: [{ id: 't-1', out: 4 }]   // 10s -> 4s
		}, makeDoc([asset], timeline))

		expect(startOf(result, 't-2')).toBe(4)
		expect(startOf(result, 't-3')).toBe(14)
	})

	it('pushes the rest right when a clip is lengthened', () => {
		const asset = makeAsset('a', uniform(3, 10))
		const timeline = laidOut(asset)
		const result = opsToDiff({
			updateItems: [{ id: 't-1', speed: 0.5 }]   // 10s -> 20s
		}, makeDoc([asset], timeline))

		expect(startOf(result, 't-2')).toBe(20)
		expect(startOf(result, 't-3')).toBe(30)
	})

	it('combines removals and retimes in one pass', () => {
		const asset = makeAsset('a', uniform(4, 10))
		const timeline = laidOut(asset)
		const result = opsToDiff({
			removeItemIds: ['t-1'],                  // frees 10s at 0
			updateItems: [{ id: 't-2', speed: 2 }]   // frees 5s at 10
		}, makeDoc([asset], timeline))

		expect(startOf(result, 't-2')).toBe(0)
		expect(startOf(result, 't-3')).toBe(5)
		expect(startOf(result, 't-4')).toBe(15)
	})

	it('closes an existing gap on request', () => {
		const asset = makeAsset('a', uniform(3, 5))
		const timeline = laidOut(asset)
		timeline[1].timelineStart = 40      // a hole the user is complaining about
		timeline[2].timelineStart = 45
		const result = opsToDiff({ closeGaps: true }, makeDoc([asset], timeline))

		expect(startOf(result, 't-2')).toBe(5)
		expect(startOf(result, 't-3')).toBe(10)
		expect(result.notes.join(' ')).toContain('Closed the gaps')
	})

	it('does not shift items the model positioned itself', () => {
		// The model rewriting timelineStart means it is doing the layout; adding
		// an automatic ripple on top would move its work twice.
		const asset = makeAsset('a', uniform(3, 5))
		const timeline = laidOut(asset)
		const result = opsToDiff({
			removeItemIds: ['t-1'],
			updateItems: [{ id: 't-2', timelineStart: 0 }, { id: 't-3', timelineStart: 5 }]
		}, makeDoc([asset], timeline))

		expect(startOf(result, 't-2')).toBe(0)
		expect(startOf(result, 't-3')).toBe(5)
	})

	it('leaves a contiguous timeline untouched', () => {
		const asset = makeAsset('a', uniform(3, 5))
		const result = opsToDiff({ closeGaps: true }, makeDoc([asset], laidOut(asset)))
		expect(result.diff.updateItems).toBeUndefined()
	})
})

// ===== Markers =====

describe('opsToDiff / atScene markers', () => {
	it('interpolates a marker inside a merged, retimed run', () => {
		const doc = makeDoc([makeAsset('a', uniform(10, 20))])
		const result = opsToDiff({
			addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 10, speed: 1.25 }],
			addMarkers: [{ atScene: { assetId: 'a', sceneIndex: 5 }, label: 'Topic 2' }]
		}, doc)

		expect(items(result)).toHaveLength(1)
		// Piece #5 starts 80s into the source; at 1.25x that is 64s on the timeline.
		expect(result.addMarkers).toEqual([{ time: 64, label: 'Topic 2' }])
	})

	it('drops an unplaceable marker rather than guessing a position', () => {
		const doc = makeDoc([makeAsset('a', uniform(10, 2))])
		const result = opsToDiff({
			addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 3 }],
			addMarkers: [{ atScene: { assetId: 'a', sceneIndex: 9 }, label: 'Nowhere' }]
		}, doc)

		expect(result.addMarkers).toEqual([])
		expect(result.droppedOps.join(' ')).toContain('is not on the timeline')
	})
})

// ===== Duration contract =====

describe('composeSystemInstruction', () => {
	const longform: EditorPersona = {
		id: 'podcast-editor', name: 'Podcast Editor', icon: '🎙️', description: '',
		systemPrompt: 'You are a seasoned podcast editor.', builtin: true, mode: 'longform',
		defaults: { targetDurationSec: null }
	}
	const summarizer: EditorPersona = {
		id: 'concise', name: 'Concise', icon: '✂️', description: '',
		systemPrompt: 'You summarize.', builtin: true, mode: 'summarize',
		defaults: { targetDurationSec: 60 }
	}
	const stats = (over: Partial<PromptStats>): PromptStats => ({
		timelineItemCount: 0, timelineDurationSec: 0,
		sourceDurationSec: 5535, sourceClipCount: 1899, mode: 'longform', ...over
	})

	it('tells a longform persona to BUILD when the timeline is empty', () => {
		const text = composeSystemInstruction(longform, stats({}))
		expect(text).toContain('BUILD THE FULL-LENGTH cut')
		expect(text).toContain('92:15')
		expect(text).toContain('1899 detected pieces')
		expect(text).toContain('addSceneRanges')
		expect(text).not.toContain('PRESERVE the full runtime')
	})

	it('tells a longform persona to PRESERVE an existing cut', () => {
		const text = composeSystemInstruction(longform, stats({ timelineItemCount: 28, timelineDurationSec: 339 }))
		expect(text).toContain('PRESERVE the full runtime of the current cut (28 items, 5:39)')
		// Short cut + lots of unused source => it is told how to extend.
		expect(text).toContain('APPEND the missing material')
	})

	it('keeps the summarize target line byte-identical', () => {
		const text = composeSystemInstruction(summarizer, stats({ mode: 'summarize' }))
		expect(text).toContain('Target output duration: about 60 seconds. Cut toward this target.')
		expect(text).not.toContain('BUILD THE FULL-LENGTH')
	})
})
