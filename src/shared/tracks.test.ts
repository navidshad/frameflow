import { describe, expect, it } from 'vitest'
import type { MediaAsset, TimelineItem, Track } from './types'
import {
	canHostItem, findTitleTrack, hasLayerContent, hasPromptableContent, isCompositedItem, itemFamily, nextTrackName,
	nextTrackOrder, orderedTracks, trackFamily
} from './tracks'

const track = (over: Partial<Track> = {}): Track => ({
	id: 'v1', kind: 'video', name: 'V1', order: 0,
	muted: false, locked: false, hidden: false, height: 64, ...over
})

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'i1', trackId: 'v1', sourceAssetId: 'a',
	timelineStart: 0, in: 0, out: 5, speed: 1, preservePitch: true, duration: 5, ...over
})

const media: Pick<MediaAsset, 'id' | 'kind'>[] = [
	{ id: 'a', kind: 'video' },
	{ id: 'still', kind: 'image' },
	{ id: 'song', kind: 'audio' }
]

const title = () => item({ sourceAssetId: '', text: { content: 'Hi' } })
const generated = () => item({ sourceAssetId: '', generator: { kind: 'solid' } as TimelineItem['generator'] })

describe('families', () => {
	it('puts everything that is not audio in the video family', () => {
		expect(trackFamily(track())).toBe('video')
		expect(trackFamily(track({ kind: 'audio' }))).toBe('audio')
	})

	it('reads an item from what it IS, not from the track it sits on', () => {
		expect(itemFamily(item(), media)).toBe('video')
		expect(itemFamily(item({ sourceAssetId: 'still' }), media)).toBe('video')
		expect(itemFamily(item({ sourceAssetId: 'song' }), media)).toBe('audio')
	})

	it('answers for a title and a generated layer without any media', () => {
		// Both carry their own content and reference no asset, so the lookup that
		// would come back empty must never be reached.
		expect(itemFamily(title(), media)).toBe('video')
		expect(itemFamily(generated(), media)).toBe('video')
		expect(itemFamily(title(), [])).toBe('video')
	})
})

describe('canHostItem', () => {
	it('lets anything visible onto any video lane — the whole point', () => {
		const v2 = track({ id: 'v2', name: 'V2', order: 1 })
		for (const thing of [item(), item({ sourceAssetId: 'still' }), title(), generated()]) {
			expect(canHostItem(v2, thing, media).ok).toBe(true)
		}
	})

	it('keeps sound and picture apart, and says why', () => {
		const audio = track({ id: 'a1', kind: 'audio', name: 'A1' })
		const onAudio = canHostItem(audio, item(), media)
		expect(onAudio.ok).toBe(false)
		expect(onAudio.reason).toMatch(/video track/i)

		const onVideo = canHostItem(track(), item({ sourceAssetId: 'song' }), media)
		expect(onVideo.ok).toBe(false)
		expect(onVideo.reason).toMatch(/audio track/i)
	})

	it('refuses a locked or hidden lane before it looks at family', () => {
		expect(canHostItem(track({ locked: true }), item(), media))
			.toMatchObject({ ok: false, reason: expect.stringMatching(/locked/i) })
		expect(canHostItem(track({ hidden: true }), item(), media))
			.toMatchObject({ ok: false, reason: expect.stringMatching(/hidden/i) })
	})
})

describe('isCompositedItem', () => {
	it('counts footage and generated layers, never a title', () => {
		expect(isCompositedItem(item())).toBe(true)
		expect(isCompositedItem(generated())).toBe(true)
		// The one that matters: a title burns in a later pass, so the compositor
		// must not go looking for a file behind it.
		expect(isCompositedItem(title())).toBe(false)
	})
})

describe('orderedTracks', () => {
	it('stacks video front-most first, then audio', () => {
		const tracks = [
			track({ id: 'a1', kind: 'audio', name: 'A1', order: 0 }),
			track({ id: 'v1', name: 'V1', order: 0 }),
			track({ id: 'v2', name: 'V2', order: 1 }),
			track({ id: 'a2', kind: 'audio', name: 'A2', order: 1 })
		]
		expect(orderedTracks(tracks).map((t) => t.name)).toEqual(['V2', 'V1', 'A1', 'A2'])
	})

	it('puts a background lane under the footage it sits behind', () => {
		// BG takes a negative order so it renders behind everything; ascending
		// order used to draw it at the TOP of the timeline, contradicting the
		// picture.
		const tracks = [track({ id: 'bg', name: 'BG', order: -1 }), track()]
		expect(orderedTracks(tracks).map((t) => t.name)).toEqual(['V1', 'BG'])
	})
})

describe('naming and ordering a new track', () => {
	it('takes the first free name in its own series', () => {
		const tracks = [track(), track({ id: 'bg', name: 'BG' }), track({ id: 'a1', kind: 'audio', name: 'A1' })]
		expect(nextTrackName(tracks, 'video')).toBe('V2')
		expect(nextTrackName(tracks, 'audio')).toBe('A2')
	})

	it('does not skip a number because another lane exists', () => {
		// Counting video tracks named the first added lane V3 as soon as a BG was
		// there, and would eventually hand out a name already in use.
		expect(nextTrackName([track(), track({ id: 'bg', name: 'BG' })], 'video')).toBe('V2')
	})

	it('orders above its own family, not above every lane', () => {
		const tracks = [track({ order: 0 }), track({ id: 'a1', kind: 'audio', name: 'A1', order: 7 })]
		expect(nextTrackOrder(tracks, 'video')).toBe(1)
		expect(nextTrackOrder(tracks, 'audio')).toBe(8)
		expect(nextTrackOrder([], 'video')).toBe(0)
	})
})

describe('findTitleTrack', () => {
	it('finds the named video lane and ignores an audio one', () => {
		expect(findTitleTrack([track(), track({ id: 't1', name: 'T1', order: 1 })])?.id).toBe('t1')
		expect(findTitleTrack([track(), track({ id: 'x', kind: 'audio', name: 'T1' })])).toBeUndefined()
	})
})

describe('hasLayerContent', () => {
	const motion = () => item({ sourceAssetId: '', motion: { template: 'lower-third' } })

	it('counts motion pages, generated backgrounds and titles as content without footage', () => {
		for (const layer of [motion(), generated(), title()]) {
			expect(hasLayerContent([layer], [track()])).toBe(true)
		}
	})

	it('is false for an empty timeline and for footage alone (segments cover that)', () => {
		expect(hasLayerContent([], [track()])).toBe(false)
		expect(hasLayerContent([item()], [track()])).toBe(false)
	})

	it('ignores a layer on a hidden lane or on a lane that does not exist', () => {
		expect(hasLayerContent([motion()], [track({ hidden: true })])).toBe(false)
		expect(hasLayerContent([motion()], [])).toBe(false)
	})
})

describe('hasPromptableContent', () => {
	const motion = () => item({ sourceAssetId: '', motion: { template: 'lower-third' } })

	it('is true with media, or with a layer that needs none', () => {
		expect(hasPromptableContent({ media: [{}], timeline: [], tracks: [] })).toBe(true)
		expect(hasPromptableContent({ media: [], timeline: [motion()], tracks: [track()] })).toBe(true)
	})

	it('is false for a project with neither', () => {
		expect(hasPromptableContent({ media: [], timeline: [], tracks: [track()] })).toBe(false)
		expect(hasPromptableContent({ media: [], timeline: [motion()], tracks: [track({ hidden: true })] })).toBe(false)
	})
})
