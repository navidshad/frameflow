import { describe, expect, it } from 'vitest'
import {
	atQuery, clipsAt, describeMoment, describeReferences, findTimeRefs, formatTimecode, parseTimecode, splitTimeRefs,
	timeRefOptions, timeRefToken, type RefContext
} from './promptRefs'
import type { TimelineItem, Track } from './types'

const item = (id: string, trackId: string, timelineStart: number, inSec: number, outSec: number, extra: Partial<TimelineItem> = {}): TimelineItem => ({
	id, trackId, sourceAssetId: 'a1', timelineStart, in: inSec, out: outSec, speed: 1, preservePitch: true, duration: outSec - inSec, ...extra
})
const track = (id: string, kind: 'video' | 'audio', order: number): Track =>
	({ id, kind, name: id, order, muted: false, locked: false, hidden: false, height: 40 })

// 0–10s interview (source 5–15s), 10–20s b-roll at 2x, a logo over 2–4s on V2, a gap after 20s until music ends at 25s.
const ctx: RefContext = {
	tracks: [track('v1', 'video', 0), track('v2', 'video', 1), track('a1', 'audio', 0)],
	media: [{ id: 'a1', name: 'interview.mp4' }, { id: 'b1', name: 'broll.mov' }, { id: 'm1', name: 'music.wav' }],
	timeline: [
		item('i1', 'v1', 0, 5, 15, { label: 'Intro' }),
		item('i2', 'v1', 10, 0, 20, { sourceAssetId: 'b1', speed: 2, duration: 10 }),
		item('logo', 'v2', 2, 0, 2, { sourceAssetId: 'gen-logo', label: 'Logo' }),
		item('mus', 'a1', 0, 0, 25, { sourceAssetId: 'm1' })
	],
	markers: [{ id: 'mk', time: 12.25, label: 'Hook' }]
}

describe('timecodes', () => {
	it('reads m:ss.s, m:ss, h:mm:ss and bare seconds', () => {
		expect(parseTimecode('0:53.1')).toBeCloseTo(53.1)
		expect(parseTimecode('1:23')).toBe(83)
		expect(parseTimecode('@1:23.4')).toBeCloseTo(83.4)
		expect(parseTimecode('83.5')).toBe(83.5)
		expect(parseTimecode('1:02:03')).toBe(3723)
		expect(parseTimecode('1:02:03.5')).toBe(3723.5)
		expect(parseTimecode(' 12:00 ')).toBe(720)
		expect(parseTimecode('0')).toBe(0)
	})

	it('refuses what it would have to guess at', () => {
		for (const bad of ['', '@', 'abc', '1:2', '1:75', '1:60', '1:60:00', '1:023', '-5', '1.2.3', '1::23', ':23', '1:23:', '12a', '1:2:3']) {
			expect(parseTimecode(bad), bad).toBeNull()
		}
	})

	it('formats in tenths, hours only when needed, never 0:60.0', () => {
		expect(formatTimecode(53.14)).toBe('0:53.1')
		expect(formatTimecode(83)).toBe('1:23.0')
		expect(formatTimecode(59.96)).toBe('1:00.0')
		expect(formatTimecode(3723.5)).toBe('1:02:03.5')
		expect(formatTimecode(-3)).toBe('0:00.0')
		expect(formatTimecode(Number.NaN)).toBe('0:00.0')
		expect(timeRefToken(7.25)).toBe('@0:07.3')
	})

	it('round-trips what it formats', () => {
		for (const sec of [0, 0.1, 9.9, 61.2, 599.9, 3600, 3723.5]) expect(parseTimecode(formatTimecode(sec))).toBeCloseTo(sec)
	})
})

describe('finding references in text', () => {
	it('finds @times at word starts, with punctuation after', () => {
		const refs = findTimeRefs('Cut @0:53.1 and @83.5, then (@1:02:03). End at @1:23.')
		expect(refs.map((r) => [r.raw, r.sec])).toEqual([['@0:53.1', 53.1], ['@83.5', 83.5], ['@1:02:03', 3723], ['@1:23', 83]])
	})

	it('ignores addresses, bad times and half-typed ones', () => {
		expect(findTimeRefs('mail me@1:00 or @1:75 or @1:2 or @12a or @ 1:00 or @@1:00')).toEqual([])
	})

	it('splits text into plain runs and chips', () => {
		expect(splitTimeRefs('at @0:05.0 please')).toEqual([
			{ kind: 'text', text: 'at ' }, { kind: 'ref', text: '@0:05.0', sec: 5 }, { kind: 'text', text: ' please' }
		])
		expect(splitTimeRefs('none')).toEqual([{ kind: 'text', text: 'none' }])
	})

	it('knows the @ being typed at the caret', () => {
		expect(atQuery('move it to @1:2', 15)).toEqual({ start: 11, query: '1:2' })
		expect(atQuery('@', 1)).toEqual({ start: 0, query: '' })
		expect(atQuery('see @mark', 9)).toEqual({ start: 4, query: 'mark' })
		expect(atQuery('see @0:05 now', 13)).toBeNull()
		expect(atQuery('mail me@', 8)).toBeNull()
	})
})

describe('what a moment is', () => {
	it('puts the picture on top, then the higher lane; a cut belongs to the incoming clip', () => {
		expect(clipsAt(3, ctx).map((i) => i.id)).toEqual(['logo', 'i1', 'mus'])
		expect(clipsAt(10, ctx).map((i) => i.id)).toEqual(['i2', 'mus'])
	})

	it('names the clip, its id and the source time (speed included)', () => {
		expect(describeMoment(4.5, ctx)).toBe('timeline 4.500s, on "Intro" (item i1) at 9.500s into interview.mp4; over "music.wav" (item mus) at 4.500s into music.wav')
		expect(describeMoment(12, ctx)).toContain('"broll.mov" (item i2) at 4.000s into broll.mov')
		// A layer with no media has no source time to give.
		expect(describeMoment(3, ctx)).toMatch(/^timeline 3\.000s, on "Logo" \(item logo\); over "Intro"/)
	})

	it('says when a moment is a gap or past the end', () => {
		const gap: RefContext = { ...ctx, timeline: ctx.timeline.filter((i) => i.id !== 'mus') }
		expect(describeMoment(22, { ...gap, timeline: [...gap.timeline, item('late', 'v1', 24, 0, 2)] })).toBe('timeline 22.000s, a gap: nothing plays there')
		expect(describeMoment(90, ctx)).toBe('timeline 90.000s, past the end of the timeline (it ends at 0:25.0), so nothing plays there')
	})

	it('writes each reference once, then the frames with their notes', () => {
		const text = describeReferences('Trim @0:04.5 to @0:04.5 and look at @1:30', [
			{ timeSec: 3, note: '  this logo is too big ', marked: true },
			{ timeSec: 12 }
		], ctx)
		const lines = text.split('\n')
		expect(lines[0]).toBe('References in this message:')
		expect(lines.filter((l) => l.startsWith('- @0:04.5'))).toHaveLength(1)
		expect(text).toContain('- @1:30 = timeline 90.000s, past the end')
		expect(text).toContain('1. Frame at @0:03.0 = timeline 3.000s')
		expect(text).toContain('The user\'s note on it: "this logo is too big".')
		expect(text).toContain('drew marks on it')
		expect(text).toMatch(/2\. Frame at @0:12\.0 = [^\n]*"broll\.mov" \(item i2\) at 4\.000s/)
		expect(describeReferences('no refs here', [], ctx)).toBe('')
	})
})

describe('the @ picker', () => {
	const base = { ...ctx, playheadSec: 53.1, selected: [ctx.timeline[0]], canCapture: true }

	it('offers the frame, the playhead, the selected clip and the markers', () => {
		const rows = timeRefOptions('', base)
		expect(rows.map((r) => r.label)).toEqual(['Frame at the playhead', 'Playhead', 'Start of Intro', 'End of Intro', 'Marker: Hook'])
		expect(rows.find((r) => r.id === 'end-i1')!.sec).toBeCloseTo(9.95)
		// The playhead sits past the 25s timeline; the frame row is the monitor's business.
		expect(rows.find((r) => r.id === 'playhead')!.pastEnd).toBe(true)
		expect(rows.find((r) => r.id === 'frame')!.pastEnd).toBeUndefined()
	})

	it('puts a typed time first, keeping the rows that share its digits', () => {
		// Half typed: no time yet, only the rows it could become.
		expect(timeRefOptions('0:1', { ...base, playheadSec: 1 }).map((r) => r.id)).toEqual(['end-i1', 'marker-mk'])
		const rows = timeRefOptions('0:12', { ...base, playheadSec: 12 })
		expect(rows).toEqual([{ id: 'typed', label: 'Time', sec: 12 }, { id: 'playhead', label: 'Playhead', sec: 12 }, { id: 'marker-mk', label: 'Marker: Hook', sec: 12.25 }])
		expect(timeRefOptions('120', base)[0]).toEqual({ id: 'typed', label: 'Time', sec: 120, pastEnd: true })
	})

	it('filters by word, and offers no frame without a picture to capture', () => {
		expect(timeRefOptions('mark', base).map((r) => r.id)).toEqual(['marker-mk'])
		expect(timeRefOptions('', { ...base, canCapture: false, selected: [], markers: [] }).map((r) => r.id)).toEqual(['playhead'])
	})
})
