import { describe, expect, it } from 'vitest'
import { findCutaways, keywords, matchCandidates, staleStretches } from './broll'
import type { Clip, MediaAsset, TimelineItem, Track } from './types'

const vtrack: Track = {
	id: 'v1', kind: 'video', name: 'V1', order: 0,
	muted: false, locked: false, hidden: false, height: 72
}

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'i1', trackId: 'v1', sourceAssetId: 'talk', timelineStart: 0,
	in: 0, out: 30, speed: 1, preservePitch: true, duration: 30, ...over
})

const clip = (id: string, index: number, visual: string): Clip => ({
	id, sourceAssetId: 'broll', index, in: index * 5, out: index * 5 + 5,
	duration: 5, visual, selected: false
})

const asset = (id: string, clips: Clip[] = []): MediaAsset => ({
	id, kind: 'video', name: `${id}.mp4`, originalPath: `/tmp/${id}.mp4`,
	metadata: { duration: 60, width: 1920, height: 1080, fps: 30, hasAudio: true } as MediaAsset['metadata'],
	preprocessing: {}, clips, createdAt: 0
})

const transcripts = {
	talk: [{ start: 0, end: 25, text: 'the harbour was full of fishing boats that morning' }]
}

const doc = (over: Partial<Parameters<typeof findCutaways>[0]> = {}) => ({
	timeline: [item()],
	tracks: [vtrack],
	media: [
		asset('talk'),
		asset('broll', [
			clip('b1', 1, 'wide shot of a harbour with fishing boats moored'),
			clip('b2', 2, 'close up of a laptop keyboard'),
			clip('b3', 3, 'a busy morning market')
		])
	],
	...over
})

describe('keywords', () => {
	it('keeps content words and drops the filler', () => {
		expect([...keywords('the very best thing about this harbour')]).toEqual(['best', 'harbour'])
	})

	it('ignores punctuation and case', () => {
		expect([...keywords('Boats, boats — BOATS!')]).toEqual(['boats'])
	})

	it('returns nothing for a language it has no stopwords for', () => {
		// Better an empty shortlist than a confident wrong one.
		expect(keywords('!!! ... ,,,').size).toBe(0)
	})
})

describe('staleStretches', () => {
	it('finds a long shot with talking over it', () => {
		const [stretch] = staleStretches(doc(), transcripts)
		expect(stretch).toMatchObject({ itemId: 'i1', start: 0, end: 30 })
		expect(stretch.saidText).toContain('harbour')
	})

	it('leaves a short shot alone', () => {
		expect(staleStretches(doc({ timeline: [item({ duration: 4, out: 4 })] }), transcripts)).toEqual([])
	})

	it('leaves a long shot with nothing said over it alone', () => {
		// A long silent shot is a choice, not a problem.
		expect(staleStretches(doc(), {})).toEqual([])
	})

	it('ignores titles and hidden tracks', () => {
		expect(staleStretches(doc({ timeline: [item({ text: { content: 'Hi' } })] }), transcripts)).toEqual([])
		expect(staleStretches(doc({ tracks: [{ ...vtrack, hidden: true }] }), transcripts)).toEqual([])
	})

	it('puts the longest stretch first, because that is the worst one', () => {
		const stretches = staleStretches(doc({
			timeline: [
				item({ id: 'short', timelineStart: 0, out: 14, duration: 14 }),
				item({ id: 'long', timelineStart: 20, out: 30, duration: 30 })
			]
		}), transcripts)
		expect(stretches[0].itemId).toBe('long')
	})
})

describe('matchCandidates', () => {
	const media = doc().media

	it('finds the piece that illustrates the words', () => {
		const [best] = matchCandidates(media, 'the harbour was full of fishing boats', 'talk')
		expect(best.sceneIndex).toBe(1)
		expect(best.matched.sort()).toEqual(['boats', 'fishing', 'harbour'])
	})

	it('never suggests the shot already on screen', () => {
		// Cutting to the same camera is not a cutaway.
		const withVisual = [asset('talk', [clip('t1', 1, 'a harbour full of fishing boats')])]
		expect(matchCandidates(withVisual, 'harbour boats', 'talk')).toEqual([])
	})

	it('ranks by how much it has in common', () => {
		const ranked = matchCandidates(media, 'harbour boats morning', 'talk')
		expect(ranked[0].sceneIndex).toBe(1)
		expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
	})

	it('says nothing when nothing matches', () => {
		expect(matchCandidates(media, 'quantum chromodynamics', 'talk')).toEqual([])
	})

	it('skips pieces nobody has described', () => {
		const undescribed = [asset('broll', [{ ...clip('x', 1, ''), visual: undefined }])]
		expect(matchCandidates(undescribed, 'harbour boats', 'talk')).toEqual([])
	})
})

describe('findCutaways', () => {
	it('pairs a stale stretch with something to cut to', () => {
		const [opportunity] = findCutaways(doc(), transcripts)
		expect(opportunity.itemId).toBe('i1')
		expect(opportunity.candidates[0].visual).toContain('harbour')
	})

	it('drops a stretch with nothing to cut TO', () => {
		// A suggestion with no answer is a complaint.
		const noBroll = doc({ media: [asset('talk')] })
		expect(findCutaways(noBroll, transcripts)).toEqual([])
	})
})
