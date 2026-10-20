import { describe, expect, it } from 'vitest'
import type { Track, TimelineItem } from './types'
import { applySoundBindings, bindTime, boundStart, freeSoundTrack, suggestCues } from './sound'

const track = (id: string, kind: Track['kind'], name: string, role?: Track['role']): Track =>
	({ id, kind, name, order: 0, muted: false, locked: false, hidden: false, height: 48, ...(role ? { role } : {}) })

const item = (o: Partial<TimelineItem> & { id: string; trackId: string }): TimelineItem => ({
	sourceAssetId: '', timelineStart: 0, in: 0, out: o.duration ?? 1, speed: 1, preservePitch: true, duration: 1, ...o
})

const lowerThird = item({
	id: 'lt', trackId: 'm1', label: 'Lower third', timelineStart: 3, duration: 4, out: 4,
	motion: { template: 'lower-third' }
})

const tracks = [track('m1', 'video', 'M1'), track('v1', 'video', 'V1'), track('a1', 'audio', 'A1', 'voice'), track('a3', 'audio', 'A3', 'sfx')]

describe('where a sound follows', () => {
	it('finds the start, the end and a motion layer’s exit', () => {
		expect(bindTime(lowerThird, 'start')).toBe(3)
		expect(bindTime(lowerThird, 'end')).toBe(7)
		const out = bindTime(lowerThird, 'out')
		expect(out).toBeGreaterThan(3)
		expect(out).toBeLessThan(7)
	})

	it('falls back to the end for a clip with no exit of its own', () => {
		const clip = item({ id: 'v', trackId: 'v1', timelineStart: 0, duration: 5 })
		expect(bindTime(clip, 'out')).toBe(5)
	})

	it('starts the sound early by its lead, but never before zero', () => {
		expect(boundStart(lowerThird, { itemId: 'lt', at: 'start', leadSec: 0.084 })).toBeCloseTo(2.916)
		expect(boundStart(item({ id: 'x', trackId: 'v1', timelineStart: 0.02, duration: 1 }), { itemId: 'x', at: 'start', leadSec: 0.1 })).toBe(0)
	})
})

describe('applySoundBindings', () => {
	const sound = (extra: Partial<TimelineItem> = {}) =>
		item({ id: 's', trackId: 'a3', timelineStart: 2.916, duration: 0.5, bind: { itemId: 'lt', at: 'start', leadSec: 0.084 }, ...extra })

	it('does nothing when the sound is already where its moment is', () => {
		expect(applySoundBindings({ timeline: [lowerThird, sound()] })).toBe(false)
	})

	it('moves the sound when its target moves', () => {
		const moved = { ...lowerThird, timelineStart: 5 }
		const timeline = [moved, sound()]
		expect(applySoundBindings({ timeline })).toBe(true)
		expect(timeline[1].timelineStart).toBeCloseTo(4.916)
	})

	it('follows a retime of the target’s length when it follows the exit', () => {
		const s = sound({ bind: { itemId: 'lt', at: 'end', leadSec: 0 }, timelineStart: 7 })
		const longer = { ...lowerThird, duration: 6 }
		const timeline = [longer, s]
		applySoundBindings({ timeline })
		expect(timeline[1].timelineStart).toBe(9)
	})

	it('lets go of a sound whose target is gone, leaving it where it was', () => {
		const timeline = [sound()]
		expect(applySoundBindings({ timeline })).toBe(true)
		expect(timeline[0].bind).toBeUndefined()
		expect(timeline[0].timelineStart).toBeCloseTo(2.916)
	})
})

describe('suggestCues', () => {
	const base = [
		item({ id: 'a', trackId: 'v1', label: 'greeting', timelineStart: 0, duration: 10 }),
		item({ id: 'b', trackId: 'v1', label: 'b-roll', timelineStart: 10, duration: 8 })
	]
	const state = (extra: TimelineItem[] = []) => ({ tracks, timeline: [lowerThird, ...base, ...extra] })

	it('finds a motion layer’s entrance and exit, and a cut', () => {
		const cues = suggestCues(state())
		expect(cues.map((c) => [c.atSec, c.kind])).toEqual([
			[3, 'whoosh'],
			[expect.any(Number), 'pop'],
			[10, 'swish']
		])
		expect(cues[0].label).toBe('M1 · Lower third · in')
		expect(cues[2].label).toContain('Cut')
	})

	it('is sorted by time', () => {
		const cues = suggestCues(state())
		expect(cues.map((c) => c.atSec)).toEqual([...cues.map((c) => c.atSec)].sort((a, b) => a - b))
	})

	it('marks a moment that already has a following sound as taken', () => {
		const sfx = item({ id: 's', trackId: 'a3', timelineStart: 2.9, duration: 0.5, bind: { itemId: 'lt', at: 'start' } })
		const cues = suggestCues(state([sfx]))
		expect(cues.find((c) => c.id === 'lt:start')!.taken).toBe(true)
		expect(cues.find((c) => c.id === 'lt:out')!.taken).toBe(false)
		// A sound is not itself a moment.
		expect(cues.some((c) => c.id.startsWith('s:'))).toBe(false)
	})

	it('asks for a whoosh at a cut that has a transition', () => {
		const withWipe = [
			{ ...base[0], transition: { out: { kind: 'wipeleft', duration: 1 } } },
			base[1]
		]
		const cues = suggestCues({ tracks, timeline: withWipe })
		expect(cues).toHaveLength(1)
		expect(cues[0].kind).toBe('whoosh')
	})

	it('gives the closing title card the resolving chord, and does not suggest it by default', () => {
		const end = item({ id: 'end', trackId: 'm1', label: 'The end', timelineStart: 15, duration: 3, motion: { template: 'title-card' } })
		const c = suggestCues(state([end])).find((x) => x.id === 'end:start')!
		expect(c.kind).toBe('resolve')
		expect(c.suggested).toBe(false)
	})

	it('ignores hidden tracks, titles and the first clip', () => {
		const hidden = [track('m1', 'video', 'M1'), { ...track('v1', 'video', 'V1'), hidden: true }]
		expect(suggestCues({ tracks: hidden, timeline: [lowerThird, ...base] }).every((c) => c.id.startsWith('lt'))).toBe(true)
	})
})

describe('freeSoundTrack', () => {
	it('finds a sound lane that is free where the sound would sit', () => {
		const busy = item({ id: 's', trackId: 'a3', timelineStart: 1, duration: 1 })
		const s = { tracks, timeline: [busy] }
		expect(freeSoundTrack(s, 1.5, 0.5)).toBeNull()
		expect(freeSoundTrack(s, 2, 0.5)).toBe('a3')
		expect(freeSoundTrack(s, 1.5, 0.5, 's')).toBe('a3')
	})

	it('ignores lanes that are not for effects, and locked ones', () => {
		const t = [track('a1', 'audio', 'A1', 'voice'), { ...track('a3', 'audio', 'A3', 'sfx'), locked: true }]
		expect(freeSoundTrack({ tracks: t, timeline: [] }, 0, 1)).toBeNull()
	})
})
