import type { MediaAsset, MulticamGroup, MulticamMember, TimelineItem } from './types'
import type { TranscriptEntry } from './captions'
import { MIN_ITEM_DURATION, itemDuration, type RippleChange } from './timeline'
import { planRangeRemoval } from './rangeEdit'

/**
 * Multicam: several cameras that recorded the same moment, on one clock.
 *
 * The group's clock ("group time") is the reference file's own time. Every
 * other file sits on it by a straight line, `group = offset + source * rate`,
 * measured by the sync (main/multicam/sync.ts) and stored on the group.
 *
 * A CAMERA (an angle, or a sound recorder) is one or more files: cameras split
 * long recordings into chunks, and each chunk keeps its own measured line.
 * Number keys, MCP and the Inspector pick cameras; which FILE plays is decided
 * here by time.
 *
 * On the timeline a group is ordinary clips: SHOTS (one camera each, on a
 * video track) over the main SOUND (on an audio track). Their `in`/`out` are
 * plain source seconds worked out from the group's lines, which is why the
 * export, the monitor, captions and transitions handle a multicam edit with
 * no change. A clip reads one file, so a shot or the sound crossing a file
 * boundary is two clips back to back. Everything that has to stay true between
 * the shots and the sound lives in this file, so the editor and MCP cannot
 * answer differently.
 *
 * Drift: a file whose clock runs `rate` group seconds per source second plays
 * at `sound.rate / file.rate` for picture and sound to stay locked over a long
 * shot. That ratio is the clip's `speed` (0.99999 and the like), so an hour of
 * one uncut shot stays in sync to the last frame.
 */

type Media = readonly Pick<MediaAsset, 'id' | 'kind' | 'metadata'>[]

// ===== The group's clock =====

export const toGroupTime = (member: Pick<MulticamMember, 'offset' | 'rate'>, sourceSec: number): number =>
	member.offset + sourceSec * member.rate

export const toSourceTime = (member: Pick<MulticamMember, 'offset' | 'rate'>, groupSec: number): number =>
	(groupSec - member.offset) / member.rate

export const memberOf = (group: MulticamGroup, assetId: string): MulticamMember | undefined =>
	group.members.find((m) => m.assetId === assetId)

const durationOf = (media: readonly Pick<MediaAsset, 'id' | 'metadata'>[], assetId: string): number =>
	media.find((a) => a.id === assetId)?.metadata?.duration ?? 0

/** Where a file's recording sits on the group clock. */
export function memberSpan(member: MulticamMember, durationSec: number): { start: number; end: number } {
	return { start: toGroupTime(member, 0), end: toGroupTime(member, durationSec) }
}

/** The reference file: the one everything else was measured against. */
export const referenceOf = (group: MulticamGroup): MulticamMember | undefined =>
	group.members.find((m) => m.sync.method === 'reference') ?? group.members[0]

// ===== Cameras =====

/** One camera: its files in recording order. */
export interface Camera {
	key: string
	name: string
	members: MulticamMember[]
	/** True when its files have a picture: an ANGLE. A sound recorder has none. */
	hasPicture: boolean
}

const cameraKey = (m: Pick<MulticamMember, 'camera' | 'assetId'>) => m.camera ?? m.assetId

/** Every camera of the group, angles first in member order, then sound-only ones. */
export function camerasOf(group: MulticamGroup, media: Media): Camera[] {
	const byKey = new Map<string, Camera>()
	for (const m of group.members) {
		const key = cameraKey(m)
		const asset = media.find((a) => a.id === m.assetId)
		const cam = byKey.get(key) ?? { key, name: m.camera ?? m.name, members: [], hasPicture: false }
		cam.members.push(m)
		if (asset?.kind === 'video') cam.hasPicture = true
		byKey.set(key, cam)
	}
	for (const cam of byKey.values()) cam.members.sort((a, b) => a.offset - b.offset)
	// Numbered by name, so the angle a number key picks is the one its folder
	// says: Cam01 is 1 and Cam02 is 2, whichever file was the reference.
	const all = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
	return [...all.filter((c) => c.hasPicture), ...all.filter((c) => !c.hasPicture)]
}

/** The cameras with a picture: the group's angles, numbered 1, 2… in this order. */
export const anglesOf = (group: MulticamGroup, media: Media): Camera[] =>
	camerasOf(group, media).filter((c) => c.hasPicture)

/** The camera a file belongs to. */
export const cameraOf = (group: MulticamGroup, media: Media, assetId: string): Camera | undefined =>
	camerasOf(group, media).find((c) => c.members.some((m) => m.assetId === assetId))

/** The camera whose sound plays under every shot. */
export const soundCameraOf = (group: MulticamGroup, media: Media): Camera | undefined =>
	cameraOf(group, media, group.soundAssetId)

/** Cameras that recorded sound — the choices for the main sound. */
export function soundChoicesOf(group: MulticamGroup, media: Media): Camera[] {
	return camerasOf(group, media).filter((c) => c.members.some((m) => {
		const asset = media.find((a) => a.id === m.assetId)
		return !!asset && (asset.kind === 'audio' || (asset.kind === 'video' && asset.metadata?.hasAudio !== false))
	}))
}

/** A camera's files on the group clock, in order. */
export function cameraSpans(camera: Camera, media: Media): Array<{ start: number; end: number; member: MulticamMember }> {
	return camera.members.map((member) => ({ ...memberSpan(member, durationOf(media, member.assetId)), member }))
		.sort((a, b) => a.start - b.start)
}

/** The camera's file recording at a group instant (a frame of slack at the joins). */
export function memberAt(camera: Camera, groupSec: number, media: Media): MulticamMember | undefined {
	const spans = cameraSpans(camera, media)
	return spans.find((s) => groupSec >= s.start - 1e-6 && groupSec < s.end - 1e-6)?.member
		?? spans.find((s) => groupSec >= s.start - 0.04 && groupSec <= s.end + 0.04)?.member
}

/**
 * A camera's consecutive files that meet within a quarter second ARE one
 * recording, split by the camera: the sync measures each on its own and lands
 * them a few milliseconds apart, which would leave a click in the sound and a
 * frame's slip in the picture at every join. Each later file is moved to start
 * exactly where the one before it ends. A real gap (the camera stopped) stays.
 */
export function sealCameraJoins(group: MulticamGroup, media: Media, tolerance = 0.25): MulticamGroup {
	const moved = new Map<string, number>()
	for (const camera of camerasOf(group, media)) {
		let prevEnd: number | undefined
		for (const span of cameraSpans(camera, media)) {
			const shift = prevEnd !== undefined && Math.abs(span.start - prevEnd) < tolerance ? prevEnd - span.start : 0
			if (shift) moved.set(span.member.assetId, shift)
			prevEnd = span.end + shift
		}
	}
	if (!moved.size) return group
	return {
		...group,
		members: group.members.map((m) => moved.has(m.assetId) ? { ...m, offset: m.offset + moved.get(m.assetId)! } : m)
	}
}

/** How clean a camera's sound is: its files' measurements, weighted by length; the worst clipping. */
export function cameraSound(camera: Camera, media: Media): { snrDb: number; clipped: number } | undefined {
	const measured = camera.members.filter((m) => m.sound)
	if (!measured.length) return undefined
	const weight = (m: MulticamMember) => Math.max(1, durationOf(media, m.assetId))
	const total = measured.reduce((s, m) => s + weight(m), 0)
	return {
		snrDb: measured.reduce((s, m) => s + m.sound!.snrDb * weight(m), 0) / total,
		clipped: Math.max(...measured.map((m) => m.sound!.clipped))
	}
}

/** The stretch of the group clock the main sound covers: what a placed group can show. */
export function soundSpan(group: MulticamGroup, media: Media): { start: number; end: number } | null {
	const cam = soundCameraOf(group, media)
	if (!cam) return null
	const spans = cameraSpans(cam, media)
	return spans.length ? { start: spans[0].start, end: Math.max(...spans.map((s) => s.end)) } : null
}

/**
 * The speed a clip of `member` plays at so it stays locked to the main sound.
 * Exactly 1 when both clocks agree, which is the common case after a manual sync.
 */
export function shotSpeed(group: MulticamGroup, member: Pick<MulticamMember, 'rate'>): number {
	const sound = memberOf(group, group.soundAssetId)
	const ratio = (sound?.rate ?? 1) / member.rate
	// Below a part per billion the difference is float noise, not drift.
	return Math.abs(ratio - 1) < 1e-9 ? 1 : ratio
}

/**
 * The group-clock stretch a clip of this group shows. Null when the clip's
 * file is not (or no longer) in the group.
 */
export function itemGroupRange(
	item: Pick<TimelineItem, 'sourceAssetId' | 'in' | 'out'>,
	group: MulticamGroup
): { start: number; end: number } | null {
	const member = memberOf(group, item.sourceAssetId)
	if (!member) return null
	return { start: toGroupTime(member, item.in), end: toGroupTime(member, item.out) }
}

/** The group clock at a timeline instant inside a clip of the group. */
export function groupTimeAt(item: TimelineItem, group: MulticamGroup, timelineSec: number): number | null {
	const member = memberOf(group, item.sourceAssetId)
	if (!member) return null
	const source = item.in + (timelineSec - item.timelineStart) * (item.speed || 1)
	return toGroupTime(member, source)
}

// ===== Clips =====

export type ShotFields = Pick<TimelineItem, 'sourceAssetId' | 'in' | 'out' | 'speed' | 'duration' | 'label'>

/**
 * The fields that make a clip play `member` from the group instant
 * `groupStart` for `timelineDuration` seconds of timeline. Null, with the
 * reason, when that file was not recording for all of it.
 */
export function shotFor(
	group: MulticamGroup,
	member: MulticamMember,
	groupStart: number,
	timelineDuration: number,
	media: readonly Pick<MediaAsset, 'id' | 'metadata'>[]
): { fields: ShotFields } | { reason: string } {
	const speed = shotSpeed(group, member)
	const inSec = toSourceTime(member, groupStart)
	const outSec = inSec + timelineDuration * speed
	const length = durationOf(media, member.assetId)
	// A frame of slack either side: offsets are measured to the millisecond, and
	// refusing a shot over 5 ms of camera that is not there would be absurd.
	const slack = 0.04
	if (inSec < -slack || (length > 0 && outSec > length + slack)) {
		return { reason: `${member.name} was not recording for all of that stretch` }
	}
	const clampedIn = Math.max(0, inSec)
	const clampedOut = length > 0 ? Math.min(length, Math.max(outSec, clampedIn + MIN_ITEM_DURATION)) : outSec
	return {
		fields: {
			sourceAssetId: member.assetId,
			in: clampedIn,
			out: clampedOut,
			speed,
			duration: (clampedOut - clampedIn) / speed,
			label: member.camera ?? member.name
		}
	}
}

/** Re-point a shot at another file, keeping its place and length on the timeline. */
export function retargetShot(
	item: TimelineItem,
	group: MulticamGroup,
	member: MulticamMember,
	media: readonly Pick<MediaAsset, 'id' | 'metadata'>[]
): { fields: ShotFields } | { reason: string } {
	const start = groupTimeAt(item, group, item.timelineStart)
	if (start === null) return { reason: 'that clip is not part of this camera group' }
	return shotFor(group, member, start, itemDuration(item), media)
}

/** The group a clip belongs to, if any. */
export function groupOfItem(item: Pick<TimelineItem, 'multicam'>, groups: readonly MulticamGroup[] | undefined): MulticamGroup | undefined {
	const id = item.multicam?.groupId
	return id ? groups?.find((g) => g.id === id) : undefined
}

/**
 * What a person or an agent would call an angle: its 1-based number ("2"),
 * its camera name ("Cam02"), or any of its files' media id.
 */
export function resolveAngle(group: MulticamGroup, media: Media, ref: string | number): Camera | undefined {
	return resolveCamera(anglesOf(group, media), ref)
}

/** The same, among any list of cameras (the sound choices include recorders). */
export function resolveCamera(cameras: Camera[], ref: string | number): Camera | undefined {
	if (typeof ref === 'number' || /^\d+$/.test(String(ref).trim())) return cameras[Number(ref) - 1]
	const want = String(ref).trim().toLowerCase()
	return cameras.find((c) => c.members.some((m) => m.assetId === ref)) ??
		cameras.find((c) => c.name.toLowerCase() === want || c.key.toLowerCase() === want)
}

/**
 * The stretches of a shot a camera was recording, in timeline seconds, each
 * with the file that recorded it. Empty when it recorded none of it.
 */
export function recordedPieces(
	shot: TimelineItem,
	group: MulticamGroup,
	camera: Camera,
	media: Media
): Array<{ start: number; end: number; member: MulticamMember }> {
	const start = shot.timelineStart
	const end = start + itemDuration(shot)
	const g0 = groupTimeAt(shot, group, start)
	const g1 = groupTimeAt(shot, group, end)
	if (g0 === null || g1 === null || g1 <= g0) return []
	const toTimeline = (g: number) => start + ((g - g0) * (end - start)) / (g1 - g0)
	const out: Array<{ start: number; end: number; member: MulticamMember }> = []
	for (const span of cameraSpans(camera, media)) {
		const a = Math.max(g0, span.start)
		const b = Math.min(g1, span.end)
		if (b - a < MIN_ITEM_DURATION) continue
		out.push({ start: toTimeline(a), end: toTimeline(b), member: span.member })
	}
	return out
}

/**
 * The SHOT a clip belongs to, as the user sees it: the run of the group's
 * clips on its lane that play one camera back to back. A camera that split its
 * recording is several clips at a file join, and a join is not a cut: number
 * keys and Alt + number act on the whole run.
 */
export function shotRun(
	timeline: readonly TimelineItem[],
	shot: TimelineItem,
	group: MulticamGroup,
	media: Media
): { start: number; end: number } {
	const camera = cameraOf(group, media, shot.sourceAssetId)
	const same = (i: TimelineItem) => i.multicam?.groupId === group.id && i.multicam.role === 'shot' &&
		i.trackId === shot.trackId && !!camera && camera.members.some((m) => m.assetId === i.sourceAssetId)
	const lane = timeline.filter(same).sort((a, b) => a.timelineStart - b.timelineStart)
	let start = shot.timelineStart
	let end = shot.timelineStart + itemDuration(shot)
	for (let moved = true; moved;) {
		moved = false
		for (const i of lane) {
			const iEnd = i.timelineStart + itemDuration(i)
			if (Math.abs(iEnd - start) < MIN_ITEM_DURATION && i.timelineStart < start) { start = i.timelineStart; moved = true }
			if (Math.abs(i.timelineStart - end) < MIN_ITEM_DURATION && iEnd > end) { end = iEnd; moved = true }
		}
	}
	return { start, end }
}

export interface AngleSwitch {
	/** TIMELINE seconds where this angle starts. */
	atSec: number
	angle: string | number
}

export interface AngleSwitchPlan {
	updates: Array<{ id: string } & Partial<TimelineItem>>
	adds: TimelineItem[]
	/** Clips merged into their neighbour (one file played straight through). */
	removeIds: string[]
	dropped: string[]
	/** What changed less than asked (an angle that stopped early), in words. */
	notes: string[]
	/** How many shots now show a different angle. */
	switched: number
}

/**
 * Cut a group's shots so each switch's angle plays from its time until the
 * next switch (or until `untilSec`, or the end of the shots). Shots are split
 * where a switch lands inside one and where the angle's files join; nothing
 * moves and the sound is untouched.
 *
 * This is the one function behind number-key cutting, the Inspector's angle
 * row and MCP's switchAngles, so all three cut the same way.
 */
/** Whether two clips draw their source the same way: framing, transform, looks, key, text. */
function sameLook(a: TimelineItem, b: TimelineItem): boolean {
	const look = (i: TimelineItem) => JSON.stringify([i.transform ?? null, i.framing ?? null, i.effects?.length ? i.effects : null, i.key ?? null, i.text ?? null])
	return look(a) === look(b)
}

export function planAngleSwitches(
	timeline: readonly TimelineItem[],
	group: MulticamGroup,
	switches: readonly AngleSwitch[],
	media: Media,
	newId: () => string,
	untilSec?: number
): AngleSwitchPlan {
	const dropped: string[] = []
	const notes: string[] = []
	const ordered = [...switches]
		.filter((s) => Number.isFinite(Number(s.atSec)))
		.sort((a, b) => a.atSec - b.atSec)
	const shots = new Map<string, TimelineItem>()
	for (const item of timeline) {
		if (item.multicam?.groupId === group.id && item.multicam.role === 'shot') shots.set(item.id, { ...item })
	}
	const updated = new Set<string>()
	const added: TimelineItem[] = []
	const all = () => [...shots.values(), ...added]
	const shotsEnd = Math.max(0, ...all().map((s) => s.timelineStart + itemDuration(s)))

	const splitAt = (at: number) => {
		const hit = all().find((s) =>
			at > s.timelineStart + MIN_ITEM_DURATION && at < s.timelineStart + itemDuration(s) - MIN_ITEM_DURATION)
		if (!hit) return
		const speed = hit.speed || 1
		const cut = hit.in + (at - hit.timelineStart) * speed
		const right: TimelineItem = {
			...JSON.parse(JSON.stringify(hit)), id: newId(), timelineStart: at, in: cut,
			duration: hit.timelineStart + itemDuration(hit) - at, transition: undefined
		}
		delete (right as Partial<TimelineItem>).keyframes
		Object.assign(hit, { out: cut, duration: at - hit.timelineStart, transition: undefined })
		if (shots.has(hit.id)) updated.add(hit.id)
		added.push(right)
	}
	// The piece starting at `t`, within the same tolerance splitAt uses: a join
	// between two files and a split a microsecond away are one cut.
	const pieceAt = (t: number) => all()
		.filter((s) => Math.abs(s.timelineStart - t) < MIN_ITEM_DURATION)
		.sort((a, b) => Math.abs(a.timelineStart - t) - Math.abs(b.timelineStart - t))[0]

	let switched = 0
	for (const [i, sw] of ordered.entries()) {
		const camera = resolveAngle(group, media, sw.angle)
		if (!camera) {
			dropped.push(`switch at ${sw.atSec}s: there is no angle "${sw.angle}" (angles: ${anglesOf(group, media).map((c, n) => `${n + 1} ${c.name}`).join(', ')})`)
			continue
		}
		const from = sw.atSec
		const to = Math.min(ordered[i + 1]?.atSec ?? Infinity, untilSec ?? Infinity, shotsEnd)
		if (to - from < MIN_ITEM_DURATION) continue
		splitAt(from)
		if (Number.isFinite(to)) splitAt(to)
		for (const shot of [...all()]) {
			const start = shot.timelineStart
			const end = start + itemDuration(shot)
			if (start < from - 1e-6 || end > to + 1e-6) continue
			if (camera.members.some((m) => m.assetId === shot.sourceAssetId)) continue
			// Cameras rarely start and stop together, and long recordings come in
			// several files. Switch every part this camera recorded, each to the
			// file that recorded it; what it missed stays on the angle it had.
			const pieces = recordedPieces(shot, group, camera, media)
			if (!pieces.length) {
				dropped.push(`switch at ${round3(start)}s to ${camera.name}: ${camera.name} was not recording then`)
				continue
			}
			for (const p of pieces) {
				if (p.start > start + MIN_ITEM_DURATION) splitAt(p.start)
				if (p.end < end - MIN_ITEM_DURATION) splitAt(p.end)
			}
			let covered = 0
			for (const p of pieces) {
				const piece = pieceAt(Math.max(start, p.start))
				if (!piece) continue
				const next = retargetShot(piece, group, p.member, media)
				if ('reason' in next) {
					dropped.push(`switch at ${round3(piece.timelineStart)}s to ${camera.name}: ${next.reason}`)
					continue
				}
				Object.assign(piece, next.fields)
				if (shots.has(piece.id)) updated.add(piece.id)
				covered += itemDuration(piece)
			}
			if (covered > 0) switched++
			const missed = (end - start) - covered
			if (missed > 0.04) notes.push(`${camera.name} was not recording ${round3(missed)} s of that stretch; that part stays on the angle it had.`)
		}
	}

	// Two pieces that now play one file straight through are one clip again:
	// a split left where nothing changes would read as a cut that is not there.
	const removeIds: string[] = []
	const lanes = new Map<string, TimelineItem[]>()
	for (const s of all()) lanes.set(s.trackId, [...(lanes.get(s.trackId) ?? []), s])
	for (const lane of lanes.values()) {
		lane.sort((a, b) => a.timelineStart - b.timelineStart)
		for (let k = 1; k < lane.length; k++) {
			const a = lane[k - 1], b = lane[k]
			const touching = Math.abs(b.timelineStart - (a.timelineStart + itemDuration(a))) < 1e-6
			const continuous = a.sourceAssetId === b.sourceAssetId && Math.abs(b.in - a.out) < 1e-6 &&
				Math.abs((a.speed || 1) - (b.speed || 1)) < 1e-12 && !a.transition?.out && !b.keyframes
			// Only pieces that LOOK the same are one clip: a punch-in (transform), a reframe or a look
			// on one side is a cut the editor made on purpose, even within one file.
			if (!touching || !continuous || !sameLook(a, b)) continue
			Object.assign(a, { out: b.out, duration: (b.out - a.in) / (a.speed || 1) })
			if (shots.has(a.id)) updated.add(a.id)
			if (shots.has(b.id)) { removeIds.push(b.id); updated.delete(b.id); shots.delete(b.id) }
			else added.splice(added.indexOf(b), 1)
			lane.splice(k, 1)
			k--
		}
	}

	const updates = [...updated].map((id) => {
		const s = shots.get(id)!
		return {
			id, sourceAssetId: s.sourceAssetId, in: s.in, out: s.out, speed: s.speed,
			duration: s.duration, label: s.label, transition: s.transition
		}
	})
	return { updates, adds: added, removeIds, dropped, notes, switched }
}

/**
 * Clips that play `camera` across the group stretch [from, to], one per file
 * it recorded there, placed by `tl` (group seconds → timeline seconds).
 */
function clipsForCamera(
	group: MulticamGroup, camera: Camera, from: number, to: number, media: Media,
	tl: (g: number) => number,
	make: (fields: ShotFields, timelineStart: number) => TimelineItem
): TimelineItem[] {
	const out: TimelineItem[] = []
	for (const span of cameraSpans(camera, media)) {
		const a = Math.max(from, span.start)
		const b = Math.min(to, span.end)
		if (b - a < MIN_ITEM_DURATION) continue
		const clip = shotFor(group, span.member, a, tl(b) - tl(a), media)
		if ('fields' in clip) out.push(make(clip.fields, tl(a)))
	}
	return out
}

/**
 * Lay a group on the timeline: the main sound on `audioTrackId`, and shots of
 * `angle` (the first angle by default) over the same stretch. Where that angle
 * started late or stopped early the shots are the parts it recorded; a camera
 * that split its recording into files gives one clip per file, back to back.
 */
export function placeGroup(
	group: MulticamGroup,
	media: Media,
	opts: {
		videoTrackId: string
		audioTrackId: string
		atSec: number
		newId: () => string
		angle?: string | number
		/** Group-clock stretch to place; the whole main sound by default. */
		from?: number
		to?: number
	}
): { items: TimelineItem[] } | { reason: string } {
	const soundCam = soundCameraOf(group, media)
	const sound = memberOf(group, group.soundAssetId)
	const span = soundSpan(group, media)
	if (!soundCam || !sound || !span) return { reason: 'the group has no main sound' }
	const from = Math.max(span.start, opts.from ?? span.start)
	const to = Math.min(span.end, opts.to ?? span.end)
	if (to - from < MIN_ITEM_DURATION) return { reason: 'that stretch is outside the main sound' }
	const camera = opts.angle !== undefined ? resolveAngle(group, media, opts.angle) : anglesOf(group, media)[0]
	if (!camera) return { reason: `there is no angle "${opts.angle}"` }

	// The timeline runs on the main sound's clock.
	const tl = (g: number) => opts.atSec + (g - from) / sound.rate
	const sounds = clipsForCamera(group, soundCam, from, to, media, tl, (fields, timelineStart) => ({
		id: opts.newId(), trackId: opts.audioTrackId, timelineStart, preservePitch: true, ...fields,
		label: `${group.name} · sound (${soundCam.name})`,
		multicam: { groupId: group.id, role: 'sound' }
	}))
	const shots = clipsForCamera(group, camera, from, to, media, tl, (fields, timelineStart) => ({
		id: opts.newId(), trackId: opts.videoTrackId, timelineStart, preservePitch: true, muted: true, ...fields,
		multicam: { groupId: group.id, role: 'shot' }
	}))
	return { items: [...sounds, ...shots] }
}

/**
 * When a group's lines change (a re-sync, a nudge, a new main sound), every
 * clip of it is re-derived so each keeps showing the same moment: its group
 * stretch is read with the OLD group and written back with the NEW one. A
 * sound clip moving to a camera recorded in several files becomes one clip per
 * file (`adds`).
 */
export function rederiveGroupItems(
	timeline: readonly TimelineItem[],
	before: MulticamGroup,
	after: MulticamGroup,
	media: Media,
	newId: () => string = () => `mc-${Math.random().toString(36).slice(2)}`
): { updates: Array<{ id: string } & Partial<TimelineItem>>; adds: TimelineItem[]; dropped: string[]; notes: string[] } {
	const updates: Array<{ id: string } & Partial<TimelineItem>> = []
	const adds: TimelineItem[] = []
	const dropped: string[] = []
	const notes: string[] = []
	const soundCam = soundCameraOf(after, media)
	const newSound = memberOf(after, after.soundAssetId)
	for (const item of timeline) {
		if (item.multicam?.groupId !== before.id) continue
		const start = groupTimeAt(item, before, item.timelineStart)
		const end = groupTimeAt(item, before, item.timelineStart + itemDuration(item))
		if (start === null || end === null) continue
		if (item.multicam.role === 'sound') {
			if (!soundCam || !newSound) continue
			// The same stretch from the new sound's files. What they did not
			// record is lost from the sound clip (and said), rather than the
			// change being refused outright.
			const tl = (g: number) => item.timelineStart + (g - start) / newSound.rate
			const pieces = clipsForCamera(after, soundCam, start, end, media, tl, (fields, timelineStart) => ({
				...item, ...fields, timelineStart, label: `${after.name} · sound (${soundCam.name})`
			}))
			if (!pieces.length) {
				dropped.push(`${item.label || item.id}: ${soundCam.name} did not record any of it, so the sound is unchanged`)
				continue
			}
			const [first, ...rest] = pieces
			updates.push({
				id: item.id, sourceAssetId: first.sourceAssetId, in: first.in, out: first.out, speed: first.speed,
				duration: first.duration, label: first.label,
				...(first.timelineStart !== item.timelineStart ? { timelineStart: first.timelineStart } : {})
			})
			for (const piece of rest) adds.push({ ...piece, id: newId(), transition: undefined })
			const lost = itemDuration(item) - pieces.reduce((s, p) => s + itemDuration(p), 0)
			if (lost > 0.04) notes.push(`${soundCam.name} did not record ${round3(lost)} s of that stretch; the sound is ${round3(lost)} s shorter there.`)
			continue
		}
		const member = memberOf(after, item.sourceAssetId)
		if (!member) continue
		// The same moment in the file under the new line. A nudge can push a
		// shot's edge past where the camera started or stopped; then the shot
		// loses that sliver (its start moves later) rather than the whole shot
		// being refused — the user nudged a few frames, not the edit.
		const speed = shotSpeed(after, member)
		const length = durationOf(media, member.assetId)
		let inSec = toSourceTime(member, start)
		let outSec = inSec + itemDuration(item) * speed
		let timelineStart = item.timelineStart
		if (inSec < 0) {
			timelineStart += -inSec / speed
			inSec = 0
		}
		if (length > 0 && outSec > length) outSec = length
		if (outSec - inSec < MIN_ITEM_DURATION * speed) {
			dropped.push(`${item.label || item.id} at ${round3(item.timelineStart)}s: ${member.name} was not recording any of it now`)
			continue
		}
		const same = Math.abs(inSec - item.in) < 1e-6 && Math.abs(outSec - item.out) < 1e-6 &&
			Math.abs(speed - (item.speed || 1)) < 1e-12 && Math.abs(timelineStart - item.timelineStart) < 1e-6
		if (same) continue
		updates.push({
			id: item.id, in: inSec, out: outSec, speed, duration: (outSec - inSec) / speed,
			...(timelineStart !== item.timelineStart ? { timelineStart } : {})
		})
	}
	return { updates, adds, dropped, notes }
}

/**
 * The group with one camera moved on the clock by `deltaSec` (a nudge), all
 * its files together: they are one recording. Recorded on each file's sync.
 */
export function nudgeCamera(group: MulticamGroup, assetId: string, deltaSec: number): MulticamGroup {
	const target = memberOf(group, assetId)
	if (!target) return group
	const key = cameraKey(target)
	return {
		...group,
		members: group.members.map((m) => cameraKey(m) !== key ? m : {
			...m,
			offset: m.offset + deltaSec,
			sync: { ...m.sync, nudgeSec: round6((m.sync.nudgeSec ?? 0) + deltaSec) }
		})
	}
}

/**
 * A ripple delete of a group's SHOT takes that stretch out of the whole
 * group: the main sound under it (and any of the group's clips on other
 * lanes) is cut the same way and closes up by the same amount, or every
 * later shot would slide earlier against the sound and lose sync. Plain
 * clips are untouched; the caller's own ripple still closes the shot's lane.
 */
export function groupRippleCut(
	timeline: readonly TimelineItem[],
	removed: readonly TimelineItem[],
	makeId: () => string
): { removeIds: string[]; updated: TimelineItem[]; added: TimelineItem[]; changes: RippleChange[] } {
	const out = { removeIds: [] as string[], updated: [] as TimelineItem[], added: [] as TimelineItem[], changes: [] as RippleChange[] }
	const removedIds = new Set(removed.map((r) => r.id))
	const byGroup = new Map<string, TimelineItem[]>()
	for (const r of removed) {
		if (r.multicam?.role !== 'shot') continue
		byGroup.set(r.multicam.groupId, [...(byGroup.get(r.multicam.groupId) ?? []), r])
	}
	for (const [groupId, shots] of byGroup) {
		const lanes = new Set(shots.map((s) => s.trackId))
		const companions = timeline.filter((i) =>
			i.multicam?.groupId === groupId && !removedIds.has(i.id) && !lanes.has(i.trackId))
		if (!companions.length) continue
		const ranges = shots.map((s) => ({ start: s.timelineStart, end: s.timelineStart + itemDuration(s) }))
		const plan = planRangeRemoval(companions, ranges, makeId)
		out.removeIds.push(...plan.removeIds)
		out.updated.push(...plan.updated)
		out.added.push(...plan.added)
		const touched = new Set(companions.map((c) => c.trackId))
		for (const trackId of touched) {
			for (const r of ranges) out.changes.push({ trackId, at: r.start, delta: -(r.end - r.start) })
		}
	}
	return out
}

// ===== Which sound is clearest =====

/**
 * How good a recording's sound is, for suggesting the main sound: higher is
 * better. The sync measures each file once (voices over the room in dB, and
 * the share of clipped samples); the Media panel, the Inspector and MCP all
 * rank by this one number.
 */
export function soundScore(q: { snrDb: number; clipped: number } | null | undefined): number {
	if (!q) return -Infinity
	// Clearest voice first (Navid's call, 2026-10-25): how far the voices stand
	// above the room decides. Clipping only breaks a tie between sources within
	// half a dB of each other — it never outweighs a clearer voice.
	const tiebreak = Math.min(0.5, q.clipped * 100)
	return q.snrDb - tiebreak
}

// ===== One transcript per group =====

/**
 * The group's transcript: the main sound's, on the group clock, across all of
 * its files. Every camera heard the same conversation, so one transcript
 * serves all angles.
 */
export function groupTranscript(
	group: MulticamGroup,
	transcripts: Record<string, TranscriptEntry[] | undefined>,
	media: Media = []
): TranscriptEntry[] {
	const onClock = (members: MulticamMember[]) => members
		.flatMap((m) => (transcripts[m.assetId] ?? []).map((e) => ({ start: toGroupTime(m, e.start), end: toGroupTime(m, e.end), text: e.text })))
		.sort((a, b) => a.start - b.start)
	const soundMembers = media.length
		? soundCameraOf(group, media)?.members ?? []
		: group.members.filter((m) => cameraKey(m) === cameraKey(memberOf(group, group.soundAssetId) ?? group.members[0]))
	const main = onClock(soundMembers)
	if (main.length) return main
	// Fall back to any camera that has one.
	for (const cam of camerasOf(group, media.length ? media : group.members.map((m) => ({ id: m.assetId, kind: 'video' as const })))) {
		const lines = onClock(cam.members)
		if (lines.length) return lines
	}
	return []
}

// ===== Finding groups among imported files =====

export interface CameraGroupSuggestion {
	assetIds: string[]
	/** Why these look like one recording, in words the user reads. */
	reasons: string[]
	/** strong: recording times overlap. weak: only names or lengths agree. */
	strength: 'strong' | 'weak'
}

/**
 * When a camera started, from its file name where cameras write it there:
 * DJI_20260717171155_0022_D.MP4 → 2026-07-17 17:11:55 (local time, as epoch
 * ms read in UTC — only differences between files matter here).
 */
export function cameraStartFromName(name: string): number | undefined {
	const m = /(20\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/.exec(name)
	if (!m) return undefined
	const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
	if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined
	return Date.UTC(y, mo - 1, d, h, mi, s)
}

/** "Cam01", "camera 2", "B-cam", "angle3": a folder or file named for a camera. */
const CAMERA_WORD = /(^|[^a-z])(cam(era)?|angle)[\s_-]*\d+|(^|[^a-z])[a-d][\s_-]?cam([^a-z]|$)/i

function folderOf(path: string): string {
	const parts = path.split(/[\\/]/)
	return parts.length > 1 ? parts[parts.length - 2] : ''
}

/** The letters a camera starts its file names with: "DJI", "IMG", "GX", "C". */
const namePrefix = (name: string) => /^[A-Za-z]+/.exec(name)?.[0]?.toUpperCase() ?? ''

/**
 * When a file started, by ONE clock for a set of files: the start written in
 * file names when every file has one, else the files' own recording tags.
 * Comparing a name time against a tag time would compare two clocks.
 */
export function startTimes(files: readonly Pick<MediaAsset, 'name' | 'metadata'>[]): Array<number | undefined> {
	const names = files.map((f) => cameraStartFromName(f.name))
	if (names.every((t) => t !== undefined)) return names
	const tags = files.map((f) => f.metadata?.recordedAt)
	if (tags.every((t) => t !== undefined)) return tags
	return files.map(() => undefined)
}

/**
 * Which files came from the same camera, and what to call each camera. Files
 * share a camera when they share a folder (or, all in one folder, a file-name
 * prefix) and follow one another without overlapping: a camera that split a
 * long recording. Two files of one folder that overlap are two cameras.
 */
export function assignCameras(
	files: readonly Pick<MediaAsset, 'id' | 'kind' | 'name' | 'originalPath' | 'metadata'>[]
): Map<string, string> {
	const folders = new Set(files.map((f) => folderOf(f.originalPath)))
	const bucketOf = (f: typeof files[number]) =>
		`${f.kind}|${folders.size > 1 ? folderOf(f.originalPath) : namePrefix(f.name)}`
	const starts = startTimes(files)
	const buckets = new Map<string, Array<{ file: typeof files[number]; start?: number }>>()
	files.forEach((file, i) => {
		const key = bucketOf(file)
		buckets.set(key, [...(buckets.get(key) ?? []), { file, start: starts[i] }])
	})
	// Within a bucket, a file that overlaps the chain so far starts a new camera.
	const chains: Array<typeof files[number][]> = []
	for (const list of buckets.values()) {
		list.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.file.name.localeCompare(b.file.name))
		const open: Array<{ files: typeof files[number][]; end: number }> = []
		for (const { file, start } of list) {
			const dur = file.metadata?.duration ?? 0
			const s = start === undefined ? undefined : start / 1000
			const chain = s === undefined ? open[0] : open.find((c) => s >= c.end - 5)
			if (chain) {
				chain.files.push(file)
				if (s !== undefined) chain.end = s + dur
			} else open.push({ files: [file], end: s === undefined ? Infinity : s + dur })
		}
		chains.push(...open.map((c) => c.files))
	}
	// Names: a camera folder names its camera; otherwise Cam 1, Cam 2… and Recorder.
	chains.sort((a, b) => folderOf(a[0].originalPath).localeCompare(folderOf(b[0].originalPath), undefined, { numeric: true }) ||
		a[0].name.localeCompare(b[0].name))
	const names = new Map<string, string>()
	const taken = new Set<string>()
	let video = 0
	let audio = 0
	const audioChains = chains.filter((c) => c[0].kind === 'audio').length
	for (const chain of chains) {
		const folder = folderOf(chain[0].originalPath)
		let name = CAMERA_WORD.test(folder) && !taken.has(folder)
			? folder
			: chain[0].kind === 'audio' ? (audioChains > 1 ? `Recorder ${++audio}` : 'Recorder') : `Cam ${++video}`
		while (taken.has(name)) name = `${name}′`
		taken.add(name)
		for (const f of chain) names.set(f.id, name)
	}
	return names
}

/**
 * Files that look like the same moment from different cameras. Pairs by
 * recording window first (files whose recordings overlap by most of the
 * shorter one); a camera's consecutive files join through each other; when
 * files carry no usable time, camera-named folders plus similar length. It
 * only SUGGESTS: the user, or an agent, confirms, and the sync proves it.
 */
export function suggestCameraGroups(
	media: readonly Pick<MediaAsset, 'id' | 'kind' | 'name' | 'originalPath' | 'metadata' | 'synth' | 'generated'>[],
	groups: readonly MulticamGroup[] = []
): CameraGroupSuggestion[] {
	const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.assetId)))
	const files = media.filter((a) =>
		(a.kind === 'video' || a.kind === 'audio') && !a.synth && !a.generated &&
		!grouped.has(a.id) && (a.metadata?.duration ?? 0) >= 10)
	type Node = { id: string; kind: string; start?: number; nameStart?: number; dur: number; folder: string; name: string }
	const nodes: Node[] = files.map((a) => ({
		id: a.id, kind: a.kind, dur: a.metadata!.duration,
		start: a.metadata?.recordedAt, nameStart: cameraStartFromName(a.name),
		folder: folderOf(a.originalPath), name: a.name
	}))

	const parent = new Map(nodes.map((n) => [n.id, n.id]))
	const find = (id: string): string => { const p = parent.get(id)!; return p === id ? id : find(p) }
	const reasons = new Map<string, Set<string>>()
	const strong = new Set<string>()
	const link = (a: Node, b: Node, why: string, isStrong: boolean) => {
		const ra = find(a.id), rb = find(b.id)
		if (ra !== rb) parent.set(ra, rb)
		const key = find(a.id)
		const set = reasons.get(key) ?? new Set<string>()
		for (const k of [ra, rb]) for (const r of reasons.get(k) ?? []) set.add(r)
		set.add(why)
		reasons.set(key, set)
		if (isStrong || strong.has(ra) || strong.has(rb)) strong.add(key)
	}

	const overlapShare = (s1: number, d1: number, s2: number, d2: number) =>
		Math.max(0, Math.min(s1 + d1, s2 + d2) - Math.max(s1, s2)) / Math.min(d1, d2)

	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			const a = nodes[i], b = nodes[j]
			if (a.kind === 'audio' && b.kind === 'audio') continue
			// Two files from ONE camera follow each other; they never overlap. So an
			// overlap of recording windows is the strongest sign there is.
			const times: Array<[number | undefined, number | undefined, string]> = [
				[a.nameStart, b.nameStart, 'their file names say they were recording at the same time'],
				[a.start, b.start, 'they were recording at the same time']
			]
			let linked = false
			for (const [sa, sb, why] of times) {
				if (sa === undefined || sb === undefined) continue
				if (overlapShare(sa / 1000, a.dur, sb / 1000, b.dur) >= 0.5) {
					link(a, b, why, true)
					linked = true
					break
				}
				// One camera's recording, split: the next file starts as the last ends.
				const [first, second, s1, s2] = sa <= sb ? [a, b, sa, sb] : [b, a, sb, sa]
				const gap = s2 / 1000 - (s1 / 1000 + first.dur)
				if (a.kind === b.kind && a.folder === b.folder && namePrefix(a.name) === namePrefix(b.name) && gap > -5 && gap < 30) {
					link(first, second, `${first.folder || namePrefix(first.name)} split one recording into several files`, false)
					linked = true
					break
				}
			}
			if (linked) continue
			const similar = Math.abs(a.dur - b.dur) <= 0.15 * Math.max(a.dur, b.dur)
			const camFolders = CAMERA_WORD.test(a.folder) && CAMERA_WORD.test(b.folder) && a.folder !== b.folder
			const camNames = CAMERA_WORD.test(a.name) && CAMERA_WORD.test(b.name)
			if (similar && (camFolders || camNames)) {
				link(a, b, camFolders
					? `they sit in camera folders (${a.folder}, ${b.folder}) and run about as long`
					: 'they are named for cameras and run about as long', false)
			}
		}
	}

	const clusters = new Map<string, string[]>()
	for (const n of nodes) {
		const root = find(n.id)
		clusters.set(root, [...(clusters.get(root) ?? []), n.id])
	}
	const out: CameraGroupSuggestion[] = []
	for (const [root, ids] of clusters) {
		if (ids.length < 2) continue
		// One camera's files alone are not a multicam: at least two cameras.
		const cams = new Set(assignCameras(files.filter((f) => ids.includes(f.id))).values())
		if (cams.size < 2) continue
		if (!ids.some((id) => nodes.find((n) => n.id === id)?.kind === 'video')) continue
		out.push({ assetIds: ids, reasons: [...(reasons.get(root) ?? [])], strength: strong.has(root) ? 'strong' : 'weak' })
	}
	return out
}

/** A new group's default name: the shared part of its files' folder, or "Multicam". */
export function defaultGroupName(media: readonly Pick<MediaAsset, 'originalPath'>[]): string {
	const parents = media.map((a) => {
		const parts = a.originalPath.split(/[\\/]/)
		return parts.length > 2 ? parts[parts.length - 3] : ''
	})
	const shared = parents.every((p) => p && p === parents[0]) ? parents[0] : ''
	return shared && shared !== 'media' ? shared : 'Multicam'
}

const round3 = (n: number) => Math.round(n * 1000) / 1000
const round6 = (n: number) => Math.round(n * 1e6) / 1e6
