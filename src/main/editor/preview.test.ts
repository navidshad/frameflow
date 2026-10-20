import { describe, expect, it } from 'vitest'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from '@shared/types'
import { computeRegions } from './render'
import { graphKey, previewPlan } from './preview'
import type { OverlapRegion, RegionPlan } from './renderBuilders'

/**
 * The cache key is the whole invalidation strategy: a stale preview is silent
 * wrongness — the monitor would confidently show the previous transition.
 */

const asset = (id: string, duration: number): MediaAsset => ({
	id, kind: 'video', name: id, originalPath: `/tmp/${id}.mp4`,
	metadata: { duration, width: 1920, height: 1080, fps: 30, hasAudio: true } as MediaAsset['metadata'],
	preprocessing: {}, clips: [], createdAt: 0
})

const track: Track = {
	id: 'v1', kind: 'video', name: 'V1', order: 0,
	muted: false, locked: false, hidden: false, height: 64
}

const item = (over: Partial<TimelineItem>): TimelineItem => ({
	id: 'x', trackId: 'v1', sourceAssetId: 'sa', timelineStart: 0,
	in: 2, out: 12, speed: 1, preservePitch: true, duration: 10, ...over
})

/** A and B stay butt-joined whatever `a` does to A's length — otherwise the
 *  junction disappears and there is no window to key. */
const doc = (a: Partial<TimelineItem> = {}, b: Partial<TimelineItem> = {}): EditorDocument => {
	const first = item({
		id: 'A', sourceAssetId: 'sa', timelineStart: 0,
		transition: { out: { kind: 'fade', duration: 2 } }, ...a
	})
	return {
	schemaVersion: 1,
	media: [asset('sa', 20), asset('sb', 20)],
	tracks: [track],
	timeline: [
		first,
		item({ id: 'B', sourceAssetId: 'sb', timelineStart: first.duration, ...b })
	],
	timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 },
	activePersonaId: 'podcast-editor',
	turns: [],
	historyRef: { currentStepId: 'step-0', stepCount: 0 }
	}
}

const keyOf = (d: EditorDocument): string => {
	const plan = computeRegions(d, 'preview')
	const region = plan.regions.find((r): r is OverlapRegion => r.kind === 'overlap')!
	return graphKey(region, previewPlan(plan))
}

describe('previewPlan', () => {
	it('shrinks a 1080p plan to something that encodes quickly', () => {
		const plan = { width: 1920, height: 1080, fps: 60 } as RegionPlan
		const small = previewPlan(plan)
		expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(640)
		expect(small.fps).toBeLessThanOrEqual(30)
	})

	it('keeps the aspect ratio and even dimensions', () => {
		const small = previewPlan({ width: 1920, height: 1080, fps: 30 } as RegionPlan)
		expect(small.width / small.height).toBeCloseTo(16 / 9, 2)
		expect(small.width % 2).toBe(0)
		expect(small.height % 2).toBe(0)
	})

	it('never upscales something already small', () => {
		const small = previewPlan({ width: 320, height: 180, fps: 24 } as RegionPlan)
		expect(small.width).toBe(320)
		expect(small.fps).toBe(24)
	})
})

describe('graphKey', () => {
	it('is stable for an unchanged window', () => {
		expect(keyOf(doc())).toBe(keyOf(doc()))
	})

	it('changes with the preset', () => {
		expect(keyOf(doc())).not.toBe(keyOf(doc({ transition: { out: { kind: 'wipeleft', duration: 2 } } })))
	})

	it('changes with the duration', () => {
		expect(keyOf(doc())).not.toBe(keyOf(doc({ transition: { out: { kind: 'fade', duration: 3 } } })))
	})

	it('changes when a trim moves the frames the window shows', () => {
		// The outgoing clip's OUT-point and the incoming clip's IN-point are the
		// two edges the blend is built from; moving either changes the picture.
		expect(keyOf(doc())).not.toBe(keyOf(doc({ out: 11, duration: 9 })))
		expect(keyOf(doc())).not.toBe(keyOf(doc({}, { in: 1, out: 12, duration: 11 })))
	})

	it('reuses the render when a trim moves the window without changing it', () => {
		// Trimming the outgoing clip's HEAD shifts the cut along the timeline but
		// the blend still shows the same frames either side of it. Keying on
		// content rather than position means that file is correctly reused —
		// re-encoding it would be pure waste.
		expect(keyOf(doc())).toBe(keyOf(doc({ in: 3, duration: 9 })))
	})

	it('changes when a clip is retimed', () => {
		expect(keyOf(doc())).not.toBe(keyOf(doc({ speed: 2, duration: 5 })))
	})

	it('changes when a clip is muted', () => {
		// The cached file carries the crossfaded audio, so mute state is part of it.
		expect(keyOf(doc())).not.toBe(keyOf(doc({ muted: true })))
	})

	it('changes with EVERYTHING the window renders — the property the old key lacked', () => {
		// The first key hashed a curated field list, and this suite tested
		// exactly those fields — so it confirmed the list and could never catch
		// the omission. Phase 2 and 3 then added effects, framing, transform,
		// keyframes, keys, gain and fades to the window's graph, and none of
		// them invalidated the cache: grading a clip beside a transition kept
		// serving the stale render. Now the key IS the graph, and this is the
		// test that would have caught it.
		const edits: Partial<TimelineItem>[] = [
			{ effects: [{ id: 'e', kind: 'saturation', params: { amount: 0 } }] },
			{ effects: [{ id: 'e', kind: 'look-vintage' }] },
			{ framing: { mode: 'fill', pan: 0.5 } },
			{ transform: { scale: 0.5, x: 0.2 } },
			{ keyframes: { 'transform.x': [{ t: 0, value: -0.3 }, { t: 2, value: 0.3 }] } },
			{ key: { kind: 'chroma', colour: '#00B140' } },
			{ gain: 0.4 }
		]
		const base = keyOf(doc())
		for (const edit of edits) {
			expect(keyOf(doc(edit)), `outgoing ${JSON.stringify(edit)}`).not.toBe(base)
			expect(keyOf(doc({}, edit)), `incoming ${JSON.stringify(edit)}`).not.toBe(base)
		}
		// Fades are per-END, and the graph key knows which end the window shows:
		// the outgoing clip contributes its TAIL, the incoming its HEAD.
		expect(keyOf(doc({ fadeOutSec: 1 })), 'outgoing tail fade').not.toBe(base)
		expect(keyOf(doc({}, { fadeInSec: 1 })), 'incoming head fade').not.toBe(base)
	})

	it('knows a fade the window never shows changes nothing', () => {
		// A fade-IN on the outgoing clip sits at its head, far outside the
		// window — the picture is identical, so the render is reused. A curated
		// field list could never make this distinction; the graph makes it free.
		expect(keyOf(doc({ fadeInSec: 1 }))).toBe(keyOf(doc()))
	})

	it('does NOT change for an edit outside the picture', () => {
		// Over-triggering is the renderer's job and deduplication is this key's:
		// a label edit re-requests, resolves to the same key, and costs nothing.
		expect(keyOf(doc({ label: 'renamed' }))).toBe(keyOf(doc()))
	})
})
