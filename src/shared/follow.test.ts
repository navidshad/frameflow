import { describe, expect, it } from 'vitest'
import { clipToFollow, followable, followKeys, placeInFrame, steady, withFollow } from './follow'
import { motionFrameState } from './motion'
import type { TrackSample } from './tracking'
import type { TimelineItem } from './types'

const HD = { width: 1920, height: 1080 }
const box = { cx: 0.25, cy: 0.5, w: 0.1, h: 0.2 }
const sample = (t: number, cx: number, extra: Partial<TrackSample> = {}): TrackSample => ({ t, cx, cy: 0.5, w: 0.1, h: 0.2, score: 0.9, ...extra })
const clip = (extra: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'clip', trackId: 'v1', sourceAssetId: 'footage', timelineStart: 100, in: 10, out: 20, speed: 1, preservePitch: true, duration: 10, ...extra
})
const cover = (extra: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'cover', trackId: 'm1', sourceAssetId: '', timelineStart: 102, in: 0, out: 2, speed: 1, preservePitch: true, duration: 2,
	motion: { template: 'track-cover' }, follow: { trackId: 'trk', assetId: 'footage', clipId: 'clip' }, ...extra
})
/** A track at 25 fps moving right across the picture from source second 12 to 14. */
const track = (from = 12, to = 14) => ({
	id: 'trk', fps: 25,
	samples: Array.from({ length: Math.round((to - from) * 25) + 1 }, (_, k) => sample(from + k / 25, 0.2 + k * 0.01))
})
const sources = (tracks = [track()]) => ({ tracks, media: [{ id: 'footage', metadata: { ...HD } as never }], frame: HD })

describe('where a point of the footage lands in the frame', () => {
	it('is the same place when the clip fills the frame untouched', () => {
		expect(placeInFrame(box, {}, HD, HD)).toEqual(box)
	})

	it('shrinks into the letterbox when the footage is a different shape', () => {
		// 16:9 footage in a 9:16 frame: full width, a band in the middle.
		const placed = placeInFrame({ cx: 0.5, cy: 0, w: 0.5, h: 0.5 }, {}, HD, { width: 1080, height: 1920 })
		expect(placed.cx).toBeCloseTo(0.5)
		expect(placed.cy).toBeCloseTo((1920 - 607.5) / 2 / 1920)
		expect(placed.w).toBeCloseTo(0.5)
		expect(placed.h).toBeCloseTo(0.5 * 607.5 / 1920)
	})

	it('follows a fill-and-pan crop', () => {
		const tall = { width: 1080, height: 1920 }
		const left = placeInFrame({ cx: 0, cy: 0.5, w: 0.1, h: 0.1 }, { framing: { mode: 'fill', pan: -1 } }, HD, tall)
		expect(left.cx).toBeCloseTo(0)
		const right = placeInFrame({ cx: 1, cy: 0.5, w: 0.1, h: 0.1 }, { framing: { mode: 'fill', pan: 1 } }, HD, tall)
		expect(right.cx).toBeCloseTo(1)
		expect(right.h).toBeCloseTo(0.1)
	})

	it('scales about the centre and moves with the clip', () => {
		const placed = placeInFrame(box, { transform: { scale: 2, x: 0.1, y: 0 } }, HD, HD)
		expect(placed.cx).toBeCloseTo(0.5 + (0.25 - 0.5) * 2 + 0.1)
		expect(placed.cy).toBeCloseTo(0.5)
		expect(placed.w).toBeCloseTo(0.2)
	})

	it('turns clockwise with the clip', () => {
		// A point right of centre goes to below centre after a quarter turn.
		const square = { width: 1000, height: 1000 }
		const placed = placeInFrame({ cx: 0.75, cy: 0.5, w: 0.1, h: 0.1 }, { transform: { rotation: 90 } }, square, square)
		expect(placed.cx).toBeCloseTo(0.5)
		expect(placed.cy).toBeCloseTo(0.75)
	})

	it('reads a keyed move at the right moment of the clip', () => {
		const moving = { keyframes: { 'transform.x': [{ t: 0, value: 0 }, { t: 2, value: 0.2 }] } }
		expect(placeInFrame(box, moving, HD, HD, 1).cx).toBeCloseTo(0.35)
	})
})

describe('steadying a track', () => {
	it('takes the tremble out without moving a steady path', () => {
		const line = [sample(0, 0.1), sample(0.04, 0.2), sample(0.08, 0.3)]
		expect(steady(line, 25)[1].cx).toBeCloseTo(0.2)
		const shaky = [sample(0, 0.2), sample(0.04, 0.24), sample(0.08, 0.2)]
		expect(steady(shaky, 25)[1].cx).toBeCloseTo(0.22)
	})

	it('never blends across a gap', () => {
		const gap = [sample(0, 0.1), sample(0.04, 0.2), sample(2, 0.9)]
		expect(steady(gap, 25)[1].cx).toBe(0.2)
	})
})

describe('a motion layer following a track', () => {
	it('drives only the settings the page defines', () => {
		expect(followable(cover())).toEqual(['x', 'y', 'w', 'h', 'on'])
		expect(followable({ motion: { template: 'callout-ring' } })).toEqual(['x', 'y', 'size'])
		expect(followable({ motion: { template: 'lower-third' } })).toEqual([])
	})

	it('puts the cover where the track is, in the layer\'s own seconds', () => {
		// The layer starts at timeline 102 = source 12, where the track starts.
		const item = withFollow(cover(), [clip(), cover()], sources())
		expect(motionFrameState(item, 0).settings.x).toBeCloseTo(0.2, 2)
		expect(motionFrameState(item, 1).settings.x).toBeCloseTo(0.45, 2)
		expect(motionFrameState(item, 1).settings.on).toBe(1)
	})

	it('still lands on it after the clip is moved and retimed', () => {
		// Double speed, started 50 s later: source 12 now plays at timeline 151.
		const moved = clip({ timelineStart: 150, speed: 2, duration: 5 })
		const layer = cover({ timelineStart: 151, duration: 1, out: 1 })
		const item = withFollow(layer, [moved, layer], sources())
		expect(motionFrameState(item, 0).settings.x).toBeCloseTo(0.2, 2)
		expect(motionFrameState(item, 0.5).settings.x).toBeCloseTo(0.45, 2)
	})

	it('hides the cover before the track starts, in a gap and after it ends', () => {
		// Tracked for source 12.4–12.8 and 13.6–14: a gap in between.
		const parts = { id: 'trk', fps: 25, samples: [...track(12.4, 12.8).samples, ...track(13.6, 14).samples] }
		const layer = cover({ duration: 3, out: 3 })
		const item = withFollow(layer, [clip(), layer], sources([parts]))
		const on = (u: number) => motionFrameState(item, u).settings.on
		expect([on(0.2), on(0.6), on(1.2), on(1.8), on(2.5)]).toEqual([0, 1, 0, 1, 0])
	})

	it('is in place on the layer\'s very first frame when the track began earlier', () => {
		const layer = cover({ timelineStart: 102.5 })
		const item = withFollow(layer, [clip(), layer], sources())
		const first = motionFrameState(item, 0).settings
		expect(first.on).toBe(1)
		expect(first.x as number).toBeGreaterThan(0.3)
	})

	it('goes through the clip\'s framing', () => {
		const zoomed = clip({ transform: { scale: 2 } })
		const item = withFollow(cover(), [zoomed, cover()], sources())
		// Source x 0.2 is 0.3 left of centre; at 2× that is 0.6 left: off the frame, held at the page's limit.
		expect(motionFrameState(item, 0).settings.x).toBeCloseTo(-0.1, 2)
		expect(motionFrameState(item, 0).settings.w).toBeCloseTo(0.2, 2)
	})

	it('hides a cover whose track or clip is gone', () => {
		expect(motionFrameState(withFollow(cover(), [clip(), cover()], sources([])), 1).settings.on).toBe(0)
		expect(motionFrameState(withFollow(cover(), [cover()], sources()), 1).settings.on).toBe(0)
	})

	it('keeps following after the clip is split into two pieces', () => {
		// Cut at timeline 103: the second piece is a new clip with a new id.
		const first = clip({ duration: 3, out: 13 })
		const second = clip({ id: 'second-piece', timelineStart: 103, in: 13, duration: 7 })
		const layer = cover({ timelineStart: 103.2, duration: 0.6, out: 0.6 })
		const item = withFollow(layer, [first, second, layer], sources())
		expect(motionFrameState(item, 0).settings.on).toBe(1)
		expect(motionFrameState(item, 0).settings.x).toBeCloseTo(0.2 + 1.2 * 0.25, 2)
	})

	it('leaves the stored item alone, and other items entirely', () => {
		const layer = cover()
		const drawn = withFollow(layer, [clip(), layer], sources())
		expect(layer.keyframes).toBeUndefined()
		expect(drawn).not.toBe(layer)
		const plain = clip()
		expect(withFollow(plain, [plain], sources())).toBe(plain)
	})

	it('writes nothing for a page with no setting to drive', () => {
		const card = cover({ motion: { template: 'lower-third' } })
		expect(followKeys(card, { track: track(), clip: clip(), source: HD, frame: HD })).toEqual({})
	})
})

describe('choosing the clip to follow', () => {
	it('takes the clip of that footage the layer overlaps most', () => {
		const a = clip({ id: 'a', timelineStart: 100, duration: 2.5, out: 12.5 })
		const b = clip({ id: 'b', timelineStart: 102.5, in: 12.5, duration: 7.5 })
		const other = clip({ id: 'c', sourceAssetId: 'other' })
		expect(clipToFollow({ timelineStart: 102, duration: 2 }, [a, b, other], 'footage')?.id).toBe('b')
		expect(clipToFollow({ timelineStart: 500, duration: 2 }, [a, b, other], 'footage')).toBeNull()
	})
})
