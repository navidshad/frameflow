import type { EditorDocument, MediaAsset, TimelineItem } from './types'
import { itemEnd } from './timeline'
import { captionsFromTimeline, type TranscriptEntry } from './captions'

/**
 * Where a cutaway would help, and what to cut away to.
 *
 * Both halves are already computed and sitting unused: the transcript says
 * what is being said and when, and `clip.visual` says what every piece of
 * every asset LOOKS like. Crossing them finds the shot that illustrates the
 * sentence — which is the one editorial judgement a machine can make cheaply
 * and a person finds tedious.
 *
 * Deliberately keyword overlap rather than embeddings. It is honest about what
 * it is (a shortlist, not a decision), it costs nothing, it works offline, and
 * the result goes into the model's context where the actual judgement happens.
 */

/** A stretch of one shot that has run long enough to want relief. */
export interface CutawayOpportunity {
	/** Timeline seconds. */
	start: number
	end: number
	/** The item that has been on screen throughout. */
	itemId: string
	/** What is being said across it, for matching and for the model to read. */
	saidText: string
	candidates: CutawayCandidate[]
}

export interface CutawayCandidate {
	assetId: string
	clipId: string
	/** The piece number a user and the ops schema both refer to it by. */
	sceneIndex: number
	in: number
	out: number
	/** What the piece looks like. */
	visual: string
	/** Words shared with what is being said. Higher is a better illustration. */
	score: number
	matched: string[]
}

/** A shot shorter than this does not need relief. */
export const MIN_STALE_SEC = 12
/** No more than this many suggestions, and the best first. */
export const MAX_OPPORTUNITIES = 6
const MAX_CANDIDATES = 3

/**
 * Words too common to mean anything. Short and deliberately English-only: the
 * scoring degrades to "no matches" in another language rather than to wrong
 * matches, and a shortlist that stays empty is honest.
 */
const STOPWORDS = new Set([
	'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'are', 'was', 'were',
	'have', 'has', 'had', 'but', 'not', 'they', 'them', 'their', 'from', 'what', 'when',
	'who', 'why', 'how', 'all', 'any', 'can', 'get', 'got', 'just', 'like', 'about',
	'into', 'out', 'over', 'then', 'than', 'there', 'here', 'some', 'more', 'very',
	'will', 'would', 'could', 'should', 'been', 'because', 'which', 'these', 'those',
	'its', 'his', 'her', 'him', 'she', 'one', 'two', 'now', 'know', 'think', 'going',
	'really', 'thing', 'things', 'people', 'time', 'well', 'yeah', 'okay', 'right'
])

/** Content words, lowercased and deduplicated. */
export function keywords(text: string): Set<string> {
	const words = (text || '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.split(/\s+/)
		.filter((w) => w.length >= 4 && !STOPWORDS.has(w))
	return new Set(words)
}

/**
 * Stretches where a single shot has been on screen for a long time while
 * someone kept talking.
 *
 * The talking matters: a long shot of something happening is not a problem,
 * but a long shot of someone explaining is where an editor cuts away.
 */
export function staleStretches(
	doc: Pick<EditorDocument, 'timeline' | 'tracks'>,
	transcripts: Record<string, TranscriptEntry[]>,
	minSec = MIN_STALE_SEC
): { start: number; end: number; itemId: string; saidText: string }[] {
	const videoTracks = new Set(
		doc.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id)
	)
	const cues = captionsFromTimeline(doc, transcripts)
	const out: { start: number; end: number; itemId: string; saidText: string }[] = []

	for (const item of doc.timeline) {
		if (!videoTracks.has(item.trackId) || item.text) continue
		if (item.duration < minSec) continue
		const start = item.timelineStart
		const end = itemEnd(item)
		const said = cues
			.filter((c) => c.start < end && c.end > start)
			.map((c) => c.text)
			.join(' ')
			.trim()
		// A long shot with nothing being said over it is not a stale shot, it is
		// a shot. Silence is the editor's own choice.
		if (!said) continue
		out.push({ start, end, itemId: item.id, saidText: said })
	}
	return out.sort((a, b) => (b.end - b.start) - (a.end - a.start))
}

/**
 * Pieces from OTHER material whose description overlaps what is being said.
 *
 * Excludes the asset already on screen: cutting away to the same camera is
 * not a cutaway.
 */
export function matchCandidates(
	media: MediaAsset[],
	saidText: string,
	excludeAssetId: string
): CutawayCandidate[] {
	const wanted = keywords(saidText)
	if (!wanted.size) return []

	const scored: CutawayCandidate[] = []
	for (const asset of media) {
		if (asset.id === excludeAssetId || asset.kind === 'audio') continue
		for (const clip of asset.clips) {
			if (!clip.visual) continue
			const have = keywords(clip.visual)
			const matched = [...wanted].filter((w) => have.has(w))
			if (!matched.length) continue
			scored.push({
				assetId: asset.id,
				clipId: clip.id,
				sceneIndex: clip.index,
				in: clip.in,
				out: clip.out,
				visual: clip.visual.replace(/\s+/g, ' ').trim().slice(0, 120),
				score: matched.length,
				matched
			})
		}
	}
	return scored
		.sort((a, b) => b.score - a.score || (b.out - b.in) - (a.out - a.in))
		.slice(0, MAX_CANDIDATES)
}

/** The whole suggestion pass: where to cut away, and to what. */
export function findCutaways(
	doc: Pick<EditorDocument, 'timeline' | 'tracks' | 'media'>,
	transcripts: Record<string, TranscriptEntry[]>,
	minSec = MIN_STALE_SEC
): CutawayOpportunity[] {
	const itemById = new Map(doc.timeline.map((i: TimelineItem) => [i.id, i]))
	return staleStretches(doc, transcripts, minSec)
		.map((stretch) => ({
			...stretch,
			candidates: matchCandidates(
				doc.media,
				stretch.saidText,
				itemById.get(stretch.itemId)?.sourceAssetId ?? ''
			)
		}))
		// A stretch with nothing to cut TO is not a suggestion, it is a complaint.
		.filter((o) => o.candidates.length > 0)
		.slice(0, MAX_OPPORTUNITIES)
}
