import { describe, expect, it } from 'vitest'
import {
	allBurnedCues, assColour, assTime, captionsFromTimeline, chunkPhrase, cuesToAss,
	escapeAssText, escapeSubtitlesPath, titleCues,
	type TranscriptEntry
} from './captions'
import type { TextOverlaySpec, TimelineItem, Track } from './types'

const vtrack: Track = {
	id: 'v1', kind: 'video', name: 'V1', order: 0,
	muted: false, locked: false, hidden: false, height: 72
}

const item = (over: Partial<TimelineItem> = {}): TimelineItem => ({
	id: 'i1', trackId: 'v1', sourceAssetId: 'a1', timelineStart: 0,
	in: 0, out: 10, speed: 1, preservePitch: true, duration: 10, ...over
})

/** "one two three four five six" over [0,6] — a word a second, near enough. */
const phrase = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
	start: 0, end: 6, text: 'one two three four five six', ...over
})

const doc = (timeline: TimelineItem[], tracks: Track[] = [vtrack]) => ({ timeline, tracks })

// ===== Chunking =====

describe('chunkPhrase', () => {
	it('breaks a phrase into short captions', () => {
		const cues = chunkPhrase(phrase())
		expect(cues.map((c) => c.text)).toEqual(['one two three', 'four five six'])
	})

	it('never leaves the phrase it came from', () => {
		// The whole point of estimating INSIDE a phrase: the error can never
		// accumulate past a boundary that was actually measured.
		const cues = chunkPhrase(phrase({ start: 12, end: 18 }))
		expect(cues[0].start).toBe(12)
		expect(cues[cues.length - 1].end).toBe(18)
		for (const cue of cues) {
			expect(cue.start).toBeGreaterThanOrEqual(12)
			expect(cue.end).toBeLessThanOrEqual(18)
		}
	})

	it('leaves no hole or overlap between consecutive captions', () => {
		const cues = chunkPhrase(phrase({ text: 'a bb ccc dddd eeeee ffffff ggg hh i' }))
		for (let i = 1; i < cues.length; i++) {
			expect(cues[i].start).toBeCloseTo(cues[i - 1].end, 9)
		}
	})

	it('gives longer text longer on screen', () => {
		const [long, short] = chunkPhrase(
			{ start: 0, end: 10, text: 'hi there you' },
			{ maxWords: 2 }
		)
		expect(long.end - long.start).toBeGreaterThan(short.end - short.start)
	})

	it('shows fewer captions rather than flashing unreadable ones', () => {
		// Six words in a second is three captions of a third of a second each.
		// Nobody can read that, so it becomes two.
		const cues = chunkPhrase({ start: 0, end: 1, text: 'one two three four five six' })
		expect(cues.length).toBe(2)
		expect(cues.map((c) => c.text).join(' ')).toBe('one two three four five six')
	})

	it('keeps every word', () => {
		const text = 'the quick brown fox jumps over the lazy dog again and again'
		expect(chunkPhrase({ start: 0, end: 8, text }).map((c) => c.text).join(' ')).toBe(text)
	})

	it('says nothing about silence, empty text or a zero-length phrase', () => {
		expect(chunkPhrase({ start: 0, end: 3, text: '[Silence]' })).toEqual([])
		expect(chunkPhrase({ start: 0, end: 3, text: '   ' })).toEqual([])
		expect(chunkPhrase({ start: 3, end: 3, text: 'hello' })).toEqual([])
	})

	it('respects a character budget so a caption cannot overflow the frame', () => {
		const cues = chunkPhrase(
			{ start: 0, end: 10, text: 'extraordinarily circumlocutory verbiage' },
			{ maxChars: 20 }
		)
		for (const cue of cues) expect(cue.text.length).toBeLessThanOrEqual(31)
		expect(cues.length).toBeGreaterThan(1)
	})
})

// ===== Timeline mapping =====

describe('captionsFromTimeline', () => {
	const transcripts = { a1: [phrase()] }

	it('places cues where the clip sits on the timeline', () => {
		const cues = captionsFromTimeline(doc([item({ timelineStart: 20 })]), transcripts)
		expect(cues[0].start).toBeCloseTo(20, 6)
		expect(cues[cues.length - 1].end).toBeCloseTo(26, 6)
	})

	it('drops the words a trim cut away', () => {
		// Keeping only [3,6] of the source keeps the back half of the phrase.
		const cues = captionsFromTimeline(doc([item({ in: 3, out: 6, timelineStart: 0 })]), transcripts)
		expect(cues.map((c) => c.text)).toEqual(['four five six'])
		expect(cues[0].start).toBeCloseTo(0, 6)
	})

	it('clips a caption that straddles the trim point', () => {
		const cues = captionsFromTimeline(doc([item({ in: 4, out: 10 })]), transcripts)
		// The second chunk runs [3,6] in source; only [4,6] of it survives.
		expect(cues[0].text).toBe('four five six')
		expect(cues[0].start).toBeCloseTo(0, 6)
		expect(cues[0].end).toBeCloseTo(2, 6)
	})

	it('captions every copy of a duplicated clip', () => {
		const cues = captionsFromTimeline(
			doc([item({ id: 'a', timelineStart: 0 }), item({ id: 'b', timelineStart: 30 })]),
			transcripts
		)
		expect(cues.filter((c) => c.start >= 30).length).toBe(2)
		expect(cues.length).toBe(4)
	})

	it('follows a retime', () => {
		const cues = captionsFromTimeline(doc([item({ speed: 2 })]), transcripts)
		// Twice as fast: the phrase's six seconds land in three.
		expect(cues[cues.length - 1].end).toBeCloseTo(3, 6)
	})

	it('says nothing for a gap', () => {
		const cues = captionsFromTimeline(doc([item({ timelineStart: 10 })]), transcripts)
		expect(cues.every((c) => c.start >= 10)).toBe(true)
	})

	it('skips what cannot be heard', () => {
		expect(captionsFromTimeline(doc([item({ muted: true })]), transcripts)).toEqual([])
		expect(captionsFromTimeline(doc([item()], [{ ...vtrack, muted: true }]), transcripts)).toEqual([])
		expect(captionsFromTimeline(doc([item()], [{ ...vtrack, hidden: true }]), transcripts)).toEqual([])
	})

	it('captions an audio track — a voiceover is speech too', () => {
		const atrack: Track = { ...vtrack, id: 'a-1', kind: 'audio' }
		const cues = captionsFromTimeline(doc([item({ trackId: 'a-1' })], [atrack]), transcripts)
		expect(cues.length).toBeGreaterThan(0)
	})

	it('ignores an asset with no transcript', () => {
		expect(captionsFromTimeline(doc([item({ sourceAssetId: 'nope' })]), transcripts)).toEqual([])
	})

	it('returns cues in timeline order', () => {
		const cues = captionsFromTimeline(
			doc([item({ id: 'b', timelineStart: 30 }), item({ id: 'a', timelineStart: 0 })]),
			transcripts
		)
		for (let i = 1; i < cues.length; i++) {
			expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].start)
		}
	})

	it('does not let two clips caption over each other across a cut', () => {
		// Items never overlap on the timeline — the render rejects that — so a
		// transition needs no special case. This is the test that says so.
		const cues = captionsFromTimeline(
			doc([
				item({ id: 'a', in: 0, out: 6, timelineStart: 0, duration: 6, transition: { out: { kind: 'fade', duration: 1 } } }),
				item({ id: 'b', in: 0, out: 6, timelineStart: 6, duration: 6 })
			]),
			transcripts
		)
		for (let i = 1; i < cues.length; i++) {
			expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end - 1e-9)
		}
	})
})

// ===== ASS =====

describe('assTime', () => {
	it('writes hours, minutes and centiseconds', () => {
		expect(assTime(0)).toBe('0:00:00.00')
		expect(assTime(1.5)).toBe('0:00:01.50')
		expect(assTime(61.239)).toBe('0:01:01.24')
		expect(assTime(3671.5)).toBe('1:01:11.50')
	})

	it('never writes a negative time', () => {
		expect(assTime(-3)).toBe('0:00:00.00')
	})
})

describe('escapeAssText', () => {
	it('defuses the braces that would be read as formatting', () => {
		expect(escapeAssText('a {b} c')).toBe('a (b) c')
	})

	it('turns a real newline into an ASS break', () => {
		expect(escapeAssText('one\ntwo')).toBe('one\\Ntwo')
	})
})

describe('cuesToAss', () => {
	const cues = [{ start: 0, end: 1.5, text: 'hello' }, { start: 1.5, end: 3, text: 'world' }]

	it('writes a header sized to the frame', () => {
		const ass = cuesToAss(cues, { width: 1080, height: 1920 })
		expect(ass).toContain('PlayResX: 1080')
		expect(ass).toContain('PlayResY: 1920')
		// Text scales with the frame, not with whatever resolution was exported.
		expect(ass).toMatch(/Style: Default,Arial,106,/)
	})

	it('writes one dialogue line per cue', () => {
		const ass = cuesToAss(cues, { width: 1920, height: 1080 })
		const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
		expect(lines).toEqual([
			'Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,hello',
			'Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,world'
		])
	})

	it('drops a cue with no length or no text', () => {
		const ass = cuesToAss(
			[{ start: 1, end: 1, text: 'gone' }, { start: 2, end: 3, text: '   ' }],
			{ width: 1920, height: 1080 }
		)
		expect(ass).not.toContain('Dialogue:')
	})

	it('produces a valid file for an empty timeline', () => {
		const ass = cuesToAss([], { width: 1920, height: 1080 })
		expect(ass).toContain('[Events]')
		expect(ass.endsWith('\n')).toBe(true)
	})
})

describe('escapeSubtitlesPath', () => {
	it('hides a colon from both parsers', () => {
		// One backslash is not enough: the filtergraph eats it and the filter's
		// option parser then splits on the bare colon.
		expect(escapeSubtitlesPath('/tmp/a: b/c.ass')).toBe('/tmp/a\\\\: b/c.ass')
	})

	it('hides the filtergraph separators', () => {
		expect(escapeSubtitlesPath('/tmp/a,b[c]/d.ass')).toBe('/tmp/a\\,b\\[c\\]/d.ass')
	})

	it('leaves an ordinary path alone', () => {
		expect(escapeSubtitlesPath('/tmp/exports/abc/captions.ass')).toBe('/tmp/exports/abc/captions.ass')
	})

	it('turns a Windows path around, and only a Windows path', () => {
		expect(escapeSubtitlesPath('C:\\Users\\x\\captions.ass')).toBe('C\\\\:/Users/x/captions.ass')
		// One literal backslash needs escaping at BOTH levels, hence four.
		expect(escapeSubtitlesPath('/tmp/back\\slash.ass')).toBe('/tmp/back\\\\\\\\slash.ass')
	})
})

// ===== Titles =====

describe('titleCues', () => {
	const ttrack: Track = { ...vtrack, id: 't1', name: 'T1' }
	const FRAME = { width: 1080, height: 1920 }
	const title = (over: Partial<TimelineItem> = {}, text: TextOverlaySpec = { content: 'Hello' }): TimelineItem =>
		item({ id: 'ttl', trackId: 't1', sourceAssetId: '', timelineStart: 2, in: 0, out: 3, duration: 3, text, ...over })

	it('spans exactly its item', () => {
		const [cue] = titleCues(doc([title()], [ttrack]), FRAME)
		expect(cue.start).toBe(2)
		expect(cue.end).toBe(5)
		expect(cue.text).toBe('Hello')
	})

	it('anchors on the centre of the text, in frame pixels', () => {
		const [cue] = titleCues(doc([title({}, { content: 'Hi', x: 0.25, y: 0.5 })], [ttrack]), FRAME)
		expect(cue.override).toContain('\\an5')
		expect(cue.override).toContain('\\pos(270,960)')
	})

	it('sizes from the frame, so a title survives a change of shape', () => {
		const tall = titleCues(doc([title({}, { content: 'Hi', size: 0.1 })], [ttrack]), FRAME)
		const wide = titleCues(doc([title({}, { content: 'Hi', size: 0.1 })], [ttrack]), { width: 1920, height: 1080 })
		expect(tall[0].override).toContain('\\fs192')
		expect(wide[0].override).toContain('\\fs108')
	})

	it('writes colours the way ASS wants them, which is backwards', () => {
		const [cue] = titleCues(doc([title({}, { content: 'Hi', color: '#FF8000' })], [ttrack]), FRAME)
		expect(cue.override).toContain('\\1c&H000080FF&')
	})

	it('falls back rather than emitting a broken colour', () => {
		expect(assColour('nope', '&H00FFFFFF&')).toBe('&H00FFFFFF&')
		expect(assColour(undefined, '&H00FFFFFF&')).toBe('&H00FFFFFF&')
		expect(assColour('#000000', '&H00FFFFFF&')).toBe('&H00000000&')
	})

	it('says nothing for an empty title or a hidden track', () => {
		expect(titleCues(doc([title({}, { content: '   ' })], [ttrack]), FRAME)).toEqual([])
		expect(titleCues(doc([title()], [{ ...ttrack, hidden: true }]), FRAME)).toEqual([])
	})

	it('clamps a position that would land off the frame', () => {
		const [cue] = titleCues(doc([title({}, { content: 'Hi', x: 5, y: -2 })], [ttrack]), FRAME)
		expect(cue.override).toContain('\\pos(1080,0)')
	})
})

describe('allBurnedCues', () => {
	const ttrack: Track = { ...vtrack, id: 't1', name: 'T1' }
	const FRAME = { width: 1920, height: 1080 }
	const transcripts = { a1: [phrase()] }
	const withTitle = doc(
		[item(), item({ id: 'ttl', trackId: 't1', sourceAssetId: '', timelineStart: 1, duration: 2, text: { content: 'Hi' } })],
		[vtrack, ttrack]
	)

	it('puts captions and titles in one list, in time order', () => {
		const cues = allBurnedCues(withTitle, transcripts, FRAME)
		expect(cues.some((c) => c.text === 'Hi')).toBe(true)
		expect(cues.some((c) => c.text === 'one two three')).toBe(true)
		for (let i = 1; i < cues.length; i++) {
			expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].start)
		}
	})

	it('lets captions be switched off without touching titles', () => {
		const cues = allBurnedCues(withTitle, transcripts, FRAME, { captions: false })
		expect(cues.map((c) => c.text)).toEqual(['Hi'])
	})
})

describe('cuesToAss with a title', () => {
	it('puts the title’s own tags in front of its text', () => {
		const ass = cuesToAss(
			[{ start: 0, end: 1, text: 'Hi', override: '{\\an5\\pos(10,20)}' }],
			{ width: 1920, height: 1080 }
		)
		expect(ass).toContain('Default,,0,0,0,,{\\an5\\pos(10,20)}Hi')
	})

	it('leaves a caption unadorned, so every caption looks the same', () => {
		const ass = cuesToAss([{ start: 0, end: 1, text: 'Hi' }], { width: 1920, height: 1080 })
		expect(ass).toContain('Default,,0,0,0,,Hi')
	})
})
