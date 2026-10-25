import type { EditorDocument, EditorOps, MulticamGroup, TimelineDiff, TimelineItem, Track } from './types'
import {
	anglesOf, camerasOf, nudgeCamera, placeGroup, planAngleSwitches, rederiveGroupItems, referenceOf, resolveCamera,
	soundChoicesOf, soundSpan
} from './multicam'
import { assignStretch, mergeSpeakers, patchSpeaker, resolveSpeaker } from './speakers'
import { itemEnd } from './timeline'
import { nextTrackName, nextTrackOrder, trackFamily } from './tracks'

/**
 * Camera-group edits as ops: placeMulticam, switchAngles, setMainSound,
 * nudgeAngle, and the speaker ops (setSpeaker, mergeSpeakers, setSpeakerTurns), mapped onto a TimelineDiff. ONE path for both callers: MCP's
 * apply_ops (main/editor/ops.ts) and the editor's own controls (the store),
 * so an agent's cut and a number-key cut are the same edit.
 */

export const opsTouchMulticam = (ops: EditorOps): boolean =>
	!!(ops.placeMulticam || ops.switchAngles || ops.setMainSound || ops.nudgeAngle || ops.setSpeaker || ops.mergeSpeakers || ops.setSpeakerTurns)

function resolveGroup(doc: EditorDocument, ref: string | undefined): MulticamGroup | string {
	const groups = doc.multicams ?? []
	if (!groups.length) return 'the project has no camera group yet (make one with make_multicam)'
	if (ref === undefined) {
		if (groups.length === 1) return groups[0]
		return `the project has ${groups.length} camera groups; name one (${groups.map((g) => `"${g.name}"`).join(', ')})`
	}
	const want = ref.trim().toLowerCase()
	return groups.find((g) => g.id === ref) ?? groups.find((g) => g.name.toLowerCase() === want)
		?? `there is no camera group "${ref}" (groups: ${groups.map((g) => `"${g.name}"`).join(', ')})`
}

/** Merge an update into the diff, so two ops touching one clip compose. */
function pushUpdate(diff: TimelineDiff, update: { id: string } & Partial<TimelineItem>) {
	const list = (diff.updateItems ||= [])
	const existing = list.find((u) => u.id === update.id)
	if (existing) Object.assign(existing, update)
	else list.push(update)
}

function pushGroup(diff: TimelineDiff, group: MulticamGroup) {
	const list = (diff.setMulticams ||= [])
	const at = list.findIndex((g) => g.id === group.id)
	if (at >= 0) list[at] = group
	else list.push(group)
}

/**
 * A lane free over [start, end) of the family, preferring the lowest; a new
 * one when every lane is busy there (added to `added` and to the diff).
 */
function freeLane(
	tracks: Track[], timeline: readonly TimelineItem[], family: 'video' | 'audio',
	start: number, end: number, diff: TimelineDiff, added: Track[], newId: () => string
): Track {
	const lanes = [...tracks, ...added]
		.filter((t) => trackFamily(t) === family && !t.locked && !t.hidden)
		.sort((a, b) => a.order - b.order)
	const busy = (t: Track) => timeline.some((i) => i.trackId === t.id && i.timelineStart < end - 1e-6 && itemEnd(i) > start + 1e-6)
	const free = lanes.find((t) => !busy(t))
	if (free) return free
	const all = [...tracks, ...added]
	const track: Track = {
		id: newId(), kind: family, name: nextTrackName(all, family), order: nextTrackOrder(all, family),
		muted: false, locked: false, hidden: false, height: 64
	}
	added.push(track)
	;(diff.addTracks ||= []).push(track)
	return track
}

/**
 * Map the camera-group ops onto `diff`. Runs against the document as it is
 * (plus what placeMulticam adds in the same call), so send group edits in an
 * apply_ops of their own rather than mixed with ripple edits.
 */
export function applyMulticamOps(
	ops: EditorOps,
	doc: EditorDocument,
	diff: TimelineDiff,
	droppedOps: string[],
	notes: string[],
	newId: () => string
): void {
	let timeline: TimelineItem[] = doc.timeline.filter((i) => !diff.removeItemIds?.includes(i.id))
	// Groups as this call leaves them, so a nudge and a switch in one call compose.
	const groups = new Map((doc.multicams ?? []).map((g) => [g.id, g]))
	const live = (g: MulticamGroup) => groups.get(g.id) ?? g
	const addedTracks: Track[] = []

	const reGroup = (before: MulticamGroup, after: MulticamGroup, what: string) => {
		const { updates, adds, dropped, notes: trimmed } = rederiveGroupItems(timeline, before, after, doc.media, newId)
		notes.push(...trimmed.map((n) => `${what}: ${n}`))
		for (const u of updates) pushUpdate(diff, u)
		timeline = timeline.map((i) => ({ ...i, ...updates.find((u) => u.id === i.id) }))
		if (adds.length) {
			diff.addItems = [...(diff.addItems ?? []), ...adds]
			timeline = [...timeline, ...adds]
		}
		droppedOps.push(...dropped.map((d) => `${what}: ${d}`))
		groups.set(after.id, after)
		pushGroup(diff, after)
		if (updates.length) notes.push(`${what}: ${updates.length} clip(s) of "${after.name}" re-timed to stay in sync.`)
	}

	if (ops.placeMulticam) {
		const op = ops.placeMulticam
		const found = resolveGroup(doc, op.group)
		if (typeof found === 'string') droppedOps.push(`placeMulticam: ${found}`)
		else {
			const group = live(found)
			const span = soundSpan(group, doc.media)
			const end = timeline.reduce((m, i) => Math.max(m, itemEnd(i)), 0)
			const atSec = op.atSec ?? end
			const length = span ? (Math.min(span.end, op.toSec ?? span.end) - Math.max(span.start, op.fromSec ?? span.start)) : 0
			const video = freeLane(doc.tracks, timeline, 'video', atSec, atSec + length, diff, addedTracks, newId)
			const audio = freeLane(doc.tracks, timeline, 'audio', atSec, atSec + length, diff, addedTracks, newId)
			const placed = placeGroup(group, doc.media, {
				videoTrackId: video.id, audioTrackId: audio.id, atSec, newId,
				angle: op.angle, from: op.fromSec, to: op.toSec
			})
			if ('reason' in placed) droppedOps.push(`placeMulticam: ${placed.reason}`)
			else {
				diff.addItems = [...(diff.addItems ?? []), ...placed.items]
				timeline = [...timeline, ...placed.items]
				notes.push(`Placed "${group.name}" at ${round3(atSec)}s: sound on ${audio.name}, shots on ${video.name}. Cut between angles with switchAngles.`)
			}
		}
	}

	if (ops.setMainSound) {
		const found = resolveGroup(doc, ops.setMainSound.group)
		if (typeof found === 'string') droppedOps.push(`setMainSound: ${found}`)
		else {
			const group = live(found)
			const choices = soundChoicesOf(group, doc.media)
			const ref = ops.setMainSound.sound
			const camera = resolveCamera(choices, ref)
			if (!camera) {
				droppedOps.push(`setMainSound: "${ref}" is not a camera with sound (choices: ${choices.map((c, n) => `${n + 1} ${c.name}`).join(', ')})`)
			} else if (!camera.members.some((m) => m.assetId === group.soundAssetId)) {
				reGroup(group, { ...group, soundAssetId: camera.members[0].assetId }, `setMainSound ${camera.name}`)
			}
		}
	}

	if (ops.nudgeAngle) {
		const op = ops.nudgeAngle
		const found = resolveGroup(doc, op.group)
		if (typeof found === 'string') droppedOps.push(`nudgeAngle: ${found}`)
		else {
			const group = live(found)
			const cameras = camerasOf(group, doc.media)
			const camera = resolveCamera(cameras, op.angle)
			const reference = referenceOf(group)
			if (!camera) droppedOps.push(`nudgeAngle: there is no camera "${op.angle}" (cameras: ${cameras.map((c) => c.name).join(', ')})`)
			else if (!Number.isFinite(op.bySec) || op.bySec === 0) droppedOps.push('nudgeAngle: bySec must be a non-zero number of seconds')
			else if (reference && camera.members.some((m) => m.assetId === reference.assetId) && cameras.length > 1) {
				droppedOps.push(`nudgeAngle: ${camera.name} is the reference every other camera is measured against; nudge the others instead`)
			} else reGroup(group, nudgeCamera(group, camera.members[0].assetId, op.bySec), `nudgeAngle ${camera.name}`)
		}
	}

	// Speakers live on the group, so these only rewrite the group; no clip moves.
	const speakerEdit = (name: string, groupRef: string | undefined, edit: (g: MulticamGroup) => MulticamGroup | string) => {
		const found = resolveGroup(doc, groupRef)
		if (typeof found === 'string') { droppedOps.push(`${name}: ${found}`); return }
		const group = live(found)
		if (!group.speakers) {
			droppedOps.push(`${name}: "${group.name}" has no speakers yet (find_speakers first)`)
			return
		}
		const next = edit(group)
		if (typeof next === 'string') { droppedOps.push(`${name}: ${next}`); return }
		groups.set(next.id, next)
		pushGroup(diff, next)
	}

	if (ops.setSpeaker) {
		const op = ops.setSpeaker
		speakerEdit('setSpeaker', op.group, (group) => {
			let camera: string | null | undefined = undefined
			if (op.camera === null) camera = null
			else if (op.camera !== undefined) {
				const cam = resolveCamera(camerasOf(group, doc.media), op.camera)
				if (!cam) return `there is no camera "${op.camera}" (cameras: ${camerasOf(group, doc.media).map((c, n) => `${n + 1} ${c.name}`).join(', ')})`
				camera = cam.key
			}
			const next = patchSpeaker(group, op.speaker, { name: op.name, camera, framing: op.framing, color: op.color })
			if (typeof next !== 'string') notes.push(`setSpeaker: ${resolveSpeaker(next.speakers, op.name ?? op.speaker)?.name ?? op.speaker} updated.`)
			return next
		})
	}

	if (ops.mergeSpeakers) {
		const op = ops.mergeSpeakers
		speakerEdit('mergeSpeakers', op.group, (group) => {
			const next = mergeSpeakers(group, op.from, op.into)
			if (typeof next !== 'string') notes.push(`mergeSpeakers: ${resolveSpeaker(group.speakers, op.from)?.name} is now ${resolveSpeaker(group.speakers, op.into)?.name}.`)
			return next
		})
	}

	if (ops.setSpeakerTurns) {
		const op = ops.setSpeakerTurns
		speakerEdit('setSpeakerTurns', op.group, (group) => {
			let current: MulticamGroup = group
			for (const t of op.turns) {
				const next = assignStretch(current, t.fromSec, t.toSec, t.speaker)
				if (typeof next === 'string') return `${next} (stretch ${t.fromSec}–${t.toSec} s)`
				current = next
			}
			notes.push(`setSpeakerTurns: ${op.turns.length} stretch(es) set; a new analysis keeps them.`)
			return current
		})
	}

	if (ops.switchAngles) {
		const op = ops.switchAngles
		const found = resolveGroup(doc, op.group)
		if (typeof found === 'string') droppedOps.push(`switchAngles: ${found}`)
		else {
			const group = live(found)
			if (!timeline.some((i) => i.multicam?.groupId === group.id && i.multicam.role === 'shot')) {
				droppedOps.push(`switchAngles: "${group.name}" has no shots on the timeline yet (placeMulticam first)`)
			} else {
				const plan = planAngleSwitches(timeline, group, op.switches, doc.media, newId, op.untilSec)
				// Merged away: a clip this call added is simply not added; an existing one is removed.
				const merged = new Set(plan.removeIds)
				if (merged.size) {
					const addedNow = new Set((diff.addItems ?? []).map((i) => i.id))
					diff.addItems = diff.addItems?.filter((i) => !merged.has(i.id))
					const existing = plan.removeIds.filter((id) => !addedNow.has(id))
					if (existing.length) diff.removeItemIds = [...(diff.removeItemIds ?? []), ...existing]
					diff.updateItems = diff.updateItems?.filter((u) => !merged.has(u.id))
				}
				for (const u of plan.updates) pushUpdate(diff, u)
				// A piece split from a clip this same call adds is replaced, not added twice.
				const addedIds = new Set((diff.addItems ?? []).map((i) => i.id))
				for (const u of plan.updates) {
					if (addedIds.has(u.id)) {
						diff.addItems = diff.addItems!.map((i) => (i.id === u.id ? { ...i, ...u } : i))
						diff.updateItems = diff.updateItems?.filter((x) => x.id !== u.id)
					}
				}
				diff.addItems = [...(diff.addItems ?? []), ...plan.adds]
				droppedOps.push(...plan.dropped.map((d) => `switchAngles: ${d}`))
				notes.push(...plan.notes.map((n) => `switchAngles: ${n}`))
				const angles = anglesOf(group, doc.media)
				notes.push(`switchAngles: ${plan.switched} shot(s) now show another angle (${angles.map((c, n) => `${n + 1} ${c.name}`).join(', ')}).`)
			}
		}
	}
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
