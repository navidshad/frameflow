import { describe, expect, it } from 'vitest'
import {
	assignStretch, carryOver, labelTranscript, mergeSpeakers, patchSpeaker, renameSpeaker, resolveSpeaker, speakerIn,
	summarizeSpeakers, turnAt
} from './speakers'
import { applyMulticamOps } from './multicamEdits'
import type { EditorDocument, MediaAsset, MulticamGroup, MulticamSpeakers, TimelineDiff } from './types'

const people = (): MulticamSpeakers['people'] => [
	{ id: 'spk-1', name: 'Speaker 1', pitchHz: 125, talkSec: 600 },
	{ id: 'spk-2', name: 'Speaker 2', pitchHz: 215, talkSec: 300 },
	{ id: 'spk-3', name: 'Speaker 3', pitchHz: 128, talkSec: 100 }
]
const speakers = (): MulticamSpeakers => ({
	people: people(),
	turns: [
		{ start: 0, end: 10, speaker: 'spk-1', confidence: 0.95 },
		{ start: 10.5, end: 14, speaker: 'spk-2', confidence: 0.9 },
		{ start: 14, end: 16, speaker: null, confidence: 0.4 },
		{ start: 16, end: 30, speaker: 'spk-3', confidence: 0.7 }
	],
	analysis: { analyzedAt: 1, cameras: ['Cam01', 'Cam02'], unsureShare: 0.07, warnings: [] }
})
const media: MediaAsset[] = ['a', 'b'].map((id, i) => ({
	id, kind: 'video', name: `${id}.mp4`, originalPath: `/Cam0${i + 1}/${id}.mp4`,
	metadata: { duration: 100, width: 1920, height: 1080, fps: 30, size: 1, codec: 'h264', format: 'mp4', hasAudio: true },
	preprocessing: {}, clips: [], createdAt: 0
}))
const group = (): MulticamGroup => ({
	id: 'g', name: 'Talk', soundAssetId: 'a', createdAt: 0, speakers: speakers(),
	members: [
		{ assetId: 'a', name: 'Cam01', camera: 'Cam01', offset: 0, rate: 1, sync: { method: 'reference', confidence: 'strong', driftPpm: 0 } },
		{ assetId: 'b', name: 'Cam02', camera: 'Cam02', offset: 2, rate: 1, sync: { method: 'audio', confidence: 'strong', driftPpm: 0 } }
	]
})

describe('finding a speaker', () => {
	it('by id, by number and by name, case-insensitively', () => {
		const sp = speakers()
		expect(resolveSpeaker(sp, 'spk-2')?.id).toBe('spk-2')
		expect(resolveSpeaker(sp, 2)?.id).toBe('spk-2')
		expect(resolveSpeaker(sp, '3')?.id).toBe('spk-3')
		expect(resolveSpeaker(sp, 'speaker 1')?.id).toBe('spk-1')
		expect(resolveSpeaker(sp, 'nobody')).toBeUndefined()
	})

	it('turnAt finds the turn covering an instant, and nothing in a gap', () => {
		const sp = speakers()
		expect(turnAt(sp, 5)?.speaker).toBe('spk-1')
		expect(turnAt(sp, 10.2)).toBeUndefined()
		expect(turnAt(sp, 15)?.speaker).toBeNull()
		expect(turnAt(sp, 99)).toBeUndefined()
	})
})

describe('who speaks over a stretch', () => {
	it('is the speaker holding most of the speech, with the others noted', () => {
		const found = speakerIn(speakers(), 8, 13)!
		expect(found.speaker?.name).toBe('Speaker 2')
		expect(found.share).toBeCloseTo(2.5 / 4.5, 2)
		expect(found.alsoHeard).toEqual(['Speaker 1'])
	})

	it('says nothing for silence, and null for a stretch that is mostly unsure', () => {
		expect(speakerIn(speakers(), 40, 50)).toBeUndefined()
		expect(speakerIn(speakers(), 14.1, 15.9)!.speaker).toBeNull()
	})

	it('puts a speaker on each transcript line; "unsure" when the lines split evenly or nobody speaks', () => {
		const lines = labelTranscript([
			{ start: 1, end: 4, text: 'one' },
			{ start: 11, end: 13, text: 'two' },
			{ start: 9, end: 11.5, text: 'both' },
			{ start: 40, end: 42, text: 'silence' }
		], speakers())
		expect(lines.map((l) => l.speaker)).toEqual(['Speaker 1', 'Speaker 2', 'unsure', 'unsure'])
		expect(lines[0].speakerConfidence).toBeCloseTo(0.95, 2)
	})

	it('leaves the transcript alone before speakers exist', () => {
		expect(labelTranscript([{ start: 0, end: 1, text: 'x' }], undefined)).toEqual([{ start: 0, end: 1, text: 'x' }])
	})
})

describe('naming, merging and fixing', () => {
	it('renames a speaker, refusing an empty or taken name', () => {
		const g = group()
		const ok = renameSpeaker(g, 2, 'Somi') as MulticamGroup
		expect(ok.speakers!.people[1].name).toBe('Somi')
		expect(renameSpeaker(g, 2, '  ')).toMatch(/needs a name/)
		expect(renameSpeaker(ok, 1, 'somi')).toMatch(/already called/)
		expect(renameSpeaker(g, 9, 'X')).toMatch(/no speaker "9"/)
	})

	it('describes a voice: camera and framing, and clears them', () => {
		const g = patchSpeaker(group(), 'Speaker 1', { camera: 'Cam01', framing: ' right of the two-shot ' }) as MulticamGroup
		expect(g.speakers!.people[0]).toMatchObject({ camera: 'Cam01', framing: 'right of the two-shot' })
		const cleared = patchSpeaker(g, 1, { camera: null, framing: null }) as MulticamGroup
		expect(cleared.speakers!.people[0].camera).toBeUndefined()
		expect(cleared.speakers!.people[0].framing).toBeUndefined()
	})

	it('merges two voices into one: the turns move over, touching ones join, the talk time adds up', () => {
		const g = group()
		const merged = mergeSpeakers(g, 3, 1) as MulticamGroup
		expect(merged.speakers!.people.map((p) => p.id)).toEqual(['spk-1', 'spk-2'])
		expect(merged.speakers!.people[0].talkSec).toBe(700)
		expect(merged.speakers!.turns.filter((t) => t.speaker === 'spk-1').map((t) => [t.start, t.end])).toEqual([[0, 10], [16, 30]])
		expect(mergeSpeakers(g, 1, 1)).toMatch(/same speaker/)
	})

	it('gives a stretch to a speaker as a fixed turn, cutting the turns around it', () => {
		const fixed = assignStretch(group(), 8, 12, 2) as MulticamGroup
		expect(fixed.speakers!.turns.slice(0, 3)).toEqual([
			{ start: 0, end: 8, speaker: 'spk-1', confidence: 0.95 },
			{ start: 8, end: 12, speaker: 'spk-2', confidence: 1, fixed: true },
			{ start: 12, end: 14, speaker: 'spk-2', confidence: 0.9 }
		])
		const unsure = assignStretch(group(), 0, 5, null) as MulticamGroup
		expect(unsure.speakers!.turns[0]).toMatchObject({ start: 0, end: 5, speaker: null, fixed: true })
	})

	it('keeps names, cameras and fixed turns across a new analysis, matched by pitch', () => {
		const named = patchSpeaker(group(), 2, { name: 'Somi', camera: 'Cam02' }) as MulticamGroup
		const fixed = assignStretch(named, 20, 25, 'Somi') as MulticamGroup
		// The new run found the voices in another order, with slightly different pitches.
		const fresh: MulticamSpeakers = {
			people: [
				{ id: 'spk-1', name: 'Speaker 1', pitchHz: 218 },
				{ id: 'spk-2', name: 'Speaker 2', pitchHz: 126 },
				{ id: 'spk-3', name: 'Speaker 3', pitchHz: 140 }
			],
			turns: [{ start: 0, end: 100, speaker: 'spk-2', confidence: 0.8 }],
			analysis: { analyzedAt: 2, cameras: [], unsureShare: 0, warnings: [] }
		}
		const kept = carryOver(fixed.speakers, fresh)
		expect(kept.people[0]).toMatchObject({ id: 'spk-1', name: 'Somi', camera: 'Cam02' })
		expect(kept.people[1].name).toBe('Speaker 2')
		expect(kept.turns.find((t) => t.fixed)).toMatchObject({ start: 20, end: 25, speaker: 'spk-1' })
	})

	it('summarizes for readers, naming the camera', () => {
		const g = patchSpeaker(group(), 2, { name: 'Somi', camera: 'Cam02' }) as MulticamGroup
		const s = summarizeSpeakers(g, media)!
		expect(s.speakers[1]).toMatchObject({ name: 'Somi', camera: 'Cam02', named: true, number: 2 })
		expect(s.speakers[0].named).toBe(false)
	})
})

describe('the speaker ops (apply_ops and the editor share them)', () => {
	const doc = (): EditorDocument => ({ media, timeline: [], tracks: [], multicams: [group()] } as unknown as EditorDocument)
	const run = (ops: Parameters<typeof applyMulticamOps>[0], d = doc()) => {
		const diff = { schemaVersion: 1 } as TimelineDiff
		const dropped: string[] = [], notes: string[] = []
		applyMulticamOps(ops, d, diff, dropped, notes, () => 'id')
		return { diff, dropped, notes }
	}

	it('setSpeaker resolves the camera by angle number and rewrites only the group', () => {
		const { diff, dropped } = run({ setSpeaker: { speaker: 2, name: 'Somi', camera: 2, framing: 'alone on her camera' } })
		expect(dropped).toEqual([])
		expect(diff.setMulticams![0].speakers!.people[1]).toMatchObject({ name: 'Somi', camera: 'Cam02', framing: 'alone on her camera' })
		expect(diff.updateItems).toBeUndefined()
	})

	it('composes several speaker ops in one call', () => {
		const { diff, dropped } = run({
			setSpeaker: { speaker: 1, name: 'Navid' }, mergeSpeakers: { from: 3, into: 1 },
			setSpeakerTurns: { turns: [{ fromSec: 0, toSec: 2, speaker: 'Navid' }] }
		})
		expect(dropped).toEqual([])
		const sp = diff.setMulticams![0].speakers!
		expect(sp.people.map((p) => p.name)).toEqual(['Navid', 'Speaker 2'])
		expect(sp.turns[0]).toMatchObject({ start: 0, end: 2, speaker: 'spk-1', fixed: true })
	})

	it('says why it did nothing: no speakers yet, unknown speaker, unknown camera', () => {
		const bare = doc()
		delete bare.multicams![0].speakers
		expect(run({ setSpeaker: { speaker: 1, name: 'X' } }, bare).dropped[0]).toMatch(/no speakers yet \(find_speakers first\)/)
		expect(run({ setSpeaker: { speaker: 9, name: 'X' } }).dropped[0]).toMatch(/no speaker "9"/)
		expect(run({ setSpeaker: { speaker: 1, camera: 'Cam09' } }).dropped[0]).toMatch(/no camera "Cam09"/)
	})
})
