import type { MediaAsset, MediaKind, TimelineItem, Track } from './types'

/**
 * Tracks come in two families, and that is the whole model.
 *
 *   VIDEO holds anything you can SEE in the export — footage, stills, titles,
 *   generated backgrounds.
 *   AUDIO holds anything you can HEAR.
 *
 * An earlier model had four kinds, with `overlay` and `text` standing in for
 * "other objects, later". They cost more than they bought: a project was seeded
 * with exactly one track of each kind and a move was only ever allowed between
 * tracks of the SAME kind, so no item on the timeline had a legal destination
 * and every cross-track drag was silently refused. Worse, the export only ever
 * collected `video` and `audio` tracks, so the two extra lanes were places work
 * could be put and then quietly not rendered.
 *
 * Two families make the rule sayable in one line — *a thing goes where it can
 * be perceived* — and that is what the timeline, the export and the AI ops path
 * all read from here rather than each deciding for itself.
 */

export type TrackFamily = 'video' | 'audio'

/** Which family a track belongs to. */
export const trackFamily = (track: Pick<Track, 'kind'>): TrackFamily =>
	track.kind === 'audio' ? 'audio' : 'video'

/** Which family a piece of media belongs to. A still is something you see. */
export const familyForMedia = (kind: MediaKind | undefined): TrackFamily =>
	kind === 'audio' ? 'audio' : 'video'

/**
 * Which family an ITEM belongs to.
 *
 * A title, a generated layer and a motion layer carry their own content and
 * reference no media (`sourceAssetId` is empty for all three), so they are
 * answered before the lookup —
 * otherwise the missing asset would read as "unknown" for the two item types
 * whose family is the most certain thing about them.
 */
export function itemFamily(
	item: Pick<TimelineItem, 'text' | 'generator' | 'motion' | 'sourceAssetId'>,
	assets: Pick<MediaAsset, 'id' | 'kind'>[] = []
): TrackFamily {
	if (item.text || item.generator || item.motion) return 'video'
	return familyForMedia(assets.find((a) => a.id === item.sourceAssetId)?.kind)
}

/**
 * Whether a track can hold this item, and if not, why — the reason is what the
 * lane shows the user mid-drag. A refusal with no explanation is what made the
 * old model feel broken rather than strict.
 */
export function canHostItem(
	track: Pick<Track, 'kind' | 'locked' | 'hidden'>,
	item: Pick<TimelineItem, 'text' | 'generator' | 'motion' | 'sourceAssetId'>,
	assets: Pick<MediaAsset, 'id' | 'kind'>[] = []
): { ok: boolean; reason?: string } {
	if (track.locked) return { ok: false, reason: 'This track is locked.' }
	if (track.hidden) return { ok: false, reason: 'This track is hidden.' }
	const family = itemFamily(item, assets)
	if (trackFamily(track) !== family) {
		return {
			ok: false,
			reason: family === 'audio'
				? 'Sound belongs on an audio track.'
				: 'Anything you can see belongs on a video track.'
		}
	}
	return { ok: true }
}

/**
 * Whether this item lays down a PICTURE LAYER the compositor has to build.
 *
 * A title does not. It is burned over the finished file in one `subtitles=`
 * pass alongside the captions (`shared/captions.ts` → `titleCues`), which is
 * why a title renders from whichever track it sits on. Treating it as a layer
 * instead sends it to `toSlice`, which looks up its empty `sourceAssetId` and
 * throws `Missing media asset` — the exact failure that made moving titles onto
 * video tracks unsafe before this rule was written down once, here.
 */
export const isCompositedItem = (
	item: Pick<TimelineItem, 'text' | 'generator' | 'motion' | 'sourceAssetId'>
): boolean => !item.text && (!!item.generator || !!item.motion || !!item.sourceAssetId)

/**
 * The lanes top to bottom, the way an editor stacks them: the video family
 * first with the FRONT-MOST layer at the top, then the audio family.
 *
 * Top of the list is front of the picture, which is what `computeRegions`
 * already believed (`sort((a, b) => b.order - a.order)`, highest order wins
 * visually) and what the timeline used to contradict by sorting every track
 * ascending into one flat list.
 */
export function orderedTracks<T extends Pick<Track, 'kind' | 'order'>>(tracks: T[]): T[] {
	const video = tracks.filter((t) => trackFamily(t) === 'video').sort((a, b) => b.order - a.order)
	const audio = tracks.filter((t) => trackFamily(t) === 'audio').sort((a, b) => a.order - b.order)
	return [...video, ...audio]
}

/**
 * The `order` a NEW track of this family should take, so it lands on top of its
 * own family rather than at the end of a flat list.
 */
export function nextTrackOrder(tracks: Pick<Track, 'kind' | 'order'>[], family: TrackFamily): number {
	const mine = tracks.filter((t) => trackFamily(t) === family)
	return mine.length ? Math.max(...mine.map((t) => t.order)) + 1 : 0
}

/**
 * The lane a new title lands on by default.
 *
 * Titles no longer need a track kind of their own — they burn over the finished
 * picture from wherever they sit — but they still want a lane of their OWN,
 * because two items may not overlap on one track and a title is meant to sit
 * OVER a clip, not beside it. So it is an ordinary video track that happens to
 * be named, exactly as a generated background is found by the name `BG`.
 */
export const TITLE_TRACK_NAME = 'T1'

export const findTitleTrack = <T extends Pick<Track, 'kind' | 'name'>>(tracks: T[]): T | undefined =>
	tracks.find((t) => trackFamily(t) === 'video' && t.name === TITLE_TRACK_NAME)

/**
 * A free name for a new track: V1, V2… or A1, A2…
 *
 * Scans the names in use rather than counting tracks, because names are
 * load-bearing — `BG` is found BY NAME when a generated background is added,
 * and every name is read out to the model in the editing context. Counting
 * kinds hands the first added video track the name `V3` as soon as a `BG` lane
 * exists, and hands a second one a name that is already taken.
 */
export function nextTrackName(tracks: Pick<Track, 'name'>[], family: TrackFamily): string {
	const taken = new Set(tracks.map((t) => t.name))
	const prefix = family === 'audio' ? 'A' : 'V'
	for (let n = 1; ; n++) {
		const name = `${prefix}${n}`
		if (!taken.has(name)) return name
	}
}
