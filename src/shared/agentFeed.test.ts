import { describe, expect, it } from 'vitest'
import type { TimelineItem } from './types'
import {
	agentChangeBadges, clock, opChips, pageRows, searchMoments, sourceToTimeline,
	summarizeMedia, summarizeSearch, summarizeTimeline, transcriptHealthLabel, type SearchSource
} from './agentFeed'

const item = (over: Partial<TimelineItem>): TimelineItem => ({
	id: 'i', trackId: 'v1', sourceAssetId: 'a', timelineStart: 0, in: 0, out: 10,
	speed: 1, preservePitch: true, duration: 10, ...over
})

describe('clock', () => {
	it('matches the monitor timecode', () => {
		expect(clock(27.5)).toBe('0:27.5')
		expect(clock(3.04)).toBe('0:03.0')
		expect(clock(75.25)).toBe('1:15.3')
		expect(clock(-1)).toBe('0:00.0')
	})
})

describe('summaries', () => {
	it('counts the timeline by what each item is', () => {
		const items = [
			item({ id: 'a' }), item({ id: 'b', timelineStart: 10 }),
			item({ id: 't', sourceAssetId: '', text: { text: 'Hi' } as any, timelineStart: 30, duration: 10 }),
			item({ id: 'g', sourceAssetId: '', generator: { kind: 'solid' } as any })
		]
		expect(summarizeTimeline(items)).toBe('2 clips · 1 title · 1 generated layer · 0:40.0')
		expect(summarizeTimeline([])).toBe('0 clips · 0:00.0')
	})

	it('says when a transcript cannot be trusted', () => {
		expect(transcriptHealthLabel(undefined, false)).toBe('no transcript')
		expect(transcriptHealthLabel({ looped: false, truncated: false, hasHole: false } as any)).toBe('health good')
		expect(transcriptHealthLabel({ looped: true, truncated: true, hasHole: false } as any)).toBe('transcript looped, stops early')
	})

	it('reads like the design: transcript, scenes, health', () => {
		expect(summarizeMedia({ words: 142, scenes: 9, transcriptHealth: { looped: false, truncated: false, hasHole: false } as any }))
			.toBe('transcript 142 words · 9 scenes · health good')
		expect(summarizeMedia({ words: null, scenes: 1 })).toBe('no transcript · 1 scene')
		expect(summarizeMedia({ words: 3, scenes: 2, descriptionHealth: { coverage: 0.5 } as any }))
			.toBe('transcript 3 words · 2 scenes · health unchecked · 50% described')
	})
})

describe('opChips', () => {
	it('shows the version, then what was asked for', () => {
		expect(opChips({ rationale: 'x', removeRanges: [{ fromSec: 1, toSec: 2 }] }, 8)).toEqual([
			{ text: 'V8', tone: 'violet' }, { text: '−1 range', tone: 'red' }
		])
		expect(opChips({ addClips: [{}, {}], updateItems: [{}], closeGaps: true, captions: false })).toEqual([
			{ text: '+2 clips', tone: 'green' }, { text: '1 change', tone: 'blue' },
			{ text: 'gaps closed', tone: 'blue' }, { text: 'captions off', tone: 'blue' }
		])
	})

	it('gives an op it has never heard of a chip anyway', () => {
		expect(opChips({ addMotion: [{}] })).toEqual([{ text: '+1 motion', tone: 'green' }])
		expect(opChips({ removeRanges: [] })).toEqual([])
	})
})

describe('agentChangeBadges', () => {
	it('marks adds as AI and trims by how much they changed', () => {
		const before = [item({ id: 'a', duration: 10 }), item({ id: 'b', duration: 5 })]
		const marks = agentChangeBadges({
			schemaVersion: 1,
			addItems: [item({ id: 'new' })],
			updateItems: [{ id: 'a', duration: 7.6, out: 7.6 }, { id: 'b', label: 'x' }],
			removeItemIds: ['gone']
		}, before)
		expect(marks).toEqual({ new: 'AI', a: '−2.4s', b: 'AI' })
	})

	it('reports a cut inside a clip as what was cut, not as the split piece’s new length', () => {
		// Seen live: removing 0.96s from a 39s clip split it into 11.18s + 26.9s,
		// and the first piece was badged "−28.0s".
		const before = [item({ id: 'a', in: 0, out: 39, duration: 39 })]
		const marks = agentChangeBadges({
			schemaVersion: 1,
			updateItems: [{ id: 'a', out: 11.18, duration: 11.18 }],
			addItems: [item({ id: 'rest', in: 12.14, out: 39, duration: 26.86, timelineStart: 11.18 })]
		}, before)
		expect(marks).toEqual({ a: '−1.0s', rest: 'AI' })
	})
})

describe('moment search', () => {
	const sources: SearchSource[] = [{
		assetId: 'team', assetName: 'greeting_team.mp4',
		transcript: [
			{ start: 20, end: 23, text: 'We wanted to know how much faster triage could be.' },
			{ start: 26.1, end: 28, text: 'It turned out three times faster.' },
			{ start: 40, end: 42, text: 'Thanks everyone.' }
		],
		scenes: [{ index: 3, in: 26, out: 30, visual: 'A bar chart: triage is faster' }]
	}]
	const items = [item({ id: 'x', sourceAssetId: 'team', in: 20, out: 30, timelineStart: 100 })]

	it('maps a source instant to every place it plays', () => {
		expect(sourceToTimeline(items, 'team', 26.1)).toEqual([106.1])
		expect(sourceToTimeline(items, 'team', 31)).toEqual([])
		expect(sourceToTimeline([item({ sourceAssetId: 'team', in: 0, out: 10, speed: 2, timelineStart: 4 })], 'team', 4)).toEqual([6])
	})

	it('ranks the exact phrase first and includes what was seen', () => {
		const hits = searchMoments('how much faster', sources, items)
		expect(hits[0].text).toMatch(/how much faster/)
		expect(hits[0].timelineSec[0]).toBeCloseTo(100)
		const seen = searchMoments('bar chart', sources, items)
		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({ kind: 'scene', sceneIndex: 3 })
	})

	it('needs most of the words, and returns nothing for an empty query', () => {
		expect(searchMoments('thanks everyone', sources, items)).toHaveLength(1)
		expect(searchMoments('purple elephants dancing', sources, items)).toHaveLength(0)
		expect(searchMoments('  ', sources, items)).toEqual([])
	})

	it('summarises like the design', () => {
		const hits = searchMoments('three times faster', sources, items)
		expect(summarizeSearch('three times faster', hits)).toBe('“three times faster” → 1 hit, best at 1:46.1')
		expect(summarizeSearch('nope', [])).toBe('“nope” → no hits')
	})
})

describe('pageRows', () => {
	const rows = Array.from({ length: 10 }, (_, i) => ({ i, text: 'x'.repeat(20) }))

	it('pages by count and hands back the next offset', () => {
		expect(pageRows(rows, { offset: 0, limit: 4 })).toMatchObject({ offset: 0, total: 10, nextOffset: 4 })
		expect(pageRows(rows, { offset: 8, limit: 4 })).toMatchObject({ nextOffset: null })
		expect(pageRows(rows, { offset: 8, limit: 4 }).rows).toHaveLength(2)
	})

	it('stops at the character budget but always returns one row', () => {
		const one = JSON.stringify(rows[0]).length + 1
		expect(pageRows(rows, { maxChars: one * 3 }).rows).toHaveLength(3)
		expect(pageRows(rows, { maxChars: 1 }).rows).toHaveLength(1)
	})
})
