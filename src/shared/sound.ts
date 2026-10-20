/**
 * Sound that follows picture.
 *
 * A sound effect is only right if it lands on the thing it is for, and stays
 * there when that thing moves. This is the model for it: a sound clip can
 * FOLLOW a moment on another clip (a motion layer's entrance, its exit, a cut),
 * and `suggestCues` reads the timeline to find the moments worth a sound.
 *
 * Pure, like everything in shared/: the renderer, the main process and the MCP
 * tools all ask the same questions of the same functions.
 */
import type { SoundBinding, TimelineItem } from './types'
import type { TimelineState } from './timeline'
import { resolveMoments, isMotionTrack } from './motion'
import { presetOf, soundLead, type SoundKind, type SoundRecipe } from './synth'

export type { SoundBinding } from './types'

/** Seconds on the timeline that a binding points at. */
export function bindTime(target: TimelineItem, at: SoundBinding['at']): number {
	const end = target.timelineStart + target.duration
	if (at === 'start') return target.timelineStart
	if (at === 'end') return end
	// 'out': where a motion layer's exit begins. Anything else has no exit of
	// its own, so it is simply its end.
	if (!target.motion) return end
	const out = resolveMoments(target.motion, target.duration).find((m) => m.name === 'out')
	return out ? target.timelineStart + out.start : end
}

/**
 * Where a following sound should START: its target moment, less the lead that
 * lets the sound's own hit land on it (a whoosh swells before it peaks).
 */
export function boundStart(target: TimelineItem, bind: SoundBinding, fallbackLeadSec = 0): number {
	const lead = bind.leadSec ?? fallbackLeadSec
	return Math.max(0, bindTime(target, bind.at) - lead)
}

/**
 * Put every following sound where its moment now is. A sound whose target is
 * gone stops following (and stays where it was). Returns whether anything moved,
 * so a caller can tell "nothing to do" from "write it back".
 */
export function applySoundBindings(state: Pick<TimelineState, 'timeline'>): boolean {
	let changed = false
	for (const item of state.timeline) {
		if (!item.bind) continue
		const target = state.timeline.find((t) => t.id === item.bind!.itemId)
		if (!target || target.id === item.id) {
			delete item.bind
			changed = true
			continue
		}
		const start = boundStart(target, item.bind)
		if (Math.abs(start - item.timelineStart) > 1e-6) {
			item.timelineStart = start
			changed = true
		}
	}
	return changed
}

// ---------------------------------------------------------------- cues

/** One moment worth a sound, and the sound it suggests. */
export interface SoundCue {
	/** Stable for the same moment, so a list can keep its ticks between reads. */
	id: string
	atSec: number
	/** "M1 · Lower third · in". */
	label: string
	bind: SoundBinding
	kind: SoundKind
	/** Why this sound: one short clause. */
	reason: string
	/** Something following this exact moment already: nothing to add. */
	taken: boolean
	/** Worth adding by default (an end card is optional: it can be a lot). */
	suggested: boolean
}

/** What each motion template wants when it comes on and when it leaves. */
const MOTION_SOUNDS: Record<string, { in: SoundKind; out?: SoundKind; reasonIn: string }> = {
	'lower-third': { in: 'whoosh', out: 'pop', reasonIn: 'it slides in' },
	'title-card': { in: 'appear', reasonIn: 'a card appears' },
	'chapter-card': { in: 'appear', reasonIn: 'a chapter starts' },
	'pull-quote': { in: 'appear', reasonIn: 'a quote appears' },
	'stat-counter': { in: 'rise', reasonIn: 'a number builds' },
	'callout-ring': { in: 'chime', reasonIn: 'it points at something' },
	'bar-reveal': { in: 'rise', reasonIn: 'bars grow' }
}
const CUSTOM_MOTION = { in: 'whoosh' as SoundKind, out: 'pop' as SoundKind, reasonIn: 'it comes in' }

const sameMoment = (item: TimelineItem, target: string, at: SoundBinding['at']) =>
	!!item.bind && item.bind.itemId === target && item.bind.at === at

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

/**
 * Read the timeline for moments worth a sound: a motion layer coming in and
 * going out, a cut between two clips on the base track, a transition, an end
 * card. The same list is what a person ticks through in "Sound the motion" and
 * what an agent reads with `suggest_cues`.
 *
 * Sorted by time; moments that already have a following sound are kept in the
 * list, marked `taken`, so the answer to "what is left?" is a filter.
 */
export function suggestCues(state: Pick<TimelineState, 'timeline' | 'tracks'>): SoundCue[] {
	const { timeline, tracks } = state
	const cues: SoundCue[] = []
	const trackOf = (item: TimelineItem) => tracks.find((t) => t.id === item.trackId)
	const taken = (id: string, at: SoundBinding['at']) => timeline.some((i) => sameMoment(i, id, at))
	const lastEnd = Math.max(0, ...timeline.filter((i) => !i.bind).map((i) => i.timelineStart + i.duration))

	for (const item of timeline) {
		if (item.bind) continue // a sound itself
		const track = trackOf(item)
		if (!track || track.hidden) continue
		const name = `${track.name} · ${item.label || (item.motion ? 'Motion layer' : 'Clip')}`

		if (item.motion && isMotionTrack(track)) {
			const spec = (item.motion.template && MOTION_SOUNDS[item.motion.template]) || CUSTOM_MOTION
			const isEndCard = item.timelineStart + item.duration >= lastEnd - 0.5 && item.motion.template === 'title-card'
			cues.push({
				id: `${item.id}:start`, atSec: bindTime(item, 'start'), label: `${name} · in`,
				bind: { itemId: item.id, at: 'start' }, kind: isEndCard ? 'resolve' : spec.in,
				reason: isEndCard ? 'the end card' : spec.reasonIn,
				taken: taken(item.id, 'start'), suggested: !isEndCard
			})
			if ('out' in spec && spec.out) {
				cues.push({
					id: `${item.id}:out`, atSec: bindTime(item, 'out'), label: `${name} · out`,
					bind: { itemId: item.id, at: 'out' }, kind: spec.out, reason: 'it leaves',
					taken: taken(item.id, 'out'), suggested: true
				})
			}
			continue
		}

		if (track.kind !== 'video' || item.text || item.generator) continue
		// A cut: a clip starting where another on the same track ends.
		const before = timeline.find((o) =>
			o.id !== item.id && o.trackId === item.trackId && !o.bind &&
			Math.abs(o.timelineStart + o.duration - item.timelineStart) < 0.05)
		if (before) {
			const incoming = item.transition?.in
			const outgoing = before.transition?.out
			const wipe = !!(incoming || outgoing)
			cues.push({
				id: `${item.id}:start`, atSec: bindTime(item, 'start'), label: `Cut · ${before.label || 'clip'} → ${item.label || 'clip'}`,
				bind: { itemId: item.id, at: 'start' }, kind: wipe ? 'whoosh' : 'swish',
				reason: wipe ? 'a transition' : 'a cut',
				taken: taken(item.id, 'start'), suggested: true
			})
		}
	}

	return cues.sort((a, b) => a.atSec - b.atSec || a.id.localeCompare(b.id))
}

/** A cue as a sentence, for a list or an agent: "0:03.0 · Lower third · in → whoosh". */
export const describeCue = (c: SoundCue): string => `${clock(c.atSec)} · ${c.label} → ${presetOf(c.kind).label.toLowerCase()}`

/** The recipe a cue starts from, and how early its sound should begin. */
export function cueRecipe(c: SoundCue, extra?: Partial<SoundRecipe>): SoundRecipe & { kind: SoundKind } {
	return { kind: c.kind, ...extra }
}

export const cueLead = (c: SoundCue, extra?: Partial<SoundRecipe>): number => soundLead(cueRecipe(c, extra))

/** An audio track that can hold a sound over [start, start + length), or null. */
export function freeSoundTrack(
	state: Pick<TimelineState, 'timeline' | 'tracks'>, start: number, length: number, ignoreItemId?: string
): string | null {
	const sfx = state.tracks.filter((t) => t.kind === 'audio' && t.role === 'sfx' && !t.locked)
	for (const track of sfx) {
		const clash = state.timeline.some((i) =>
			i.trackId === track.id && i.id !== ignoreItemId &&
			i.timelineStart < start + length - 1e-6 && i.timelineStart + i.duration > start + 1e-6)
		if (!clash) return track.id
	}
	return null
}
