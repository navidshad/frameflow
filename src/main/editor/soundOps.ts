import { v4 as uuidv4 } from 'uuid'
import type { EditorDocument, EditorOps, MediaAsset, SoundBinding, TimelineDiff, TimelineItem, Track } from '@shared/types'
import { isTrackRole } from '@shared/audio'
import { applySoundBindings, boundStart, freeSoundTrack } from '@shared/sound'
import { isSoundKind, presetOf, recipeKey, soundLead, soundLength, SOUND_PRESETS, type SoundRecipe } from '@shared/synth'
import { applyTimelineDiff, itemDuration } from '@shared/timeline'
import { nextTrackName, nextTrackOrder } from '@shared/tracks'

/**
 * Sound ops, mapped onto a TimelineDiff.
 *
 * Pure, like the rest of the ops mapping: nothing here renders a sound. The
 * caller (the apply_ops tool) renders each recipe first, with `soundRecipesOf`
 * saying which, and hands the finished assets in; this only places them. That
 * keeps the mapping testable without ffmpeg and keeps one rule for where a
 * sound lands, shared with the Sound tab (shared/sound.ts).
 */

type Add = NonNullable<EditorOps['addSounds']>[number]
type Set = NonNullable<EditorOps['setSounds']>[number]

const RECIPE_FIELDS = ['variant', 'pitch', 'levelDb', 'air', 'seed', 'durationSec'] as const

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** The recipe an entry asks for, or why it cannot be one. */
function recipeOf(entry: Add | Set, base?: Partial<SoundRecipe>): { recipe: SoundRecipe } | { error: string } {
	const kind = (entry.kind !== undefined ? entry.kind : base?.kind) as string | undefined
	if (!isSoundKind(kind)) {
		const names = SOUND_PRESETS.map((p) => p.kind).join(', ')
		return { error: `unknown sound "${String(kind)}". The synth makes: ${names}` }
	}
	// A change of kind starts from that kind's own defaults, not the old one's.
	const keep = base && kind === base.kind ? base : {}
	const recipe: SoundRecipe = { ...keep, kind }
	for (const field of RECIPE_FIELDS) {
		const v = num((entry as Record<string, unknown>)[field])
		if (v !== undefined) recipe[field] = v
	}
	return { recipe }
}

const synthOf = (doc: EditorDocument, item: TimelineItem): MediaAsset['synth'] | undefined =>
	doc.media.find((a) => a.id === item.sourceAssetId)?.synth

/**
 * Every recipe the sound ops need rendered, so the caller can make them before
 * mapping. Entries that are not valid are left out (the mapping drops them with
 * a reason).
 */
export function soundRecipesOf(ops: EditorOps, doc: EditorDocument): SoundRecipe[] {
	const out = new Map<string, SoundRecipe>()
	for (const add of ops.addSounds ?? []) {
		const r = recipeOf(add)
		if ('recipe' in r) out.set(recipeKey(r.recipe), r.recipe)
	}
	for (const set of ops.setSounds ?? []) {
		const item = doc.timeline.find((i) => i.id === set.id)
		const base = item ? synthOf(doc, item) : undefined
		if (!base) continue
		const r = recipeOf(set, base)
		if ('recipe' in r) out.set(recipeKey(r.recipe), r.recipe)
	}
	return [...out.values()]
}

/** True when the ops make or change a sound: what the "sound" permission guards. */
export const opsMakeSound = (ops: EditorOps): boolean => !!(ops.addSounds?.length || ops.setSounds?.length)

/** The lane role a generated sound belongs on, from what it is. */
const roleFor = (capability: 'speech' | 'sfx' | 'music'): 'voice' | 'music' | 'sfx' =>
	capability === 'speech' ? 'voice' : capability === 'music' ? 'music' : 'sfx'

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

export function applySoundOps(
	ops: EditorOps,
	doc: EditorDocument,
	diff: TimelineDiff,
	droppedOps: string[],
	notes: string[],
	assets: Map<string, MediaAsset>
): void {
	const removed = () => new Set(diff.removeItemIds ?? [])
	/** The timeline as this diff leaves it, so a sound can see what it is landing among. */
	const state = () => ({
		tracks: [...doc.tracks.filter((t) => !diff.removeTrackIds?.includes(t.id)), ...(diff.addTracks ?? [])],
		timeline: [...doc.timeline.filter((i) => !removed().has(i.id)), ...(diff.addItems ?? [])]
	})
	/** An item as this diff leaves it (a target the same call moved is where it moved to). */
	const nowItem = (id: string): TimelineItem | undefined => {
		const base = doc.timeline.find((i) => i.id === id) ?? diff.addItems?.find((i) => i.id === id)
		if (!base || removed().has(id)) return undefined
		const patch = diff.updateItems?.find((u) => u.id === id)
		if (!patch) return base
		const merged = { ...base, ...patch } as TimelineItem
		merged.duration = itemDuration(merged)
		return merged
	}
	const patchItem = (id: string, fields: Partial<TimelineItem>) => {
		const added = diff.addItems?.find((i) => i.id === id)
		if (added) return void Object.assign(added, fields)
		const list = (diff.updateItems ||= [])
		const existing = list.find((u) => u.id === id)
		if (existing) Object.assign(existing, fields)
		else list.push({ id, ...fields })
	}

	/** A following sound's binding, or why it cannot follow. */
	const bindingOf = (follow: NonNullable<Add['follow']>, recipe: SoundRecipe, label: string): SoundBinding | null => {
		const target = nowItem(follow.item)
		if (!target) {
			droppedOps.push(`${label}: cannot follow ${follow.item}: no such clip (read get_timeline for ids)`)
			return null
		}
		const at = follow.at === 'out' || follow.at === 'end' ? follow.at : 'start'
		return { itemId: target.id, at, leadSec: num(follow.leadSec) !== undefined ? Math.max(0, follow.leadSec!) : soundLead(recipe) }
	}

	const laneFor = (start: number, length: number, ignoreId?: string, role: 'voice' | 'music' | 'sfx' = 'sfx'): string => {
		const free = freeSoundTrack(state(), start, length, ignoreId, role)
		if (free) return free
		const tracks = state().tracks
		const track: Track = {
			id: uuidv4(), kind: 'audio', name: nextTrackName(tracks, 'audio'), order: nextTrackOrder(tracks, 'audio'),
			muted: false, locked: false, hidden: false, height: 48, role
		}
		;(diff.addTracks ||= []).push(track)
		return track.id
	}

	// ---- addSounds
	for (const [index, add] of (ops.addSounds ?? []).entries()) {
		const label = `addSounds[${index}]`
		const made = recipeOf(add)
		if ('error' in made) { droppedOps.push(`${label}: ${made.error}`); continue }
		const asset = assets.get(recipeKey(made.recipe))
		if (!asset) { droppedOps.push(`${label}: the ${made.recipe.kind} sound could not be rendered`); continue }

		let bind: SoundBinding | undefined
		if (add.follow) {
			const b = bindingOf(add.follow, made.recipe, label)
			if (!b) continue
			bind = b
		} else if (num(add.atSec) === undefined) {
			droppedOps.push(`${label}: say when: atSec (timeline seconds), or follow {item, at}`)
			continue
		}

		const length = asset.metadata?.duration || soundLength(made.recipe)
		const target = bind ? nowItem(bind.itemId)! : undefined
		const start = target && bind ? boundStart(target, bind) : Math.max(0, add.atSec!)
		const trackId = laneFor(start, length)
		const item: TimelineItem = {
			id: uuidv4(), trackId, sourceAssetId: asset.id, timelineStart: start, in: 0, out: length,
			speed: 1, preservePitch: true, duration: length, label: asset.name,
			...(bind ? { bind } : {})
		}
		;(diff.addItems ||= []).push(item)
		notes.push(`Added ${presetOf(made.recipe.kind).label.toLowerCase()} at ${clock(start)}${bind ? ` (follows ${nowItem(bind.itemId)?.label || 'a clip'})` : ''}.`)
	}

	// ---- placeAudio: a sound or voice a provider made, already an asset
	for (const [index, place] of (ops.placeAudio ?? []).entries()) {
		const label = `placeAudio[${index}]`
		const asset = assets.get(`asset:${place.asset}`) ?? doc.media.find((a) => a.id === place.asset)
		if (!asset || asset.kind !== 'audio') {
			droppedOps.push(`${label}: no audio ${place.asset}. generate_audio returns the asset id to use`)
			continue
		}
		const length = asset.metadata?.duration || 0
		if (length <= 0) { droppedOps.push(`${label}: ${asset.name} has no length yet`); continue }
		let bind: SoundBinding | undefined
		if (place.follow) {
			const b = bindingOf(place.follow, { kind: 'pop' }, label)
			if (!b) continue
			bind = { ...b, leadSec: num(place.follow.leadSec) !== undefined ? Math.max(0, place.follow.leadSec!) : 0 }
		} else if (num(place.atSec) === undefined) {
			droppedOps.push(`${label}: say when: atSec (timeline seconds), or follow {item, at}`)
			continue
		}
		const target = bind ? nowItem(bind.itemId)! : undefined
		const start = target && bind ? boundStart(target, bind) : Math.max(0, place.atSec!)
		const role = roleFor(asset.generated?.capability ?? 'sfx')
		const item: TimelineItem = {
			id: uuidv4(), trackId: laneFor(start, length, undefined, role), sourceAssetId: asset.id, timelineStart: start, in: 0, out: length,
			speed: 1, preservePitch: true, duration: length, label: asset.name,
			...(typeof place.gain === 'number' ? { gain: Math.max(0, Math.min(2, place.gain)) } : {}),
			...(bind ? { bind } : {})
		}
		;(diff.addItems ||= []).push(item)
		notes.push(`Placed ${asset.name} at ${clock(start)}.`)
	}

	// ---- setSounds
	for (const [index, set] of (ops.setSounds ?? []).entries()) {
		const label = `setSounds[${index}]`
		const item = nowItem(set.id)
		const base = item ? synthOf(doc, item) : undefined
		if (!item || !base) { droppedOps.push(`${label}: ${set.id} is not a synthesised sound on the timeline`); continue }
		const fields: Partial<TimelineItem> = {}

		const changesRecipe = set.kind !== undefined || RECIPE_FIELDS.some((f) => num((set as Record<string, unknown>)[f]) !== undefined)
		let recipe: SoundRecipe = base
		if (changesRecipe) {
			const made = recipeOf(set, base)
			if ('error' in made) { droppedOps.push(`${label}: ${made.error}`); continue }
			const asset = assets.get(recipeKey(made.recipe))
			if (!asset) { droppedOps.push(`${label}: the ${made.recipe.kind} sound could not be rendered`); continue }
			recipe = made.recipe
			const length = asset.metadata?.duration || soundLength(recipe)
			Object.assign(fields, {
				sourceAssetId: asset.id, in: 0, out: length, duration: length / (item.speed || 1), label: asset.name
			})
			// A different kind of sound has its own lead: keep the hit on the moment.
			if (item.bind && set.kind !== undefined && set.kind !== base.kind && !set.follow) {
				fields.bind = { ...item.bind, leadSec: soundLead(recipe) }
			}
		}
		if (set.unfollow) {
			fields.bind = undefined
		} else if (set.follow) {
			const b = bindingOf(set.follow, recipe, label)
			if (!b) continue
			fields.bind = b
		}
		if (!Object.keys(fields).length) { droppedOps.push(`${label}: nothing to change`); continue }
		patchItem(set.id, fields)
		notes.push(`Changed ${item.label || 'a sound'}${fields.bind ? ' (follows a moment)' : ''}.`)
	}

	// ---- setTrackRoles
	for (const [index, entry] of (ops.setTrackRoles ?? []).entries()) {
		const label = `setTrackRoles[${index}]`
		const track = state().tracks.find((t) => t.id === entry.trackId)
		if (!track) { droppedOps.push(`${label}: unknown track ${entry.trackId}`); continue }
		if (track.kind !== 'audio') { droppedOps.push(`${label}: ${track.name} is not an audio track`); continue }
		if (entry.role !== 'none' && !isTrackRole(entry.role)) { droppedOps.push(`${label}: role must be voice, music, sfx or none`); continue }
		const role = entry.role === 'none' ? undefined : entry.role
		if (track.role === role) continue
		const next: Track = { ...track }
		if (role) next.role = role
		else delete next.role
		const added = diff.addTracks?.findIndex((t) => t.id === track.id) ?? -1
		if (added >= 0) diff.addTracks![added] = next
		else {
			// Track updates ride as a remove + add of the same id (applyTimelineDiff
			// removes before it adds).
			;(diff.removeTrackIds ||= []).push(track.id)
			;(diff.addTracks ||= []).push(next)
		}
		notes.push(`${track.name} is now ${role ?? 'unassigned'}.`)
	}
}

/**
 * Sounds that follow a moment go with it: after every other op has landed, move
 * each follower to where its moment now is. Written into the same diff, so the
 * agent's one edit and the sounds that follow it are one revision, one undo.
 */
export function applyFollowers(doc: EditorDocument, diff: TimelineDiff, extraAssets: MediaAsset[] = []): void {
	const anyBound = doc.timeline.some((i) => i.bind) || (diff.addItems ?? []).some((i) => i.bind) ||
		(diff.updateItems ?? []).some((u) => u.bind)
	if (!anyBound) return

	const after = JSON.parse(JSON.stringify({ tracks: doc.tracks, timeline: doc.timeline }))
	applyTimelineDiff(after, diff, [...doc.media, ...extraAssets])
	const settled = JSON.parse(JSON.stringify(after))
	applySoundBindings(settled)

	const was = new Map<string, TimelineItem>(after.timeline.map((i: TimelineItem) => [i.id, i]))
	for (const item of settled.timeline as TimelineItem[]) {
		const before = was.get(item.id)
		if (!before) continue
		if (Math.abs(before.timelineStart - item.timelineStart) > 1e-6) {
			const added = diff.addItems?.find((i) => i.id === item.id)
			if (added) { added.timelineStart = item.timelineStart; continue }
			const list = (diff.updateItems ||= [])
			const existing = list.find((u) => u.id === item.id)
			if (existing) existing.timelineStart = item.timelineStart
			else list.push({ id: item.id, timelineStart: item.timelineStart })
		}
		// A binding that let go (its target is gone) is written back too.
		if (before.bind && !item.bind) {
			const existing = (diff.updateItems ||= []).find((u) => u.id === item.id)
			if (existing) existing.bind = undefined
			else diff.updateItems!.push({ id: item.id, bind: undefined })
		}
	}
}

