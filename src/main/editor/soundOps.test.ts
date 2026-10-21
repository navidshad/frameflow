import { describe, expect, it } from 'vitest'
import type { EditorDocument, EditorOps, MediaAsset, TimelineItem, Track } from '@shared/types'
import { applyTimelineDiff } from '@shared/timeline'
import { recipeKey, soundLength, type SoundRecipe } from '@shared/synth'
import { opsToDiff } from './ops'
import { opsMakeSound, soundRecipesOf } from './soundOps'

// ===== Fixtures =====

const track = (id: string, kind: Track['kind'], name: string, role?: Track['role']): Track =>
	({ id, kind, name, order: kind === 'video' ? 0 : 1, muted: false, locked: false, hidden: false, height: 48, ...(role ? { role } : {}) })

const video: MediaAsset = {
	id: 'talk', kind: 'video', name: 'talk.mp4', originalPath: '/tmp/talk.mp4', preprocessing: {}, clips: [], createdAt: 0,
	metadata: { duration: 30 } as MediaAsset['metadata']
}

/** What ensureSoundAsset hands back: an audio asset that remembers its recipe. */
const soundAsset = (recipe: SoundRecipe): MediaAsset => ({
	id: `synth-${recipeKey(recipe).replace(/[^a-z0-9]/gi, '')}`, kind: 'audio', name: recipe.kind[0].toUpperCase() + recipe.kind.slice(1),
	originalPath: '/tmp/x.wav', preprocessing: {}, clips: [], createdAt: 0, preprocessState: 'completed',
	metadata: { duration: soundLength(recipe) } as MediaAsset['metadata'],
	synth: { variant: 0, pitch: 0, levelDb: -17, air: 0.4, seed: 0, durationSec: 0, ...recipe, kind: recipe.kind } as Required<SoundRecipe>
})
const assetsFor = (...recipes: SoundRecipe[]) => new Map(recipes.map((r) => [recipeKey(r), soundAsset(r)]))

const lowerThird: TimelineItem = {
	id: 'lt', trackId: 'm1', sourceAssetId: '', label: 'Lower third', timelineStart: 3, in: 0, out: 4, speed: 1,
	preservePitch: true, duration: 4, motion: { template: 'lower-third' }
}
const clip: TimelineItem = {
	id: 'c1', trackId: 'v1', sourceAssetId: 'talk', label: 'greeting', timelineStart: 0, in: 0, out: 10, speed: 1,
	preservePitch: true, duration: 10
}

function makeDoc(extra: Partial<EditorDocument> = {}): EditorDocument {
	return {
		schemaVersion: 1, media: [video], tracks: [track('m1', 'video', 'M1'), track('v1', 'video', 'V1'), track('a1', 'audio', 'A1', 'voice')],
		timeline: [lowerThird, clip], timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 },
		activePersonaId: 'podcast-editor', turns: [], historyRef: { currentStepId: 's0', stepCount: 0 }, ...extra
	} as EditorDocument
}

const run = (ops: EditorOps, doc = makeDoc(), assets = new Map<string, MediaAsset>()) => opsToDiff(ops, doc, undefined, assets)

// ===== addSounds =====

describe('addSounds', () => {
	it('puts a sound on its moment, early by its lead, on a new effects lane', () => {
		const assets = assetsFor({ kind: 'whoosh' })
		const r = run({ addSounds: [{ kind: 'whoosh', follow: { item: 'lt', at: 'start' } }] }, makeDoc(), assets)
		const added = r.diff.addItems!
		expect(added).toHaveLength(1)
		expect(added[0].timelineStart).toBeCloseTo(3 - 0.084)
		expect(added[0].bind).toEqual({ itemId: 'lt', at: 'start', leadSec: 0.084 })
		expect(added[0].duration).toBeCloseTo(0.5)
		const lane = r.diff.addTracks!.find((t) => t.id === added[0].trackId)!
		expect(lane).toMatchObject({ kind: 'audio', role: 'sfx' })
		expect(r.droppedOps).toEqual([])
	})

	it('puts a sound at a time when it is told one', () => {
		const r = run({ addSounds: [{ kind: 'pop', atSec: 7.2 }] }, makeDoc(), assetsFor({ kind: 'pop' }))
		expect(r.diff.addItems![0].timelineStart).toBe(7.2)
		expect(r.diff.addItems![0].bind).toBeUndefined()
	})

	it('puts two close sounds on two lanes rather than on top of each other', () => {
		const assets = assetsFor({ kind: 'whoosh' }, { kind: 'pop' })
		const r = run({ addSounds: [{ kind: 'whoosh', atSec: 5 }, { kind: 'pop', atSec: 5.2 }] }, makeDoc(), assets)
		const [a, b] = r.diff.addItems!
		expect(a.trackId).not.toBe(b.trackId)
		expect(r.diff.addTracks).toHaveLength(2)
	})

	it('reuses a free effects lane that is already there', () => {
		const doc = makeDoc({ tracks: [...makeDoc().tracks, track('a3', 'audio', 'A3', 'sfx')] })
		const r = run({ addSounds: [{ kind: 'pop', atSec: 5 }] }, doc, assetsFor({ kind: 'pop' }))
		expect(r.diff.addItems![0].trackId).toBe('a3')
		expect(r.diff.addTracks).toBeUndefined()
	})

	it('lands on where the target is moved to in the same call', () => {
		const r = run({
			updateItems: [{ id: 'lt', timelineStart: 10 }],
			addSounds: [{ kind: 'whoosh', follow: { item: 'lt' } }]
		}, makeDoc(), assetsFor({ kind: 'whoosh' }))
		expect(r.diff.addItems![0].timelineStart).toBeCloseTo(10 - 0.084)
	})

	it('drops what it cannot do, and says why', () => {
		const r = run({
			addSounds: [
				{ kind: 'kazoo', atSec: 1 },
				{ kind: 'pop' },
				{ kind: 'pop', follow: { item: 'ghost' } }
			]
		}, makeDoc(), assetsFor({ kind: 'pop' }))
		expect(r.diff.addItems).toBeUndefined()
		expect(r.droppedOps[0]).toMatch(/unknown sound "kazoo". The synth makes: click, key/)
		expect(r.droppedOps[1]).toMatch(/say when/)
		expect(r.droppedOps[2]).toMatch(/no such clip/)
	})

	it('drops a sound that was not rendered rather than guessing a file', () => {
		const r = run({ addSounds: [{ kind: 'pop', atSec: 1 }] })
		expect(r.droppedOps[0]).toMatch(/could not be rendered/)
	})

	it('applies cleanly: the diff validates against the document', () => {
		const doc = makeDoc()
		const assets = assetsFor({ kind: 'whoosh' })
		const r = run({ addSounds: [{ kind: 'whoosh', follow: { item: 'lt' } }] }, doc, assets)
		const state = JSON.parse(JSON.stringify({ tracks: doc.tracks, timeline: doc.timeline }))
		const out = applyTimelineDiff(state, r.diff, [...doc.media, ...assets.values()])
		expect(out.errors).toEqual([])
		expect(state.timeline).toHaveLength(3)
	})
})

// ===== setSounds =====

describe('setSounds', () => {
	const whoosh = soundAsset({ kind: 'whoosh' })
	const sound: TimelineItem = {
		id: 's1', trackId: 'a3', sourceAssetId: whoosh.id, label: 'Whoosh', timelineStart: 2.916, in: 0, out: 0.5, speed: 1,
		preservePitch: true, duration: 0.5, bind: { itemId: 'lt', at: 'start', leadSec: 0.084 }
	}
	const withSound = () => makeDoc({
		media: [video, whoosh], tracks: [...makeDoc().tracks, track('a3', 'audio', 'A3', 'sfx')], timeline: [lowerThird, clip, sound]
	})

	it('lists the recipes a change needs rendered, merged with what the sound already is', () => {
		const recipes = soundRecipesOf({ setSounds: [{ id: 's1', pitch: 2 }] }, withSound())
		expect(recipes).toHaveLength(1)
		expect(recipes[0]).toMatchObject({ kind: 'whoosh', pitch: 2, levelDb: -17 })
	})

	it('points the clip at the new recipe and keeps following', () => {
		const next = soundAsset({ kind: 'whoosh', pitch: 2 })
		const r = run({ setSounds: [{ id: 's1', pitch: 2 }] }, withSound(), new Map([[recipeKey({ kind: 'whoosh', pitch: 2 }), next]]))
		const update = r.diff.updateItems!.find((u) => u.id === 's1')!
		expect(update.sourceAssetId).toBe(next.id)
		expect(update.label).toBe('Whoosh')
		expect(r.droppedOps).toEqual([])
	})

	it('changes the kind from that kind’s defaults, with its own lead', () => {
		const swish = soundAsset({ kind: 'swish' })
		const r = run({ setSounds: [{ id: 's1', kind: 'swish' }] }, withSound(), new Map([[recipeKey({ kind: 'swish' }), swish]]))
		const update = r.diff.updateItems!.find((u) => u.id === 's1')!
		expect(update.sourceAssetId).toBe(swish.id)
		expect(update.bind).toMatchObject({ itemId: 'lt', leadSec: 0.02 })
	})

	it('moves a sound to another moment, or lets it go', () => {
		const move = run({ setSounds: [{ id: 's1', follow: { item: 'c1', at: 'end' } }] }, withSound())
		expect(move.diff.updateItems!.find((u) => u.id === 's1')!.bind).toMatchObject({ itemId: 'c1', at: 'end' })
		// The follower is then placed on its new moment: the end of the clip, less its lead.
		expect(move.diff.updateItems!.find((u) => u.id === 's1')!.timelineStart).toBeCloseTo(10 - 0.084)

		const free = run({ setSounds: [{ id: 's1', unfollow: true }] }, withSound())
		const update = free.diff.updateItems!.find((u) => u.id === 's1')!
		expect('bind' in update && update.bind === undefined).toBe(true)
	})

	it('refuses to treat something that is not a synthesised sound as one', () => {
		const r = run({ setSounds: [{ id: 'c1', pitch: 1 }] }, withSound())
		expect(r.droppedOps[0]).toMatch(/not a synthesised sound/)
		expect(soundRecipesOf({ setSounds: [{ id: 'c1', pitch: 1 }] }, withSound())).toEqual([])
	})
})

// ===== followers =====

describe('followers', () => {
	const whoosh = soundAsset({ kind: 'whoosh' })
	const sound: TimelineItem = {
		id: 's1', trackId: 'a3', sourceAssetId: whoosh.id, label: 'Whoosh', timelineStart: 2.916, in: 0, out: 0.5, speed: 1,
		preservePitch: true, duration: 0.5, bind: { itemId: 'lt', at: 'start', leadSec: 0.084 }
	}
	const doc = () => makeDoc({ media: [video, whoosh], tracks: [...makeDoc().tracks, track('a3', 'audio', 'A3', 'sfx')], timeline: [lowerThird, clip, sound] })

	it('goes with the moment it follows when an edit moves it, in the same diff', () => {
		const r = run({ updateItems: [{ id: 'lt', timelineStart: 8 }] }, doc())
		const follower = r.diff.updateItems!.find((u) => u.id === 's1')!
		expect(follower.timelineStart).toBeCloseTo(8 - 0.084)
	})

	it('leaves a sound alone when what it follows did not move', () => {
		const r = run({ updateItems: [{ id: 'c1', label: 'renamed' }] }, doc())
		expect(r.diff.updateItems!.find((u) => u.id === 's1')).toBeUndefined()
	})

	it('lets go of a sound whose clip an edit removed', () => {
		const r = run({ removeItemIds: ['lt'] }, doc())
		const follower = r.diff.updateItems!.find((u) => u.id === 's1')!
		expect('bind' in follower && follower.bind === undefined).toBe(true)
	})
})

// ===== setTrackRoles =====

describe('setTrackRoles', () => {
	it('marks an audio track, and clears one', () => {
		const r = run({ setTrackRoles: [{ trackId: 'a1', role: 'music' }] })
		expect(r.diff.removeTrackIds).toEqual(['a1'])
		expect(r.diff.addTracks![0]).toMatchObject({ id: 'a1', role: 'music' })

		const clear = run({ setTrackRoles: [{ trackId: 'a1', role: 'none' }] })
		expect(clear.diff.addTracks![0].role).toBeUndefined()
	})

	it('refuses a video track, an unknown track and a role that is not one', () => {
		const r = run({ setTrackRoles: [
			{ trackId: 'v1', role: 'sfx' }, { trackId: 'zz', role: 'sfx' }, { trackId: 'a1', role: 'bed' as never }
		] })
		expect(r.droppedOps).toHaveLength(3)
		expect(r.diff.addTracks).toBeUndefined()
	})

	it('does nothing for a role the track already has', () => {
		expect(run({ setTrackRoles: [{ trackId: 'a1', role: 'voice' }] }).diff.addTracks).toBeUndefined()
	})
})

describe('opsMakeSound', () => {
	it('is what the sound permission guards: making or changing a sound, not a role', () => {
		expect(opsMakeSound({ addSounds: [{ kind: 'pop', atSec: 1 }] })).toBe(true)
		expect(opsMakeSound({ setSounds: [{ id: 'x', pitch: 1 }] })).toBe(true)
		expect(opsMakeSound({ setTrackRoles: [{ trackId: 'a', role: 'sfx' }] })).toBe(false)
		expect(opsMakeSound({})).toBe(false)
	})
})
