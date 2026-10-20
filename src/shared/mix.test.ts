import { describe, expect, it } from 'vitest'
import type { MediaAsset, Track, TimelineItem } from './types'
import type { AudioAnalysis } from './audio'
import { estimateMix } from './mix'

const track = (id: string, kind: Track['kind'], name: string, role?: Track['role'], gain?: number): Track =>
	({ id, kind, name, order: 0, muted: false, locked: false, hidden: false, height: 48, ...(role ? { role } : {}), ...(gain ? { gain } : {}) })
const asset = (id: string, kind: 'audio' | 'video'): MediaAsset =>
	({ id, kind, name: id, originalPath: '', preprocessing: {}, clips: [], createdAt: 0 } as MediaAsset)
const item = (id: string, trackId: string, assetId: string, extra: Partial<TimelineItem> = {}): TimelineItem =>
	({ id, trackId, sourceAssetId: assetId, timelineStart: 0, in: 0, out: 5, speed: 1, preservePitch: true, duration: 5, ...extra })
const analysis = (lufs: number | null, peak: number | null, hasAudio = true): AudioAnalysis =>
	({ v: 1, hasAudio, durationSec: 5, peakRate: 50, peaks: [], lufs, truePeakDb: peak, lra: null })

const tracks = [track('v1', 'video', 'V1'), track('a1', 'audio', 'A1', 'voice'), track('a2', 'audio', 'A2', 'music'), track('a3', 'audio', 'A3', 'sfx')]
const media = [asset('talk', 'video'), asset('bed', 'audio'), asset('whoosh', 'audio')]

describe('estimateMix', () => {
	it('moves each source’s loudness by the gain applied, per role', () => {
		const r = estimateMix(
			{ tracks, media, timeline: [item('c1', 'v1', 'talk'), item('c2', 'a2', 'bed', { gain: 0.5 }), item('c3', 'a3', 'whoosh')] },
			{ talk: analysis(-16, -3), bed: analysis(-20, -6), whoosh: analysis(-26, -17) }
		)
		const music = r.roles.find((x) => x.role === 'music')!
		expect(music.medianLufs).toBeCloseTo(-26, 0) // −20 and −6 dB for a gain of 0.5
		expect(r.roles.find((x) => x.role === 'voice')!.medianLufs).toBe(-16)
		expect(r.clips).toHaveLength(3)
	})

	it('says nothing when music and effects sit where they should', () => {
		const r = estimateMix(
			{ tracks, media, timeline: [item('c1', 'v1', 'talk'), item('c2', 'a2', 'bed'), item('c3', 'a3', 'whoosh')] },
			{ talk: analysis(-16, -3), bed: analysis(-30, -12), whoosh: analysis(-27, -17) }
		)
		expect(r.warnings).toEqual([])
	})

	it('warns when the music is crowding the voice, and gives the number', () => {
		const r = estimateMix(
			{ tracks, media, timeline: [item('c1', 'v1', 'talk'), item('c2', 'a2', 'bed')] },
			{ talk: analysis(-16, -3), bed: analysis(-18, -6) }
		)
		expect(r.warnings).toHaveLength(1)
		expect(r.warnings[0]).toMatch(/Music sits only 2\.0 LU under the voice/)
	})

	it('warns when effects are inaudibly quiet', () => {
		const r = estimateMix(
			{ tracks, media, timeline: [item('c1', 'v1', 'talk'), item('c3', 'a3', 'whoosh')] },
			{ talk: analysis(-16, -3), whoosh: analysis(-50, -40) }
		)
		expect(r.warnings.join(' ')).toMatch(/SFX is .* too quiet/)
	})

	it('flags a clip that will clip', () => {
		const r = estimateMix(
			{ tracks, media, timeline: [item('c1', 'v1', 'talk', { label: 'greeting', gain: 2 })] },
			{ talk: analysis(-16, -2) }
		)
		expect(r.warnings.some((w) => /"greeting" on V1 peaks at/.test(w))).toBe(true)
	})

	it('leaves out what makes no sound: muted, hidden, titles, motion, silent video', () => {
		const muted = item('m', 'a2', 'bed', { muted: true })
		const title = item('t', 'v1', '', { text: { content: 'hi' } as never })
		const silent = item('s', 'v1', 'talk')
		const r = estimateMix({ tracks, media, timeline: [muted, title, silent] }, { talk: analysis(null, null, false), bed: analysis(-20, -6) })
		expect(r.clips).toHaveLength(0)
	})

	it('reports a source it has not measured yet, rather than guessing', () => {
		const r = estimateMix({ tracks, media, timeline: [item('c1', 'v1', 'talk')] }, {})
		expect(r.clips[0].estLufs).toBeNull()
		expect(r.warnings.join(' ')).toMatch(/not been measured yet/)
	})

	it('is honest about what it leaves out', () => {
		const r = estimateMix({ tracks, media, loudnessEnabled: true, timeline: [] }, {})
		expect(r.caveats.join(' ')).toMatch(/ducks under speech/)
		expect(r.caveats.join(' ')).toMatch(/Loudness is on/)
	})
})
