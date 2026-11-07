import { describe, expect, it } from 'vitest'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from './types'
import {
	buildThumbnailBrief, chooseHeadline, cleanTitle, frameScore, frameStats, hookFromTranscript,
	isPlaceholderTitle, isUsableFrame, pickFrames, samplePoints, transcriptLinesForCut, type Candidate, type GrayFrame
} from './thumbnail'

// ---- fakes ----
const gray = (w: number, h: number, f: (x: number, y: number) => number): GrayFrame => {
	const data = new Uint8Array(w * h)
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y)
	return { width: w, height: h, data }
}
const black = gray(32, 18, () => 0)
const white = gray(32, 18, () => 255)
const flatGrey = gray(32, 18, () => 120)
const checker = gray(32, 18, (x, y) => ((x + y) % 2 ? 200 : 60)) // crisp, mid-exposed
const ramp = gray(32, 18, (x) => x * 8) // smooth gradient: contrast but no edges

const asset = (id: string, kind: MediaAsset['kind'] = 'video', duration = 60): MediaAsset => ({
	id, kind, name: id, originalPath: `/media/${id}.mp4`, preprocessing: {}, clips: [], createdAt: 0,
	metadata: { duration, width: 1920, height: 1080, size: 1, codec: 'h264', fps: 30, format: 'mp4', hasAudio: true }
})
const track = (id: string, hidden = false): Track =>
	({ id, kind: 'video', name: id, order: 0, muted: false, locked: false, hidden, height: 64 })
const item = (id: string, assetId: string, start: number, inn: number, out: number, extra: Partial<TimelineItem> = {}): TimelineItem => ({
	id, trackId: 'V1', sourceAssetId: assetId, timelineStart: start, in: inn, out, speed: 1, preservePitch: true, duration: out - inn, ...extra
})
const doc = (media: MediaAsset[], timeline: TimelineItem[], tracks: Track[] = [track('V1')]): EditorDocument => ({
	schemaVersion: 2, media, tracks, timeline,
	timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 },
	turns: [], historyRef: { currentStepId: '', stepCount: 0 }
})

describe('samplePoints', () => {
	it('takes midpoints of equal slices, never the very start or end', () => {
		const pts = samplePoints(doc([asset('a')], [item('i', 'a', 0, 0, 40)]), 4)
		expect(pts.map((p) => p.timelineSec)).toEqual([5, 15, 25, 35])
		expect(pts.every((p) => p.assetId === 'a')).toBe(true)
	})

	it('maps timeline time through the trim and speed into the source', () => {
		// 10s of source from 100..110 played at 2x: 5s on the timeline starting at 20.
		const d = doc([asset('a', 'video', 200)], [item('i', 'a', 20, 100, 110, { speed: 2, duration: 5 })])
		const [p] = samplePoints(d, 1)
		expect(p.timelineSec).toBeCloseTo(22.5)
		expect(p.sourceSec).toBeCloseTo(105) // 2.5s in at 2x = 5s of source
	})

	it('finds the right clip across a cut and skips gaps', () => {
		const d = doc([asset('a'), asset('b')], [item('i', 'a', 0, 0, 10), item('j', 'b', 30, 0, 10)])
		// span 0..40: midpoints 5, 15, 25, 35 -> 15 and 25 fall in the gap
		const pts = samplePoints(d, 4)
		expect(pts.map((p) => [p.assetId, p.timelineSec])).toEqual([['a', 5], ['b', 35]])
	})

	it('ignores audio, titles, generated layers and hidden lanes', () => {
		const d = doc(
			[asset('v'), asset('s', 'audio')],
			[
				item('title', '', 0, 0, 10),
				item('sound', 's', 0, 0, 10),
				item('hid', 'v', 0, 0, 10, { trackId: 'V2' }),
				item('real', 'v', 10, 0, 10)
			],
			[track('V1'), track('V2', true)]
		)
		const pts = samplePoints(d, 2)
		expect(pts.every((p) => p.assetId === 'v' && p.timelineSec >= 10)).toBe(true)
	})

	it('falls back to the first video when the timeline is empty', () => {
		const pts = samplePoints(doc([asset('s', 'audio'), asset('v', 'video', 20)], []), 2)
		expect(pts.map((p) => [p.assetId, p.sourceSec])).toEqual([['v', 5], ['v', 15]])
	})

	it('returns nothing when there is no picture at all', () => {
		expect(samplePoints(doc([asset('s', 'audio')], []), 4)).toEqual([])
		expect(samplePoints(doc([], []), 0)).toEqual([])
	})
})

describe('frame choice', () => {
	it('rejects black, blown-out and flat frames; accepts a crisp mid-exposed one', () => {
		expect(isUsableFrame(frameStats(black))).toBe(false)
		expect(isUsableFrame(frameStats(white))).toBe(false)
		expect(isUsableFrame(frameStats(flatGrey))).toBe(false)
		expect(isUsableFrame(frameStats(checker))).toBe(true)
	})

	it('treats a smooth gradient (blur-like, no edges) as unusable', () => {
		const s = frameStats(ramp)
		expect(s.contrast).toBeGreaterThan(14)
		expect(isUsableFrame(s)).toBe(false)
	})

	it('scores the sharper of two otherwise equal frames higher', () => {
		const soft = gray(32, 18, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 190 : 70)
		expect(frameScore(frameStats(checker))).toBeGreaterThan(frameScore(frameStats(soft)))
	})

	const cand = (timelineSec: number, g: GrayFrame): Candidate =>
		({ timelineSec, assetId: 'a', sourceSec: timelineSec, stats: frameStats(g) })

	it('picks the best usable frames and never a black one', () => {
		const soft = gray(32, 18, (x, y) => ((x >> 1) + (y >> 1)) % 2 ? 190 : 70)
		const picks = pickFrames([cand(5, black), cand(15, soft), cand(25, checker), cand(35, white)], 2)
		expect(picks.map((p) => p.timelineSec)).toEqual([25, 15])
	})

	it('keeps picks apart on the timeline when it can, and fills up when it cannot', () => {
		const list = [cand(10, checker), cand(11, checker), cand(40, checker)]
		expect(pickFrames(list, 2, 5).map((p) => p.timelineSec)).toEqual([10, 40])
		expect(pickFrames([cand(10, checker), cand(11, checker)], 2, 5).map((p) => p.timelineSec)).toEqual([10, 11])
	})

	it('is deterministic: equal scores go to the earlier frame', () => {
		const a = pickFrames([cand(30, checker), cand(10, checker)], 1)
		const b = pickFrames([cand(10, checker), cand(30, checker)], 1)
		expect(a[0].timelineSec).toBe(10)
		expect(b[0].timelineSec).toBe(10)
	})

	it('still returns one frame from a video with nothing usable', () => {
		const picks = pickFrames([cand(5, black), cand(15, flatGrey)], 3)
		expect(picks).toHaveLength(1)
	})
})

describe('headline', () => {
	it('recognises titles that say nothing', () => {
		expect(isPlaceholderTitle('Untitled Project')).toBe(true)
		expect(isPlaceholderTitle('IMG_4821.mov')).toBe(true)
		expect(isPlaceholderTitle('20241107_153000.mp4')).toBe(true)
		expect(isPlaceholderTitle('My trip to Rome')).toBe(false)
		expect(isPlaceholderTitle('2025 goals')).toBe(false)
	})

	it('cleans file-like titles', () => {
		expect(cleanTitle('my_trip_to_rome.mp4')).toBe('my trip to rome')
	})

	it('uses a short, meaningful title as the headline', () => {
		expect(chooseHeadline('I quit my job', [])).toEqual({ text: 'I quit my job', source: 'title' })
	})

	it('offers a transcript hook as a kicker next to a good title', () => {
		const h = chooseHeadline('Rome in 3 days', ['We tried everything. This is the one mistake to avoid.'])
		expect(h.text).toBe('Rome in 3 days')
		expect(h.kicker).toBe('This is the one mistake to avoid')
	})

	it('falls back to a transcript hook when the title is a placeholder', () => {
		const h = chooseHeadline('Untitled Project', ['Hello everyone. Why did nobody tell me this? Anyway.'])
		expect(h).toEqual({ text: 'Why did nobody tell me this?', source: 'transcript' })
	})

	it('prefers a hook over a title that is too long to read on a thumbnail', () => {
		const long = 'How I redesigned my entire apartment on a tiny budget in one weekend'
		expect(chooseHeadline(long, ['It cost only 200 dollars total.']).source).toBe('transcript')
	})

	it('clips a long title at a word boundary when the transcript has nothing', () => {
		const long = 'How I redesigned my entire apartment on a tiny budget in one weekend'
		const h = chooseHeadline(long, [])
		expect(h.text).toBe('How I redesigned my entire apartment on')
		expect(h.text.endsWith('…')).toBe(false)
	})

	it('has no headline when there is neither a title nor a usable transcript', () => {
		expect(chooseHeadline('Untitled Project', [])).toEqual({ text: '', source: 'none' })
	})

	it('ranks hooks: digits and questions beat plain lines, earlier beats later', () => {
		expect(hookFromTranscript(['We went outside today. We saw 3 huge dogs there.'])).toBe('We saw 3 huge dogs there')
		expect(hookFromTranscript(['A short line here. Another short line here.'])).toBe('A short line here')
		expect(hookFromTranscript(['Hi. Ok.'])).toBeNull()
	})

	it('reads Persian digits and the Arabic question mark', () => {
		expect(hookFromTranscript(['این یک جمله ساده است. چرا این کار را کردیم؟'])).toBe('چرا این کار را کردیم؟')
		expect(hookFromTranscript(['ما رفتیم بیرون. ما ۳ سگ بزرگ دیدیم.'])).toBe('ما ۳ سگ بزرگ دیدیم')
	})
})

describe('brief', () => {
	it('quotes the headline verbatim and states the face rule', () => {
		const text = buildThumbnailBrief({ headline: { text: 'I quit my job', source: 'title' }, frameCount: 3 })
		expect(text).toContain('"I quit my job"')
		expect(text).toContain('1280x720')
		expect(text).toContain('3 attached frames')
		expect(text).toMatch(/Never cover a face/)
		expect(text).toMatch(/bottom edge/)
	})

	it('says so when there is no headline instead of inventing one', () => {
		const text = buildThumbnailBrief({ headline: { text: '', source: 'none' }, frameCount: 1 })
		expect(text).toContain('No text')
		expect(text).toContain('attached frame ')
	})

	it('carries the kicker when there is one', () => {
		const text = buildThumbnailBrief({ headline: { text: 'A', source: 'title', kicker: 'B C D' }, frameCount: 2 })
		expect(text).toContain('"B C D"')
	})
})

describe('transcriptLinesForCut', () => {
	it('keeps only the lines inside the trimmed range, in timeline order', () => {
		const d = doc([asset('a'), asset('b')], [item('j', 'b', 10, 0, 5), item('i', 'a', 0, 20, 30)])
		const lines = transcriptLinesForCut(d, {
			a: [{ start: 0, end: 5, text: 'cut out' }, { start: 22, end: 25, text: 'kept a' }],
			b: [{ start: 1, end: 2, text: 'kept b' }, { start: 9, end: 12, text: 'cut b' }]
		})
		expect(lines).toEqual(['kept a', 'kept b'])
	})

	it('uses a lone video\'s whole transcript when nothing is cut yet', () => {
		const lines = transcriptLinesForCut(doc([asset('a')], []), { a: [{ start: 0, end: 1, text: 'hello there' }] })
		expect(lines).toEqual(['hello there'])
	})
})
