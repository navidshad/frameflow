import { describe, expect, it } from 'vitest'
import {
	adaptiveThresholdDb, assessTiming, findPauses, groupWordsIntoSegments, isEcho, LOUDNESS_FRAME_SEC,
	paceEstimates, parseOffset, planWindowsAtPauses, snapStartsToOnsets, stitchWindows, untranscribedStretches,
	type Pause, type TimedItem, type TimedWord
} from './transcript-timing'

/** Loudness frames (50 ms) from [startSec, endSec, dB] spans; gaps default to `fill`. */
function levels(durationSec: number, spans: [number, number, number][], fill = -60): number[] {
	const out = new Array(Math.round(durationSec / LOUDNESS_FRAME_SEC)).fill(fill)
	for (const [a, b, db] of spans) {
		for (let i = Math.round(a / LOUDNESS_FRAME_SEC); i < Math.round(b / LOUDNESS_FRAME_SEC); i++) out[i] = db
	}
	return out
}

/** Speech every `every` seconds lasting `talk` seconds, at `db`, over a floor. */
function talking(durationSec: number, every: number, talk: number, db = -20, floor = -55): number[] {
	const spans: [number, number, number][] = []
	for (let t = 0; t < durationSec; t += every) spans.push([t, Math.min(durationSec, t + talk), db])
	return levels(durationSec, spans, floor)
}

describe('pause finding', () => {
	it('sets the threshold between the noise floor and speech', () => {
		const t = adaptiveThresholdDb(talking(60, 4, 3))
		expect(t).toBeGreaterThan(-55)
		expect(t).toBeLessThan(-20)
	})

	it('finds the gaps between phrases and their ends are the onsets', () => {
		const pauses = findPauses(talking(20, 4, 3))
		// Gaps at 3–4, 7–8, 11–12, 15–16, 19–20
		expect(pauses.map((p) => [p.start, p.end])).toEqual([[3, 4], [7, 8], [11, 12], [15, 16], [19, 20]])
	})

	it('ignores dips shorter than a pause', () => {
		const lv = levels(4, [[0, 1.9, -20], [2.0, 4, -20]], -60) // 0.1 s dip
		expect(findPauses(lv)).toEqual([])
	})

	it('still finds pauses where the background gets loud (local threshold)', () => {
		// Quiet room for 20 s, then traffic at -32 dB under speech at -15 dB.
		const spans: [number, number, number][] = []
		for (let t = 0; t < 20; t += 4) spans.push([t, t + 3, -20])
		for (let t = 20; t < 40; t += 4) spans.push([t, t + 3, -15])
		const lv = levels(40, spans, -55)
		for (let i = 400; i < 800; i++) if (lv[i] === -55) lv[i] = -32
		const late = findPauses(lv).filter((p) => p.start >= 20)
		expect(late.length).toBeGreaterThanOrEqual(4)
		// One threshold for the whole file would miss them: -32 sits above it.
		expect(findPauses(lv, { thresholdDb: adaptiveThresholdDb(lv) }).filter((p) => p.start >= 20)).toEqual([])
	})

	it('treats digital silence as quiet', () => {
		const lv = talking(8, 4, 3)
		lv.fill(-Infinity, 60, 80)
		expect(findPauses(lv).some((p) => p.start <= 3 && p.end >= 4)).toBe(true)
	})
})

describe('planWindowsAtPauses', () => {
	const pauses: Pause[] = [
		{ start: 100, end: 100.4 }, { start: 140, end: 141.2 }, { start: 170, end: 170.3 },
		{ start: 290, end: 290.8 }, { start: 330, end: 330.2 }
	]

	it('keeps short audio in one window', () => {
		expect(planWindowsAtPauses(150, pauses, { targetSec: 120, maxSec: 180 })).toEqual([{ index: 0, start: 0, end: 150 }])
	})

	it('cuts in the middle of the longest pause in range, never splitting a word', () => {
		const w = planWindowsAtPauses(400, pauses, { targetSec: 120, maxSec: 180 })
		expect(w[0]).toEqual({ index: 0, start: 0, end: 140.6 })
		expect(w[1].start).toBe(140.6)
		expect(w[1].end).toBe(290.4)
		expect(w[w.length - 1].end).toBe(400)
		for (let i = 1; i < w.length; i++) expect(w[i].start).toBe(w[i - 1].end)
		for (const win of w) expect(win.end - win.start).toBeLessThanOrEqual(180)
	})

	it('cuts hard at the maximum when no pause is in range', () => {
		const w = planWindowsAtPauses(500, [], { targetSec: 120, maxSec: 180 })
		expect(w.map((x) => [x.start, x.end])).toEqual([[0, 180], [180, 360], [360, 500]])
	})

	it('returns nothing for unknown duration', () => {
		expect(planWindowsAtPauses(0, pauses, { targetSec: 120, maxSec: 180 })).toEqual([])
	})
})

describe('groupWordsIntoSegments', () => {
	const w = (text: string, start: number, end: number): TimedWord => ({ text, start, end })

	it('breaks after sentence marks, including the Persian question mark', () => {
		const segs = groupWordsIntoSegments([
			w('سلام', 0.3, 1), w('و', 1, 1.2), w('درود.', 1.2, 1.8),
			w('حالت', 1.9, 2.2), w('خوبه؟', 2.2, 2.6), w('آره', 2.7, 3)
		])
		expect(segs.map((s) => s.text)).toEqual(['سلام و درود.', 'حالت خوبه؟', 'آره'])
		expect(segs[0]).toMatchObject({ start: 0.3, end: 1.8 })
		expect(segs[0].words).toHaveLength(3)
	})

	it('breaks at a pause between words', () => {
		const segs = groupWordsIntoSegments([w('one', 0, 0.3), w('two', 0.35, 0.6), w('three', 1.5, 1.8)])
		expect(segs.map((s) => s.text)).toEqual(['one two', 'three'])
	})

	it('caps a segment that runs on without punctuation', () => {
		const words = Array.from({ length: 60 }, (_, i) => w(`w${i}`, i * 0.4, i * 0.4 + 0.35))
		const segs = groupWordsIntoSegments(words, { maxSec: 12 })
		for (const s of segs) expect(s.end - s.start).toBeLessThanOrEqual(12)
		expect(segs.map((s) => s.words!.length).reduce((a, b) => a + b)).toBe(60)
	})
})

describe('snapStartsToOnsets', () => {
	const pauses: Pause[] = [{ start: 4, end: 5 }, { start: 9, end: 9.6 }, { start: 20, end: 21 }]
	const item = (start: number, end: number, text = 'x'): TimedItem => ({ start, end, text })

	it('moves a start that sits in silence forward to where speech resumes', () => {
		const { items, snapped } = snapStartsToOnsets([item(4.6, 8)], pauses, { windowSec: 1.5 })
		expect(items[0].start).toBe(5)
		expect(snapped).toBe(1)
	})

	it('pulls a start onto a nearby onset', () => {
		expect(snapStartsToOnsets([item(9.9, 12)], pauses, { windowSec: 0.5 }).items[0].start).toBe(9.6)
	})

	it('never moves further than the window', () => {
		const { items, snapped } = snapStartsToOnsets([item(12, 15)], pauses, { windowSec: 1.5 })
		expect(items[0].start).toBe(12)
		expect(snapped).toBe(0)
	})

	it('keeps segments non-empty and in order', () => {
		const { items } = snapStartsToOnsets([item(9.2, 9.5), item(10, 11)], pauses, { windowSec: 1.5 })
		expect(items[0].start).toBe(9.2) // snapping to 9.6 would pass its end
		expect(items[1].start).toBeGreaterThanOrEqual(items[0].start)
	})

	it('does not treat the end of the file as an onset', () => {
		const { items } = snapStartsToOnsets([item(20.4, 20.9)], pauses, { windowSec: 1.5, durationSec: 21 })
		expect(items[0].start).toBe(20.4)
	})
})

describe('stitchWindows', () => {
	it('re-bases each window onto the source timeline, words included', () => {
		const out = stitchWindows([
			{ chunk: { index: 0, start: 0, end: 60 }, items: [{ start: 1, end: 3, text: 'a' }] },
			{ chunk: { index: 1, start: 60, end: 120 }, items: [{ start: 2, end: 4, text: 'b', words: [{ start: 2, end: 4, text: 'b' }] }] }
		])
		expect(out.map((i) => [i.start, i.end, i.text])).toEqual([[1, 3, 'a'], [62, 64, 'b']])
		expect(out[1].words![0]).toMatchObject({ start: 62, end: 64 })
	})

	it('drops what the model put past the end of its window', () => {
		const out = stitchWindows([{ chunk: { index: 0, start: 0, end: 60 }, items: [{ start: 70, end: 72, text: 'ghost' }, { start: 59, end: 63, text: 'tail' }] }])
		expect(out.map((i) => i.text)).toEqual(['tail'])
		expect(out[0].end).toBe(60)
	})

	it('drops a line at the seam that echoes the line across it', () => {
		const out = stitchWindows([
			{ chunk: { index: 0, start: 0, end: 60 }, items: [{ start: 55, end: 59.5, text: 'and that is why we travel' }] },
			{ chunk: { index: 1, start: 60, end: 120 }, items: [{ start: 0.2, end: 2, text: 'that is why we travel' }, { start: 3, end: 5, text: 'next' }] }
		])
		expect(out.map((i) => i.text)).toEqual(['and that is why we travel', 'next'])
	})

	it('keeps a repeated line away from a seam (real speech, or a loop to report)', () => {
		const out = stitchWindows([
			{ chunk: { index: 0, start: 0, end: 60 }, items: [{ start: 1, end: 2, text: 'thank you very much' }, { start: 2.1, end: 3, text: 'thank you very much' }] }
		])
		expect(out).toHaveLength(2)
	})

	it('echo detection ignores punctuation, case and zero-width joiners', () => {
		expect(isEcho('می‌خوام برم.', 'میخوام برم')).toBe(true)
		expect(isEcho('Hello there!', 'hello THERE')).toBe(true)
		expect(isEcho('yes', 'yes and no')).toBe(false) // too short to call contained
	})
})

describe('assessTiming', () => {
	// Ten phrases, each after a 1 s pause.
	const pauses: Pause[] = Array.from({ length: 10 }, (_, i) => ({ start: i * 5, end: i * 5 + 1 }))
	const onTime: TimedItem[] = pauses.map((p, i) => ({ start: p.end, end: p.end + 3.8, text: `phrase number ${i}` }))

	it('passes times that start on the speech', () => {
		const t = assessTiming(onTime, pauses, { durationSec: 50, engine: 'words' })
		expect(t.drift).toBe(false)
		expect(t.alignedRatio).toBe(1)
		expect(t.medianOnsetOffsetSec).toBe(0)
		expect(t.driftAtSec).toEqual([])
	})

	it('flags times that have slid off the speech', () => {
		const late = onTime.map((it) => ({ ...it, start: it.start + 2, end: it.end + 1 }))
		const t = assessTiming(late, pauses, { durationSec: 50, engine: 'segments' })
		expect(t.drift).toBe(true)
		expect(t.driftAtSec.length).toBeGreaterThan(5)
	})

	it('flags text over silence as likely invented', () => {
		const items = [...onTime, { start: 20.05, end: 20.95, text: 'never said' }].sort((a, b) => a.start - b.start)
		expect(assessTiming(items, pauses, { durationSec: 50, engine: 'segments' }).silentTextAtSec).toEqual([20.05])
	})

	it('flags a line that repeats the one before it', () => {
		const items = [...onTime]
		items[4] = { ...items[4], text: items[3].text }
		expect(assessTiming(items, pauses, { durationSec: 50, engine: 'words' }).repeatedAtSec).toEqual([items[4].start])
	})

	it('reports sound with no text over it', () => {
		const sound: Pause[] = [{ start: 30, end: 31.5 }]
		const items: TimedItem[] = [{ start: 0, end: 10, text: 'early' }, { start: 31.5, end: 40, text: 'late' }]
		expect(untranscribedStretches(items, sound, 40)).toEqual([{ start: 10.5, end: 30 }])
	})

	it('flags a squeezed window through the pace check', () => {
		// 120 s of steady speech (short pauses every 6 s), twenty equal lines…
		const p: Pause[] = Array.from({ length: 20 }, (_, i) => ({ start: i * 6 + 5.6, end: i * 6 + 6 }))
		// …that the model squeezed into the first 80 s.
		const squeezed: TimedItem[] = Array.from({ length: 20 }, (_, i) => ({ start: i * 4, end: i * 4 + 3.9, text: `line ${String(i).padStart(2, '0')} same length` }))
		const t = assessTiming(squeezed, p, { durationSec: 120, engine: 'segments', windows: [{ index: 0, start: 0, end: 120 }] })
		expect(t.drift).toBe(true)
		// The same lines at the right pace pass.
		const even = squeezed.map((it, i) => ({ ...it, start: i * 6, end: i * 6 + 5.6 }))
		expect(assessTiming(even, p, { durationSec: 120, engine: 'segments', windows: [{ index: 0, start: 0, end: 120 }] }).drift).toBe(false)
	})

	it('estimates pace from text length over the measured sound', () => {
		const items: TimedItem[] = [{ start: 0, end: 1, text: 'aaaa' }, { start: 1, end: 2, text: 'bbbb' }]
		const est = paceEstimates(items, [{ start: 4, end: 6 }], [{ index: 0, start: 0, end: 10 }])
		// 8 s of sound (0–4, 6–10): the second line starts half way in, at 4 s of sound = 6 s.
		expect(est).toEqual([0, 6])
	})

	it('says nothing about drift with too few phrase starts to judge', () => {
		const t = assessTiming(onTime.slice(0, 3).map((it) => ({ ...it, start: it.start + 3 })), pauses, { durationSec: 50, engine: 'words' })
		expect(t.drift).toBe(false)
	})
})

describe('parseOffset', () => {
	it('reads Interactions API offsets', () => {
		expect(parseOffset('0.300s')).toBe(0.3)
		expect(parseOffset('1s')).toBe(1)
		expect(parseOffset(2.5)).toBe(2.5)
		expect(parseOffset(undefined)).toBeNaN()
	})
})
