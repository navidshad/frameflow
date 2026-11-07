import { clock } from './agentFeed'
import { isMotionTrack } from './motion'
import { computeContentEnd, itemDuration } from './timeline'
import type { EditorDocument, TimelineItem } from './types'

/**
 * The review FrameFlow holds an agent to after it edits.
 *
 * A model that says "done" is believed by nothing here. FrameFlow measures the
 * timeline before and after the turn itself and hands the agent what it found:
 * how long the cut really is now, the new joins it made (the places to look),
 * motion layers a cut left in pieces, and slivers of clips too short to see. The
 * agent then works a fixed checklist against those facts before its final
 * answer. These are the things a careful editor checks and a quick model skips;
 * measured here, they cannot be skipped by forgetting or reported by guessing.
 *
 * Pure: two documents in, facts and words out.
 */

/** Shorter than this, a motion layer is a piece a cut left behind, not a layer. */
export const MOTION_FRAGMENT_SEC = 1
/** Shorter than this, a picture clip is a sliver: a flash on screen, not a shot. */
export const SLIVER_SEC = 0.25
/** Two clips this close are touching: the point between them is a join. */
const TOUCH_SEC = 0.05
/** Lists in the review stop here; the agent can read the timeline for the rest. */
const LIST_MAX = 8

export interface Spot { label: string; atSec: number; durationSec: number }

export interface ReviewFacts {
	lengthBeforeSec: number
	lengthAfterSec: number
	itemsBefore: number
	itemsAfter: number
	/** Joins between picture clips that did not exist before: where the cut can be seen. */
	newJoinsSec: number[]
	/** Motion layers that are new or shorter and now under a second: likely left in pieces. */
	motionFragments: Spot[]
	/** Picture clips that are new or shorter and now too short to see. */
	slivers: Spot[]
}

const trackById = (doc: EditorDocument) => new Map(doc.tracks.map((t) => [t.id, t]))

const isMotion = (doc: EditorDocument, item: TimelineItem, tracks = trackById(doc)) =>
	!!item.motion || isMotionTrack(tracks.get(item.trackId))

/** Footage on a picture track: what a viewer sees cut. Titles, generators and motion layers are not footage. */
const isPicture = (doc: EditorDocument, item: TimelineItem, tracks = trackById(doc)) => {
	const track = tracks.get(item.trackId)
	return track?.kind === 'video' && !isMotionTrack(track) && !!item.sourceAssetId && !item.text && !item.generator && !item.motion
}

const lengthOf = (item: TimelineItem) => itemDuration(item)
const nameOf = (item: TimelineItem) => item.label || item.motion?.template || item.id

/** "clipA>clipB" for each pair of touching picture clips, per track, with where the second starts. */
function joins(doc: EditorDocument): Map<string, number> {
	const tracks = trackById(doc)
	const byTrack = new Map<string, TimelineItem[]>()
	for (const item of doc.timeline) {
		if (!isPicture(doc, item, tracks)) continue
		byTrack.set(item.trackId, [...(byTrack.get(item.trackId) ?? []), item])
	}
	const found = new Map<string, number>()
	for (const items of byTrack.values()) {
		const sorted = [...items].sort((a, b) => a.timelineStart - b.timelineStart)
		for (let i = 1; i < sorted.length; i++) {
			const a = sorted[i - 1], b = sorted[i]
			if (Math.abs(b.timelineStart - (a.timelineStart + lengthOf(a))) <= TOUCH_SEC) found.set(`${a.id}>${b.id}`, b.timelineStart)
		}
	}
	return found
}

/** Items in `after` that are new, or shorter than they were, and now under `limit` seconds. */
function shrunkUnder(before: EditorDocument, after: EditorDocument, limit: number, keep: (item: TimelineItem) => boolean): Spot[] {
	const was = new Map(before.timeline.map((i) => [i.id, lengthOf(i)]))
	return after.timeline
		.filter(keep)
		.filter((item) => lengthOf(item) < limit)
		.filter((item) => !was.has(item.id) || lengthOf(item) < (was.get(item.id) ?? 0) - 0.01)
		.sort((a, b) => a.timelineStart - b.timelineStart)
		.map((item) => ({ label: nameOf(item), atSec: item.timelineStart, durationSec: lengthOf(item) }))
}

export function reviewFacts(before: EditorDocument, after: EditorDocument): ReviewFacts {
	const old = joins(before)
	const tracks = trackById(after)
	return {
		lengthBeforeSec: computeContentEnd(before.timeline),
		lengthAfterSec: computeContentEnd(after.timeline),
		itemsBefore: before.timeline.length,
		itemsAfter: after.timeline.length,
		newJoinsSec: [...joins(after)].filter(([key]) => !old.has(key)).map(([, at]) => at).sort((a, b) => a - b),
		motionFragments: shrunkUnder(before, after, MOTION_FRAGMENT_SEC, (item) => isMotion(after, item, tracks)),
		slivers: shrunkUnder(before, after, SLIVER_SEC, (item) => isPicture(after, item, tracks))
	}
}

const signed = (sec: number) => `${sec < 0 ? '−' : '+'}${Math.abs(sec).toFixed(1)} s`
const spots = (list: Spot[]) =>
	list.slice(0, LIST_MAX).map((s) => `"${s.label}" at ${clock(s.atSec)} (${s.durationSec.toFixed(2)} s)`).join(', ') +
	(list.length > LIST_MAX ? `, and ${list.length - LIST_MAX} more` : '')

export interface ReviewInput {
	/** The user's request, word for word. */
	request: string
	facts: ReviewFacts
	/** "V2", "V3": the revisions this turn made. */
	revisions: string[]
	/** Whether the agent has rendered a frame since its last edit. */
	lookedSinceEdit: boolean
	/** 1 for the first review; a later one is sent only when the work changed or the look was skipped. */
	round: number
}

/** The review message: what FrameFlow measured, then the checklist to work through before answering. */
export function reviewMessage(input: ReviewInput): string {
	const f = input.facts
	const change = f.lengthAfterSec - f.lengthBeforeSec
	const measured = [
		`- Timeline length: ${clock(f.lengthBeforeSec)} before this turn, ${clock(f.lengthAfterSec)} now (${signed(change)}).`,
		`- Items on the timeline: ${f.itemsBefore} before, ${f.itemsAfter} now. Revisions this turn: ${input.revisions.join(', ') || 'none'}.`,
		f.newJoinsSec.length
			? `- New joins between clips (look at both sides of each): ${f.newJoinsSec.slice(0, LIST_MAX).map(clock).join(', ')}${f.newJoinsSec.length > LIST_MAX ? `, and ${f.newJoinsSec.length - LIST_MAX} more` : ''}.`
			: '- No new joins between clips.',
		f.motionFragments.length
			? `- Motion layers now under ${MOTION_FRAGMENT_SEC} s, probably left in pieces by a cut: ${spots(f.motionFragments)}.`
			: '- No motion layer was left in pieces.',
		f.slivers.length
			? `- Picture clips now too short to see (under ${SLIVER_SEC} s): ${spots(f.slivers)}.`
			: '- No slivers of clips.',
		input.lookedSinceEdit ? '' : '- You have not looked at a frame since your last edit.'
	].filter(Boolean)

	return [
		input.round === 1
			? '[FrameFlow review] Before your final answer, check your work. This is what FrameFlow measured on the timeline:'
			: '[FrameFlow review, again] You changed the timeline after the last review, or did not look at it. Measured now:',
		...measured,
		'',
		'Work through this checklist, using your tools:',
		`1. Read the request again: "${input.request.trim()}". Did you do all of it, and nothing it did not ask for?`,
		'2. Look at the result: render_frames at the new joins above (a moment before and after each), and wherever else you changed something. Check the picture and the motion layers over it.',
		'3. Fix what is wrong with apply_ops, or go back with revert_to_version: a layer left in pieces (join it back or remove it), a sliver, a gap, a cut through a word, a graphic no longer over what it belongs to. Then look again.',
		'4. Then give your final answer: what you changed and where, with the measured numbers above, not estimates. If you left something as it was on purpose, say why.'
	].join('\n')
}

/** The steps any careful edit follows, for the loop's system prompt. */
export const WORKING_CHECKLIST = [
	'How to work:',
	'1. Read what the request touches: the project, the timeline around it, and the media and transcript lines you need.',
	'2. For a request with more than one part, write the steps down with update_plan, and make the last one "Check the result".',
	'3. Edit with apply_ops.',
	'4. Check the result: render_frames at each place you changed, on both sides of each cut, and read the timeline there again. Look for gaps, slivers of clips, motion layers cut in two or no longer over what they belong to.',
	'5. Fix what is wrong, and check again.',
	'6. Answer with what you measured, not what you meant to do.',
	'After you edit, FrameFlow measures the timeline and sends you a review before your final answer; work through it.'
].join('\n')
