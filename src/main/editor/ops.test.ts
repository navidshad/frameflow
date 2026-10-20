import { describe, expect, it } from 'vitest'
import type { Clip, EditorDocument, EditorPersona, MediaAsset, TimelineItem, Track } from '@shared/types'
import { repairOverlaps, TIMELINE_DIFF_SCHEMA_VERSION } from '@shared/timeline'
import {
	composeSystemInstruction, EDITOR_OPS_SCHEMA, editorOpsSchema, measureBuild, opsToDiff, opsWriteHtml,
	parseTargetLength, routeSurveyResponse, sumUsage, type PromptStats
} from './ops'
import { BLANK_MOTION_HTML, motionTemplate, newMotionSpec, renderVersion, resolveDefinition } from '@shared/motion'
import { writtenSpec } from '@shared/motionCode'
import { setUserMotionTemplates } from '@shared/motionTemplates'

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

	it('keeps every free slice when covered material sits in the middle of a piece', () => {
		// One 20s piece with 8-12s already on the timeline must contribute BOTH
		// 0-8 and 12-20. Keeping only the longest slice silently loses footage.
		const asset = makeAsset('a', [20])
		const existing: TimelineItem = {
			id: 't-mid', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0,
			in: 8, out: 12, speed: 1, preservePitch: true, duration: 4
		}
		const result = opsToDiff(
			{ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 1 }] },
			makeDoc([asset], [existing])
		)

		const spans = items(result).map((i) => [i.in, i.out]).sort((a, b) => a[0] - b[0])
		expect(spans).toEqual([[0, 8], [12, 20]])
	})

	it('does not merge across a covered hole', () => {
		// Pieces 1-4 contiguous, with piece 2's source already on the timeline.
		// The survivors must NOT merge into one span that replays piece 2.
		const asset = makeAsset('a', uniform(4, 5))
		const existing: TimelineItem = {
			id: 't-2', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0,
			in: 5, out: 10, speed: 1, preservePitch: true, duration: 5
		}
		const result = opsToDiff(
			{ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 4 }] },
			makeDoc([asset], [existing])
		)

		for (const item of items(result)) {
			expect(item.in <= 5 && item.out >= 10).toBe(false)
		}
	})

	it('appends after the target track only, ignoring an audio bed', () => {
		// A music bed on A1 must not push the video assembly to the end of it.
		const asset = makeAsset('a', uniform(2, 5))
		const musicAsset = makeAsset('m', [150])
		const music: TimelineItem = {
			id: 'music', trackId: 'a1', sourceAssetId: 'm', timelineStart: 0,
			in: 0, out: 150, speed: 1, preservePitch: true, duration: 150
		}
		const doc = makeDoc([asset, musicAsset], [music])
		doc.tracks = [
			...doc.tracks,
			{ id: 'a1', kind: 'audio', name: 'A1', order: 1, muted: false, locked: false, hidden: false, height: 72 }
		]
		const result = opsToDiff({ addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 2 }] }, doc)

		expect(items(result)[0].timelineStart).toBe(0)
	})

	it('appends after survivors, not after items this edit removes', () => {
		const asset = makeAsset('a', uniform(4, 5))
		const existing: TimelineItem[] = [0, 1].map((k) => ({
			id: `t-${k + 1}`, trackId: 'v1', sourceAssetId: 'a', timelineStart: k * 5,
			in: k * 5, out: k * 5 + 5, speed: 1, preservePitch: true, duration: 5
		}))
		const result = opsToDiff({
			removeItemIds: ['t-2'],
			addSceneRanges: [{ assetId: 'a', fromScene: 3, toScene: 3 }]
		}, makeDoc([asset], existing))

		// t-1 survives at 0-5, so the add lands at 5 — not at 10.
		expect(items(result)[0].timelineStart).toBe(5)
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

	it('still ripples everything the model did NOT position', () => {
		// One deliberate nudge must not switch gap-closing off for the whole edit:
		// that is how a 200-clip retime ended up with 200 holes.
		const asset = makeAsset('a', uniform(6, 5))
		const timeline = laidOut(asset)          // 0,5,10,15,20,25
		const result = opsToDiff({
			removeItemIds: ['t-1', 't-2'],           // frees 10s at the front
			updateItems: [{ id: 't-6', timelineStart: 55 }]   // one pinned clip
		}, makeDoc([asset], timeline))

		expect(startOf(result, 't-3')).toBe(0)
		expect(startOf(result, 't-4')).toBe(5)
		expect(startOf(result, 't-5')).toBe(10)
		expect(startOf(result, 't-6')).toBe(55)   // stays where the model put it
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

// ===== Output-length contract =====

describe('composeSystemInstruction', () => {
	const persona: EditorPersona = {
		id: 'general-editor', name: 'Video Editor', icon: '🎬', description: '',
		systemPrompt: 'You are a capable, general-purpose video editor.', builtin: true,
		defaults: { pacing: 'balanced' }
	}
	// A persona whose prose leans short — it must NOT force a short output.
	const summarizer: EditorPersona = {
		id: 'concise', name: 'Concise', icon: '✂️', description: '',
		systemPrompt: 'You summarize.', builtin: true,
		defaults: { pacing: 'tight' }
	}
	const stats = (over: Partial<PromptStats>): PromptStats => ({
		timelineItemCount: 0, timelineDurationSec: 0,
		sourceDurationSec: 5535, sourceClipCount: 1899, ...over
	})

	it('tells the model to infer the length from the request', () => {
		const text = composeSystemInstruction(persona, stats({}))
		expect(text).toContain('=== OUTPUT LENGTH ===')
		expect(text).toContain('Work out the intended length from the request')
		expect(text).toContain('targetLength')
	})

	it('defaults to a full-length build when the timeline is empty', () => {
		const text = composeSystemInstruction(persona, stats({}))
		expect(text).toContain('The timeline is EMPTY')
		expect(text).toContain('92:15')
		expect(text).toContain('1899 detected pieces')
		expect(text).toContain('addSceneRanges')
		expect(text).not.toContain('PRESERVE that runtime')
	})

	it('defaults to preserving an existing cut', () => {
		const text = composeSystemInstruction(persona, stats({ timelineItemCount: 28, timelineDurationSec: 339 }))
		expect(text).toContain('The current cut is 28 items, 5:39')
		expect(text).toContain('PRESERVE that runtime')
		// Short cut + lots of unused source => it is told how to extend.
		expect(text).toContain('APPEND the missing material')
	})

	it('says the request wins over the persona\'s habit', () => {
		expect(composeSystemInstruction(persona, stats({}))).toContain('the request wins')
	})

	it('still reports tone and pacing', () => {
		expect(composeSystemInstruction(persona, stats({}))).toContain('Pacing: balanced')
	})

	// The whole point of deleting modes: no persona shape can preset a runtime.
	it('never emits a preset duration target, whatever the persona', () => {
		for (const p of [persona, summarizer]) {
			const text = composeSystemInstruction(p, stats({}))
			expect(text).not.toContain('Target output duration')
			expect(text).not.toContain('Target aspect ratio')
		}
	})
})

describe('measureBuild', () => {
	// One 92:15 source (makeAsset sets metadata.duration = total + 10).
	const doc = makeDoc([makeAsset('a', [5525])], [])
	// One 12-minute item out of a 92-minute source.
	const diff = {
		schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION,
		addItems: [{
			id: 'i1', trackId: doc.tracks[0].id, sourceAssetId: 'a',
			timelineStart: 0, in: 0, out: 724, speed: 1, preservePitch: true, duration: 724
		}]
	} as any
	const stats = (over: Partial<PromptStats> = {}): PromptStats => ({
		timelineItemCount: 0, timelineDurationSec: 0,
		sourceDurationSec: 5535, sourceClipCount: 1899, ...over
	})

	it('flags a short build-from-scratch when the model stated no target', () => {
		const build = measureBuild(diff, doc, stats())
		expect(build?.producedSec).toBeCloseTo(724, 3)
		expect(build?.sourceSec).toBe(5535)
		expect(build?.targetSec).toBeUndefined()
		expect(build?.shortfall).toBe(true)
	})

	// The reason targetLength exists: a deliberate short cut must not nag.
	it('does not flag the same cut when the model asked for that length', () => {
		const build = measureBuild(diff, doc, stats(), 720)
		expect(build?.targetSec).toBe(720)
		expect(build?.shortfall).toBe(false)
	})

	it('flags a cut that misses the model\'s own stated target', () => {
		expect(measureBuild(diff, doc, stats(), 3000)?.shortfall).toBe(true)
	})

	it('does not flag short sources on the source heuristic', () => {
		// 8 minutes of source: cutting it hard is a normal editorial choice.
		expect(measureBuild(diff, doc, stats({ sourceDurationSec: 480 }))?.shortfall).toBe(false)
	})

	it('reports length for an edit to an existing cut without flagging it', () => {
		const build = measureBuild(diff, doc, stats({ timelineItemCount: 12, timelineDurationSec: 5000 }))
		expect(build?.producedSec).toBeGreaterThan(0)
		expect(build?.shortfall).toBe(false)
	})

	it('returns undefined with no diff or no known source', () => {
		expect(measureBuild(undefined, doc, stats())).toBeUndefined()
		expect(measureBuild(diff, doc, stats({ sourceDurationSec: 0 }))).toBeUndefined()
	})

	// opsToDiff always returns a diff OBJECT, so an answer-only turn used to be
	// measured as producedSec 0 + shortfall true — an empty warning banner on a
	// turn that proposed nothing.
	it('returns undefined for a diff that carries no operations (answer-only turn)', () => {
		expect(measureBuild({ schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION }, doc, stats())).toBeUndefined()
		expect(measureBuild(
			{ schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION, addItems: [], updateItems: [], removeItemIds: [] },
			doc, stats()
		)).toBeUndefined()
	})
})

describe('editorOpsSchema', () => {
	const props = (hasItems: boolean) => Object.keys(editorOpsSchema(hasItems).properties as any)

	it('offers the item-mutating ops when the timeline has items', () => {
		expect(props(true)).toEqual(expect.arrayContaining(['updateItems', 'removeItemIds', 'closeGaps']))
	})

	// The observed failure this guards: on an empty timeline the model emitted
	// updateItems against invented ids and added nothing at all.
	it('removes them on an empty timeline, leaving only ways to ADD', () => {
		const p = props(false)
		expect(p).not.toContain('updateItems')
		expect(p).not.toContain('removeItemIds')
		expect(p).not.toContain('closeGaps')
		expect(p).toEqual(expect.arrayContaining(['addSceneRanges', 'addClips', 'targetLength']))
	})

	it('does not mutate the shared schema constant', () => {
		editorOpsSchema(false)
		expect(Object.keys(EDITOR_OPS_SCHEMA.properties as any)).toContain('updateItems')
	})
})

describe('editorOpsSchema / expandRegions offer', () => {
	const props = (hasItems: boolean, offer: boolean) =>
		Object.keys(editorOpsSchema(hasItems, offer).properties as any)

	it('is absent unless explicitly offered (pass 2 and small band stay clean)', () => {
		expect(props(true, false)).not.toContain('expandRegions')
		expect(props(false, false)).not.toContain('expandRegions')
		// Default arg — the pre-banding call sites are unchanged.
		expect(Object.keys(editorOpsSchema(true).properties as any)).not.toContain('expandRegions')
	})

	it('appears only in the offered call, composing with the empty-timeline cut', () => {
		expect(props(true, true)).toContain('expandRegions')
		const empty = props(false, true)
		expect(empty).toContain('expandRegions')
		expect(empty).not.toContain('updateItems')
	})

	it('does not mutate the shared schema constant', () => {
		editorOpsSchema(false, true)
		expect(Object.keys(EDITOR_OPS_SCHEMA.properties as any)).not.toContain('expandRegions')
	})
})

describe('routeSurveyResponse', () => {
	const regions = [{ assetId: 'a', fromPiece: 10, toPiece: 40 }]

	it('finalizes when there is nothing to expand', () => {
		expect(routeSurveyResponse({}, false).kind).toBe('final')
		expect(routeSurveyResponse(null, true).kind).toBe('final')
		expect(routeSurveyResponse({ addClips: [{ assetId: 'a', sceneIndex: 1 }] }, false).kind).toBe('final')
	})

	it('lets an answer win over a region request — a question needs no detail', () => {
		const route = routeSurveyResponse({ answer: 'It is a podcast.', expandRegions: regions }, false)
		expect(route.kind).toBe('final')
		// The skipped read is surfaced, not silent.
		expect(route.note).toBeTruthy()
		expect(routeSurveyResponse({ answer: 'Just an answer.' }, false).note).toBeUndefined()
	})

	it('expands on a clean region request, whatever the timeline state', () => {
		expect(routeSurveyResponse({ expandRegions: regions }, false).kind).toBe('expand')
		expect(routeSurveyResponse({ expandRegions: regions }, true).kind).toBe('expand')
	})

	// The tie-break for a hedged response is keyed on timeline state: an empty
	// timeline is the blind-coarse-cut hazard, an existing one is the
	// double-billing hazard.
	it('lets regions win over hedged ops on an EMPTY timeline, with a note', () => {
		const route = routeSurveyResponse(
			{ expandRegions: regions, addSceneRanges: [{ assetId: 'a', fromScene: 1, toScene: 99 }] },
			false
		)
		expect(route.kind).toBe('expand')
		expect(route.note).toBeTruthy()
	})

	it('lets real ops win over a region request on an EXISTING timeline, with a note', () => {
		const route = routeSurveyResponse(
			{ expandRegions: regions, removeItemIds: ['item-1'] },
			true
		)
		expect(route.kind).toBe('final')
		expect(route.kind === 'final' && route.ops.removeItemIds).toEqual(['item-1'])
		expect(route.note).toBeTruthy()
	})
})

describe('sumUsage', () => {
	it('sums field-wise and treats missing thinkingTokens as zero', () => {
		expect(sumUsage([
			{ promptTokens: 100, candidatesTokens: 10, thinkingTokens: 5, totalTokens: 115 },
			{ promptTokens: 200, candidatesTokens: 20, totalTokens: 220 }
		])).toEqual({ promptTokens: 300, candidatesTokens: 30, thinkingTokens: 5, totalTokens: 335 })
	})
})

describe('composeSystemInstruction / survey phases', () => {
	const persona: EditorPersona = {
		id: 'general-editor', name: 'Video Editor', icon: '🎬', description: '',
		systemPrompt: 'You are a capable, general-purpose video editor.', builtin: true,
		defaults: { pacing: 'balanced' }
	}
	const stats: PromptStats = {
		timelineItemCount: 0, timelineDurationSec: 0,
		sourceDurationSec: 5535, sourceClipCount: 1899
	}

	it('says nothing about surveys without a phase — small sources are untouched', () => {
		const text = composeSystemInstruction(persona, stats)
		expect(text).not.toContain('CONDENSED SURVEY')
		expect(text).not.toContain('DETAIL VIEW')
		expect(text).not.toContain('expandRegions')
		// The per-piece arithmetic keeps its original wording.
		expect(text).toContain('Pick them with `addClips`')
	})

	it('replaces the pick-pieces arithmetic with the expand instruction in the survey pass', () => {
		const text = composeSystemInstruction(persona, stats, 'survey')
		expect(text).toContain('CONDENSED SURVEY')
		expect(text).toContain('expandRegions')
		// The blind-curation instruction must NOT survive into the survey pass.
		expect(text).not.toContain('Pick them with `addClips`')
		// Cleanups keep their one-pass path: silence #s come from the survey rows.
		expect(text).toContain('excludeScenes')
	})

	// The addendum's middle bullet must agree with the OUTPUT LENGTH branch: on
	// an existing cut, "cover the source with addSceneRanges" reads as "rebuild",
	// which SourceCoverage turns into a no-op or an unwanted append.
	it('tells an existing-cut survey turn to edit items, not rebuild with ranges', () => {
		const text = composeSystemInstruction(
			persona, { ...stats, timelineItemCount: 267, timelineDurationSec: 3600 }, 'survey')
		expect(text).toContain('EXISTING cut')
		expect(text).toContain('only to APPEND')
		expect(text).not.toContain('build it NOW')
	})

	it('tells the detail pass to commit, with the arithmetic restored', () => {
		const text = composeSystemInstruction(persona, stats, 'detail')
		expect(text).toContain('DETAIL VIEW')
		expect(text).toContain('is not available in this response')
		expect(text).toContain('Pick them with `addClips`')
		expect(text).not.toContain('CONDENSED SURVEY')
	})
})

describe('parseTargetLength', () => {
	it('parses plain seconds, decimals, and clock formats', () => {
		expect(parseTargetLength('120')).toBe(120)
		expect(parseTargetLength('120.5')).toBe(120.5)
		expect(parseTargetLength('2:00')).toBe(120)
		expect(parseTargetLength(' 12:30 ')).toBe(750)
		expect(parseTargetLength('1:02:03')).toBe(3723)
	})

	// The digit-run artifact this field's string-typing exists to survive: a
	// looped value must read as "not reported", never as an absurd target.
	it('rejects garbage instead of clamping it', () => {
		expect(parseTargetLength('1200000000000000')).toBeUndefined()
		expect(parseTargetLength('120.05221111111111111111111111111')).toBe(120.05221111111111)
		expect(parseTargetLength('0')).toBeUndefined()
		expect(parseTargetLength('')).toBeUndefined()
		expect(parseTargetLength('two minutes')).toBeUndefined()
		expect(parseTargetLength('1:2:3:4')).toBeUndefined()
		expect(parseTargetLength(undefined)).toBeUndefined()
	})
})

// ===== Look, sound and text ops (Phase 4) =====

describe('opsToDiff / transitions', () => {
	const doc = () => makeDoc([makeAsset('a', uniform(3, 2))], [
		{ id: 'i1', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 2, speed: 1, preservePitch: true, duration: 2 },
		{ id: 'i2', trackId: 'v1', sourceAssetId: 'a', timelineStart: 2, in: 2, out: 4, speed: 1, preservePitch: true, duration: 2 }
	])

	it('attaches to the outgoing item, which is where the document keeps it', () => {
		const { diff } = opsToDiff({ setTransitions: [{ afterItemId: 'i1', kind: 'fade', durationSec: 1 }] }, doc())
		expect(diff.updateItems).toEqual([{ id: 'i1', transition: { out: { kind: 'fade', duration: 1 } } }])
	})

	it('refuses a kind this ffmpeg build cannot render', () => {
		// Better a dropped op than an export that fails after the user waits.
		const { diff, droppedOps } = opsToDiff({ setTransitions: [{ afterItemId: 'i1', kind: 'teleport' }] }, doc())
		expect(diff.updateItems).toBeUndefined()
		expect(droppedOps[0]).toContain('unknown kind')
	})

	it('clamps a duration rather than dropping it', () => {
		const { diff } = opsToDiff({ setTransitions: [{ afterItemId: 'i1', kind: 'fade', durationSec: 900 }] }, doc())
		expect(diff.updateItems![0].transition!.out!.duration).toBe(5)
	})

	it('removes one when asked for "none"', () => {
		const { diff } = opsToDiff({ setTransitions: [{ afterItemId: 'i1', kind: 'none' }] }, doc())
		expect(diff.updateItems).toEqual([{ id: 'i1', transition: undefined }])
	})

	it('drops an unknown item instead of inventing it', () => {
		const { droppedOps } = opsToDiff({ setTransitions: [{ afterItemId: 'nope', kind: 'fade' }] }, doc())
		expect(droppedOps[0]).toContain('unknown item')
	})
})

describe('opsToDiff / looks', () => {
	const doc = () => makeDoc([makeAsset('a', uniform(2, 2))], [
		{ id: 'i1', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 2, speed: 1, preservePitch: true, duration: 2 }
	])

	it('applies a look with the effect’s own neutral defaults filled in', () => {
		const { diff } = opsToDiff({ applyLook: [{ itemIds: ['i1'], kind: 'look-vintage' }] }, doc())
		expect(diff.updateItems![0].effects![0].kind).toBe('look-vintage')
	})

	it('takes the parameters it was given', () => {
		const { diff } = opsToDiff(
			{ applyLook: [{ itemIds: ['i1'], kind: 'saturation', params: { amount: 0 } }] },
			doc()
		)
		expect(diff.updateItems![0].effects![0].params).toEqual({ amount: 0 })
	})

	it('stacks two looks in one response rather than the second replacing the first', () => {
		const { diff } = opsToDiff({
			applyLook: [
				{ itemIds: ['i1'], kind: 'look-vintage' },
				{ itemIds: ['i1'], kind: 'sharpen', params: { amount: 1 } }
			]
		}, doc())
		expect(diff.updateItems![0].effects!.map((e) => e.kind)).toEqual(['look-vintage', 'sharpen'])
	})

	it('refuses an effect that is not in the catalogue', () => {
		const { diff, droppedOps } = opsToDiff({ applyLook: [{ itemIds: ['i1'], kind: 'make-it-pop' }] }, doc())
		expect(diff.updateItems).toBeUndefined()
		expect(droppedOps[0]).toContain('unknown effect')
	})

	it('clears, then applies, when asked to do both', () => {
		const withLook = doc()
		withLook.timeline[0].effects = [{ id: 'old', kind: 'blur', params: { radius: 5 } }]
		const { diff } = opsToDiff({
			clearLooks: ['i1'],
			applyLook: [{ itemIds: ['i1'], kind: 'look-punch' }]
		}, withLook)
		expect(diff.updateItems![0].effects!.map((e) => e.kind)).toEqual(['look-punch'])
	})
})

describe('opsToDiff / transform', () => {
	const doc = () => makeDoc([makeAsset('a', uniform(2, 2))], [
		{ id: 'i1', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 2, speed: 1, preservePitch: true, duration: 2 }
	])

	it('clamps to the range a person could reach with the sliders', () => {
		const { diff } = opsToDiff(
			{ updateItems: [{ id: 'i1', transform: { scale: 999, x: -99 } }] },
			doc()
		)
		expect(diff.updateItems![0].transform).toEqual({ x: -1.5, y: 0, scale: 5, rotation: 0 })
	})

	it('drops a transform that changes nothing', () => {
		const { diff } = opsToDiff({ updateItems: [{ id: 'i1', transform: { scale: 1 } }] }, doc())
		expect(diff.updateItems![0].transform).toBeUndefined()
	})

	it('takes a fill framing with a clamped pan', () => {
		const { diff } = opsToDiff({ updateItems: [{ id: 'i1', framing: { mode: 'fill', pan: 8 } }] }, doc())
		expect(diff.updateItems![0].framing).toEqual({ mode: 'fill', pan: 1 })
	})
})

describe('opsToDiff / titles and settings', () => {
	const doc = () => makeDoc([makeAsset('a', uniform(2, 2))])

	it('makes a title track when the project has none', () => {
		const { diff } = opsToDiff({ addTitles: [{ text: 'Chapter One', atSec: 4 }] }, doc())
		expect(diff.addTracks).toHaveLength(1)
		// A named VIDEO lane: titles render from any track, and a kind of their
		// own is what used to strand them somewhere nothing could move.
		expect(diff.addTracks![0].kind).toBe('video')
		expect(diff.addTracks![0].name).toBe('T1')
		const title = diff.addItems!.find((i) => i.text)
		expect(title!.text!.content).toBe('Chapter One')
		expect(title!.timelineStart).toBe(4)
		expect(title!.duration).toBe(3)
	})

	it('reuses a title track that already exists', () => {
		const withTrack = doc()
		withTrack.tracks.push({ id: 't1', kind: 'video', name: 'T1', order: 1, muted: false, locked: false, hidden: false, height: 40 })
		const { diff } = opsToDiff({ addTitles: [{ text: 'Hi', atSec: 0 }] }, withTrack)
		expect(diff.addTracks).toBeUndefined()
		expect(diff.addItems![0].trackId).toBe('t1')
	})

	it('clamps a position that would land off the frame', () => {
		const { diff } = opsToDiff({ addTitles: [{ text: 'Hi', atSec: 0, x: 9, y: -9, size: 9 }] }, doc())
		expect(diff.addItems![0].text).toMatchObject({ x: 1, y: 0, size: 0.3 })
	})

	it('drops an empty title', () => {
		const { diff, droppedOps } = opsToDiff({ addTitles: [{ text: '   ', atSec: 0 }] }, doc())
		expect(diff.addItems).toBeUndefined()
		expect(droppedOps[0]).toContain('empty text')
	})

	it('carries project settings beside the diff, not inside it', () => {
		// They live outside TimelineState, exactly as markers do.
		const { diff, docSettings } = opsToDiff({ captions: true, loudness: false }, doc())
		expect(docSettings).toEqual({ captionsEnabled: true, loudnessEnabled: false })
		expect(diff.updateItems).toBeUndefined()
	})

	it('says nothing about settings the model did not mention', () => {
		expect(opsToDiff({}, doc()).docSettings).toEqual({})
	})
})

describe('opsToDiff / one update per item', () => {
	it('merges several ops touching the same clip', () => {
		// Two entries for one id would make the diff order-dependent.
		const doc = makeDoc([makeAsset('a', uniform(2, 2))], [
			{ id: 'i1', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 2, speed: 1, preservePitch: true, duration: 2 },
			{ id: 'i2', trackId: 'v1', sourceAssetId: 'a', timelineStart: 2, in: 2, out: 4, speed: 1, preservePitch: true, duration: 2 }
		])
		const { diff } = opsToDiff({
			updateItems: [{ id: 'i1', gain: 0.5 }],
			setTransitions: [{ afterItemId: 'i1', kind: 'fade' }],
			applyLook: [{ itemIds: ['i1'], kind: 'look-soft' }]
		}, doc)
		expect(diff.updateItems).toHaveLength(1)
		expect(diff.updateItems![0]).toMatchObject({ id: 'i1', gain: 0.5 })
		expect(diff.updateItems![0].transition).toBeDefined()
		expect(diff.updateItems![0].effects).toHaveLength(1)
	})
})

describe('composeSystemInstruction / persona style', () => {
	const stats: PromptStats = {
		timelineItemCount: 0, timelineDurationSec: 0, sourceDurationSec: 600, sourceClipCount: 10
	}
	const persona = (style?: EditorPersona['style']): EditorPersona => ({
		id: 'p', name: 'P', icon: '🎬', description: '', systemPrompt: 'be a good editor',
		builtin: true, tone: 'neutral', defaults: { pacing: 'balanced' }, featureSets: [], style
	})

	it('says nothing when a persona has no house style', () => {
		const text = composeSystemInstruction(persona(), stats)
		expect(text).not.toContain('House style')
		expect(text).not.toContain('Preferred transitions')
	})

	it('quotes the style as habits, not limits', () => {
		// A persona confined to four transitions would be a worse editor than one
		// that knows which four it likes.
		const text = composeSystemInstruction(persona({
			transitions: ['fade'], looks: ['look-soft'], captions: true, loudness: true,
			note: 'Sound first.'
		}), stats)
		expect(text).toContain('House style: Sound first.')
		expect(text).toContain('Preferred transitions: fade')
		expect(text).toContain('Signature looks: look-soft')
		expect(text).toContain('`captions: true`')
		expect(text).toContain('`loudness: true`')
		expect(text).toContain('not limits')
	})

	it('says explicitly when a voice does NOT caption', () => {
		// Silence would read as "no opinion", and the model would guess.
		const text = composeSystemInstruction(persona({ captions: false }), stats)
		expect(text).toContain('not usually captioned')
	})
})

describe('the built-in personas', () => {
	it('every style names kinds that actually exist', async () => {
		// A persona pointing at a kind the catalogue does not have would send the
		// model to write an op that gets dropped.
		const { BUILTIN_PERSONAS } = await import('../constants/personas')
		const { isTransitionKind } = await import('@shared/transitionPresets')
		const { isEffectKind } = await import('@shared/effects')
		for (const p of BUILTIN_PERSONAS) {
			for (const kind of p.style?.transitions ?? []) {
				expect(isTransitionKind(kind), `${p.id}: ${kind}`).toBe(true)
			}
			for (const kind of p.style?.looks ?? []) {
				expect(isEffectKind(kind), `${p.id}: ${kind}`).toBe(true)
			}
		}
	})
})

describe('opsToDiff / removeRanges', () => {
	const doc = () => makeDoc([makeAsset('a', uniform(2, 10))], [
		{ id: 'i1', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 10, speed: 1, preservePitch: true, duration: 10 }
	])

	it('splits a clip to cut a span out of its middle', () => {
		// The whole point: removing a sentence without losing the piece.
		const { diff, notes } = opsToDiff({ removeRanges: [{ fromSec: 3, toSec: 5 }] }, doc())
		expect(diff.removeItemIds).toBeUndefined()
		expect(diff.updateItems![0]).toMatchObject({ id: 'i1', out: 3 })
		expect(diff.addItems![0]).toMatchObject({ timelineStart: 5, in: 5, out: 10 })
		expect(notes[0]).toContain('2.0s')
	})

	it('removes the clip outright when the span covers all of it', () => {
		const { diff } = opsToDiff({ removeRanges: [{ fromSec: 0, toSec: 10 }] }, doc())
		expect(diff.removeItemIds).toEqual(['i1'])
		expect(diff.addItems).toBeUndefined()
	})

	it('says so rather than silently doing nothing', () => {
		const { droppedOps } = opsToDiff({ removeRanges: [{ fromSec: 100, toSec: 120 }] }, doc())
		expect(droppedOps[0]).toContain('nothing on the timeline')
	})

	it('does not act on a clip this same response already removed', () => {
		const { diff } = opsToDiff(
			{ removeItemIds: ['i1'], removeRanges: [{ fromSec: 3, toSec: 5 }] },
			doc()
		)
		expect(diff.removeItemIds).toEqual(['i1'])
		expect(diff.addItems).toBeUndefined()
	})
})

describe('opsToDiff / layers', () => {
	const doc = () => makeDoc([makeAsset('a', uniform(2, 5))], [
		{ id: 'i1', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 5, speed: 1, preservePitch: true, duration: 5 }
	])

	it('takes a key, clamped the way the sliders are', () => {
		const { diff } = opsToDiff({
			updateItems: [{ id: 'i1', key: { kind: 'chroma', colour: '#00FF00', similarity: 9, blend: -1 } }]
		}, doc())
		expect(diff.updateItems![0].key).toMatchObject({
			kind: 'chroma', colour: '#00FF00', similarity: 1, blend: 0
		})
	})

	it('ignores a key kind this build has no filter for', () => {
		const { diff } = opsToDiff(
			{ updateItems: [{ id: 'i1', key: { kind: 'magic' as 'chroma' } }] },
			doc()
		)
		expect(diff.updateItems![0].key).toBeUndefined()
	})

	it('records a layer role, and only a real one', () => {
		expect(opsToDiff({ updateItems: [{ id: 'i1', layerRole: 'subject' }] }, doc())
			.diff.updateItems![0].layerRole).toBe('subject')
		expect(opsToDiff({ updateItems: [{ id: 'i1', layerRole: 'wallpaper' as 'subject' }] }, doc())
			.diff.updateItems).toBeUndefined()
	})

	it('puts a background on its own track below everything', () => {
		// On an existing track it would overlap the footage and the repair would
		// discard it, which is exactly what the UI hit.
		const { diff } = opsToDiff({ addBackgrounds: [{ kind: 'gradient', colour: '#101820' }] }, doc())
		const track = diff.addTracks![0]
		expect(track.name).toBe('BG')
		expect(track.order).toBeLessThan(0)
		expect(diff.addItems![0].generator).toMatchObject({ kind: 'gradient', colour: '#101820' })
		expect(diff.addItems![0].layerRole).toBe('background')
	})

	it('butt-joins several backgrounds rather than stacking them', () => {
		const { diff } = opsToDiff({
			addBackgrounds: [{ durationSec: 4 }, { durationSec: 3 }]
		}, doc())
		expect(diff.addItems!.map((i) => i.timelineStart)).toEqual([0, 4])
	})

	it('falls back to a gradient for a kind it does not have', () => {
		const { diff } = opsToDiff(
			{ addBackgrounds: [{ kind: 'plasma' as 'solid' }] },
			doc()
		)
		expect(diff.addItems![0].generator!.kind).toBe('gradient')
	})

	it('reuses a BG track that already exists', () => {
		const withBg = doc()
		withBg.tracks.push({ id: 'bg', kind: 'video', name: 'BG', order: -1, muted: false, locked: false, hidden: false, height: 48 })
		const { diff } = opsToDiff({ addBackgrounds: [{}] }, withBg)
		expect(diff.addTracks).toBeUndefined()
		expect(diff.addItems![0].trackId).toBe('bg')
	})
})

describe('motion ops', () => {
	const asset = makeAsset('a', uniform(4, 5))
	const clip: TimelineItem = {
		id: 'v', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 20,
		speed: 1, preservePitch: true, duration: 20
	}
	const doc = () => makeDoc([asset], [clip])

	it('places a template on a new M1 track above the footage, at its own length', () => {
		const { diff, droppedOps } = opsToDiff({ addMotion: [{ template: 'lower-third', atSec: 3 }] }, doc())
		expect(droppedOps).toEqual([])
		const track = diff.addTracks![0]
		expect(track).toMatchObject({ name: 'M1', kind: 'video' })
		expect(track.order).toBeGreaterThan(0)
		const item = diff.addItems![0]
		expect(item).toMatchObject({
			trackId: track.id, sourceAssetId: '', timelineStart: 3,
			in: 0, out: 4, duration: 4, speed: 1, label: 'Lower third',
			motion: { template: 'lower-third' }
		})
	})

	it('takes settings as pairs or as a map, typed for each setting', () => {
		const pairs = opsToDiff({ addMotion: [{
			template: 'lower-third', atSec: 0,
			settings: [{ key: 'name', value: 'Navid' }, { key: 'slide', value: '999' }, { key: 'accent', value: '#00ff00' }]
		}] }, doc())
		expect(pairs.diff.addItems![0].motion!.settings).toEqual({ name: 'Navid', slide: 60, accent: '#00FF00' })
		const map = opsToDiff({ addMotion: [{ template: 'stat-counter', atSec: 0, settings: { value: 12 } }] }, doc())
		expect(map.diff.addItems![0].motion!.settings).toEqual({ value: 12 })
	})

	it('says so when a setting does not exist, and keeps the rest', () => {
		const { diff, notes } = opsToDiff({ addMotion: [{ template: 'lower-third', atSec: 0, settings: { name: 'X', sparkle: 'yes' } }] }, doc())
		expect(diff.addItems![0].motion!.settings).toEqual({ name: 'X' })
		expect(notes.join(' ')).toMatch(/no setting "sparkle"/)
	})

	it('drops an unknown template rather than inventing one', () => {
		const { diff, droppedOps } = opsToDiff({ addMotion: [{ template: 'confetti', atSec: 0 }] }, doc())
		expect(diff.addItems).toBeUndefined()
		expect(droppedOps).toEqual(['addMotion: unknown template "confetti"'])
	})

	it('reads a hold as a length, and an explicit duration over it', () => {
		const held = opsToDiff({ addMotion: [{ template: 'lower-third', atSec: 0, moments: { in: 1, hold: 5 } }] }, doc())
		const item = held.diff.addItems![0]
		expect(item.duration).toBeCloseTo(6.4, 9) // in 1 + hold 5 + out 0.4
		expect(item.motion!.moments).toEqual({ in: 1 })
		const fixed = opsToDiff({ addMotion: [{ template: 'lower-third', atSec: 0, durationSec: 3, moments: { hold: 99 } }] }, doc())
		expect(fixed.diff.addItems![0].duration).toBe(3)
	})

	it('never slides a clashing layer later — it stacks it on the next motion track', () => {
		const { diff } = opsToDiff({ addMotion: [
			{ template: 'lower-third', atSec: 3 },
			{ template: 'callout-ring', atSec: 4 },
			{ template: 'chapter-card', atSec: 8 }
		] }, doc())
		expect(diff.addTracks!.map((t) => t.name)).toEqual(['M1', 'M2'])
		const [a, b, c] = diff.addItems!
		expect(a.trackId).toBe(diff.addTracks![0].id)
		expect(b.trackId).toBe(diff.addTracks![1].id)
		expect(b.timelineStart).toBe(4)
		expect(c.trackId).toBe(diff.addTracks![0].id) // free again by 8s
	})

	it('reuses an M1 that already exists', () => {
		const withM1 = doc()
		withM1.tracks.push({ id: 'm', kind: 'video', name: 'M1', order: 1, muted: false, locked: false, hidden: false, height: 64 })
		const { diff } = opsToDiff({ addMotion: [{ template: 'title-card', atSec: 0 }] }, withM1)
		expect(diff.addTracks).toBeUndefined()
		expect(diff.addItems![0].trackId).toBe('m')
	})

	describe('updateMotion', () => {
		const placed: TimelineItem = {
			id: 'lt', trackId: 'm', sourceAssetId: '', timelineStart: 3, in: 0, out: 4,
			speed: 1, preservePitch: true, duration: 4, label: 'Lower third',
			motion: { template: 'lower-third', settings: { name: 'Sara' } }
		}
		const withLayer = () => {
			const d = makeDoc([asset], [clip, placed])
			d.tracks.push({ id: 'm', kind: 'video', name: 'M1', order: 1, muted: false, locked: false, hidden: false, height: 64 })
			return d
		}

		it('merges settings into what is there', () => {
			const { diff } = opsToDiff({ updateMotion: [{ id: 'lt', settings: [{ key: 'role', value: 'CTO' }] }] }, withLayer())
			expect(diff.updateItems).toEqual([{ id: 'lt', motion: { template: 'lower-third', settings: { name: 'Sara', role: 'CTO' } } }])
		})

		it('retimes: the out window, a new start and a new length', () => {
			const { diff } = opsToDiff({ updateMotion: [{ id: 'lt', moments: { out: 0.8 }, atSec: 3.1, durationSec: 4.4 }] }, withLayer())
			expect(diff.updateItems![0]).toMatchObject({
				id: 'lt', timelineStart: 3.1, in: 0, out: 4.4, duration: 4.4,
				motion: { template: 'lower-third', settings: { name: 'Sara' }, moments: { out: 0.8 } }
			})
		})

		it('refuses an item that is not a motion layer, or does not exist', () => {
			const { diff, droppedOps } = opsToDiff({ updateMotion: [{ id: 'v', settings: { name: 'x' } }, { id: 'nope' }] }, withLayer())
			expect(diff.updateItems).toBeUndefined()
			expect(droppedOps).toEqual(['updateMotion: v is not a motion layer', 'updateMotion: unknown item nope'])
		})

		it('is offered to the model only when there is something to update', () => {
			expect('updateMotion' in editorOpsSchema(false).properties).toBe(false)
			expect('updateMotion' in editorOpsSchema(true).properties).toBe(true)
			expect('addMotion' in editorOpsSchema(false).properties).toBe(true)
		})
	})
})

describe('custom HTML motion ops', () => {
	const asset = makeAsset('a', uniform(4, 5))
	const clip: TimelineItem = {
		id: 'v', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 20,
		speed: 1, preservePitch: true, duration: 20
	}
	const GOOD = [
		'<div id="n"></div>',
		'<script>frameflow.define({ duration: 5, settings: [{ key: "value", type: "number", default: 3, animate: true }],',
		'  moments: [{ name: "in", duration: 1 }, { name: "hold", duration: 3.5, flex: true }, { name: "out", duration: 0.5 }],',
		'  seek(t, s) { n.textContent = String(Math.round(s.value * frameflow.progress("in", t))) } })</script>'
	].join('\n')
	const BAD = GOOD.replace('String(Math.round(', 'String(Date.now() + Math.round(')
	const writer = { by: 'Claude Code', turnId: 'turn-8' }

	const placed = (html: string): TimelineItem => ({
		id: 'cl', trackId: 'm', sourceAssetId: '', timelineStart: 3, in: 0, out: 5,
		speed: 1, preservePitch: true, duration: 5, label: 'Triage stat',
		motion: writtenSpec(newMotionSpec(), html, writer)
	})
	const withLayer = (html: string) => {
		const d = makeDoc([asset], [clip, placed(html)])
		d.tracks.push({ id: 'm', kind: 'video', name: 'M1', order: 1, muted: false, locked: false, hidden: false, height: 64 })
		return d
	}

	it('adds a custom layer from html, with its length and settings read out of the page', () => {
		const { diff, notes, droppedOps } = opsToDiff(
			{ addMotion: [{ template: 'custom', atSec: 2, html: GOOD, label: 'Triage stat', settings: { value: 7 } }] },
			makeDoc([asset], [clip]), writer)
		expect(droppedOps).toEqual([])
		expect(notes).toEqual([])
		const item = diff.addItems![0]
		expect(item).toMatchObject({ label: 'Triage stat', duration: 5, timelineStart: 2 })
		expect(item.motion!.template).toBeUndefined()
		expect(item.motion!.html).toBe(GOOD)
		expect(item.motion!.passed!.html).toBe(GOOD)
		expect(item.motion!.settings).toEqual({ value: 7 })
		expect(item.motion!.author).toEqual(writer)
		expect(resolveDefinition(item.motion).duration).toBe(5)
	})

	it('writes who wrote it from the turn, so the inspector can say “in V8”', () => {
		const { diff } = opsToDiff({ addMotion: [{ template: 'custom', atSec: 0, html: GOOD }] }, makeDoc([asset], [clip]))
		expect(diff.addItems![0].motion!.author).toEqual({ by: 'FrameFlow AI' })
	})

	it('adds a blank custom layer when asked for “custom” without a page, and says so', () => {
		const { diff, notes } = opsToDiff({ addMotion: [{ template: 'custom', atSec: 0 }] }, makeDoc([asset], [clip]))
		expect(diff.addItems![0].motion!.html).toBe(BLANK_MOTION_HTML)
		expect(notes.join(' ')).toMatch(/needs `html`/)
	})

	it('keeps a failing page as the working text, draws nothing, and tells the writer which line', () => {
		const { diff, notes } = opsToDiff({ addMotion: [{ template: 'custom', atSec: 0, html: BAD }] }, makeDoc([asset], [clip]), writer)
		const spec = diff.addItems![0].motion!
		expect(spec.html).toBe(BAD)
		expect(spec.passed).toBeNull()
		expect(renderVersion(spec).source).toBe('nothing')
		expect(notes.join(' ')).toMatch(/line 4 fails its checks — The wall clock differs/)
		expect(notes.join(' ')).toMatch(/nothing is drawn until a version passes/)
	})

	it('rewrites a layer’s page and keeps drawing the old one when the new one fails', () => {
		const ok = opsToDiff({ updateMotion: [{ id: 'cl', html: GOOD.replace('duration: 5', 'duration: 6') }] }, withLayer(GOOD), writer)
		expect(resolveDefinition(ok.diff.updateItems![0].motion).duration).toBe(6)

		const bad = opsToDiff({ updateMotion: [{ id: 'cl', html: BAD }] }, withLayer(GOOD), { by: 'Codex', turnId: 'turn-9' })
		const spec = bad.diff.updateItems![0].motion!
		expect(spec.html).toBe(BAD)
		expect(spec.passed!.html).toBe(GOOD)
		expect(renderVersion(spec).source).toBe('last-passing')
		expect(spec.author).toEqual({ by: 'Codex', turnId: 'turn-9' })
		expect(bad.notes.join(' ')).toMatch(/the last version that passed stays on screen/)
	})

	it('tells the writer which settings are not keyframable, so it does not claim they are', () => {
		const shorthand = GOOD.replace('settings: [{ key: "value", type: "number", default: 3, animate: true }]', 'settings: { jacket: "#7A5BC4" }')
		const { notes } = opsToDiff({ addMotion: [{ template: 'custom', atSec: 0, html: shorthand, label: 'Doorbell' }] }, makeDoc([asset], [clip]), writer)
		expect(notes.join(' ')).toMatch(/"Doorbell": "jacket" is a setting but is not keyframable/)
		// GOOD declares its one setting `animate: true`: nothing to say.
		expect(opsToDiff({ addMotion: [{ template: 'custom', atSec: 0, html: GOOD }] }, makeDoc([asset], [clip]), writer).notes).toEqual([])
	})

	describe('a layer follows its page’s length', () => {
		const longer = GOOD.replace('duration: 5', 'duration: 6').replace('hold", duration: 3.5', 'hold", duration: 4.5')

		it('grows to the new page when it sat at the old page’s own length', () => {
			const { diff } = opsToDiff({ updateMotion: [{ id: 'cl', html: longer }] }, withLayer(GOOD), writer)
			expect(diff.updateItems![0]).toMatchObject({ in: 0, out: 6, duration: 6 })
		})

		it('takes the page’s length for a fresh blank layer, which is 3 s until a page arrives', () => {
			const d = makeDoc([asset], [clip, { ...placed(GOOD), duration: 3, out: 3, motion: newMotionSpec() }])
			d.tracks.push({ id: 'm', kind: 'video', name: 'M1', order: 1, muted: false, locked: false, hidden: false, height: 64 })
			const { diff } = opsToDiff({ updateMotion: [{ id: 'cl', html: longer }] }, d, writer)
			expect(diff.updateItems![0]).toMatchObject({ duration: 6, out: 6 })
		})

		it('leaves a layer someone trimmed alone', () => {
			const d = makeDoc([asset], [clip, { ...placed(GOOD), duration: 3, out: 3 }])
			d.tracks.push({ id: 'm', kind: 'video', name: 'M1', order: 1, muted: false, locked: false, hidden: false, height: 64 })
			const { diff } = opsToDiff({ updateMotion: [{ id: 'cl', html: longer }] }, d, writer)
			expect(diff.updateItems![0].duration).toBeUndefined()
		})

		it('lets an explicit durationSec win', () => {
			const { diff } = opsToDiff({ updateMotion: [{ id: 'cl', html: longer, durationSec: 4 }] }, withLayer(GOOD), writer)
			expect(diff.updateItems![0]).toMatchObject({ duration: 4 })
		})
	})

	it('reads settings in the same request against the page that request writes', () => {
		const { diff, notes } = opsToDiff({ updateMotion: [{ id: 'cl', html: GOOD.replace('key: "value"', 'key: "amount"'), settings: { amount: 9, value: 1 } }] }, withLayer(GOOD), writer)
		expect(diff.updateItems![0].motion!.settings).toEqual({ amount: 9 })
		expect(notes.join(' ')).toMatch(/no setting "value"/)
	})

	it('turns a template layer into a custom one when its page is rewritten', () => {
		const d = makeDoc([asset], [clip, { ...placed(GOOD), motion: { template: 'lower-third', settings: { name: 'Sara' } } }])
		d.tracks.push({ id: 'm', kind: 'video', name: 'M1', order: 1, muted: false, locked: false, hidden: false, height: 64 })
		const { diff } = opsToDiff({ updateMotion: [{ id: 'cl', html: BAD }] }, d, writer)
		const spec = diff.updateItems![0].motion!
		expect(spec.template).toBeUndefined()
		// Still drawing the template it was, until the new page passes.
		expect(spec.passed!.html).toBe(motionTemplate('lower-third')!.html)
	})

	it('places a saved template as a custom page the project owns', () => {
		setUserMotionTemplates([{ id: 'my-triage-stat', label: 'Triage stat', description: 'x', html: GOOD, definition: resolveDefinition(placed(GOOD).motion), savedAt: 1, author: 'you' }])
		try {
			const { diff, droppedOps } = opsToDiff({ addMotion: [{ template: 'my-triage-stat', atSec: 1, settings: { value: 4 } }] }, makeDoc([asset], [clip]))
			expect(droppedOps).toEqual([])
			const item = diff.addItems![0]
			expect(item.label).toBe('Triage stat')
			expect(item.motion).toMatchObject({ html: GOOD, settings: { value: 4 } })
			expect(item.motion!.template).toBeUndefined()
		} finally {
			setUserMotionTemplates([])
		}
	})

	it('knows which ops write a page, for the MCP permission', () => {
		expect(opsWriteHtml({ addMotion: [{ template: 'lower-third', atSec: 0 }] })).toBe(false)
		expect(opsWriteHtml({ updateMotion: [{ id: 'x', settings: { a: 1 } }] })).toBe(false)
		expect(opsWriteHtml({ addMotion: [{ template: 'custom', atSec: 0, html: '  ' }] })).toBe(false)
		expect(opsWriteHtml({ addMotion: [{ template: 'custom', atSec: 0, html: GOOD }] })).toBe(true)
		expect(opsWriteHtml({ updateMotion: [{ id: 'x', html: GOOD }] })).toBe(true)
	})

	it('offers html on both ops, and teaches the contract', () => {
		const props = editorOpsSchema(true).properties as any
		expect(props.addMotion.items.properties.html.type).toBe('string')
		expect(props.updateMotion.items.properties.html.type).toBe('string')
		expect(props.addMotion.items.properties.template.description).toMatch(/custom/)
	})
})

