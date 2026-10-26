import { describe, expect, it } from 'vitest'
import {
	anglesOf, assignCameras, cameraStartFromName, recordedPieces, sealCameraJoins, shotRun, groupRippleCut, groupTimeAt, groupTranscript, nudgeCamera, placeGroup, planAngleSwitches,
	rederiveGroupItems, resolveAngle, shotSpeed, suggestCameraGroups, toGroupTime, toSourceTime
} from './multicam'
import { itemDuration, rippleAfterRemoval, rippleTimeline } from './timeline'
import type { MediaAsset, MulticamGroup, TimelineItem } from './types'

const asset = (id: string, over: Partial<MediaAsset> & { duration?: number; recordedAt?: number } = {}): MediaAsset => ({
	id, kind: 'video', name: `${id}.mp4`, originalPath: `/footage/${id}/${id}.mp4`,
	metadata: {
		duration: over.duration ?? 600, width: 1920, height: 1080, fps: 30, size: 1, codec: 'h264',
		format: 'mp4', hasAudio: true, recordedAt: over.recordedAt
	},
	preprocessing: {}, clips: [], createdAt: 0, ...over
})

// Cam 2 started 1.37 s after Cam 1 and its clock runs 60 ppm slow against it.
const DRIFT = 1.00006
const media = [asset('cam1', { duration: 600 }), asset('cam2', { duration: 590 }), asset('rec', { kind: 'audio', duration: 620 })]
const group: MulticamGroup = {
	id: 'g', name: 'Gap-time', soundAssetId: 'cam1', createdAt: 0,
	members: [
		{ assetId: 'cam1', name: 'Cam 1', offset: 0, rate: 1, sync: { method: 'reference', confidence: 'strong', driftPpm: 0 } },
		{ assetId: 'cam2', name: 'Cam 2', offset: 1.37, rate: DRIFT, sync: { method: 'audio', confidence: 'strong', driftPpm: 60 } },
		{ assetId: 'rec', name: 'Recorder', offset: -4, rate: 1, sync: { method: 'audio', confidence: 'strong', driftPpm: 0 } }
	]
}
let n = 0
const newId = () => `id${++n}`

function placed(angle?: string | number) {
	const out = placeGroup(group, media, { videoTrackId: 'v1', audioTrackId: 'a1', atSec: 0, newId, angle })
	if ('reason' in out) throw new Error(out.reason)
	return out.items
}

/** Every shot shows the moment the sound is playing, at both of its ends. */
function expectLocked(timeline: TimelineItem[], g: MulticamGroup = group) {
	const sound = timeline.find((i) => i.multicam?.role === 'sound')!
	for (const shot of timeline.filter((i) => i.multicam?.role === 'shot')) {
		for (const t of [shot.timelineStart, shot.timelineStart + itemDuration(shot)]) {
			expect(groupTimeAt(shot, g, t)!).toBeCloseTo(groupTimeAt(sound, g, t)!, 6)
		}
	}
}

describe('the group clock', () => {
	it('maps a member’s source time to group time and back', () => {
		const cam2 = group.members[1]
		expect(toGroupTime(cam2, 0)).toBe(1.37)
		expect(toSourceTime(cam2, toGroupTime(cam2, 123.4))).toBeCloseTo(123.4, 9)
	})

	it('plays a drifting angle at the ratio of the two clocks', () => {
		expect(shotSpeed(group, group.members[0])).toBe(1)
		expect(shotSpeed(group, group.members[1])).toBeCloseTo(1 / DRIFT, 12)
	})
})

describe('placeGroup', () => {
	it('lays the main sound and one shot of the first angle over the same stretch', () => {
		const items = placed()
		const sound = items.find((i) => i.multicam?.role === 'sound')!
		const shot = items.find((i) => i.multicam?.role === 'shot')!
		expect(sound).toMatchObject({ trackId: 'a1', sourceAssetId: 'cam1', in: 0, out: 600, speed: 1 })
		expect(shot).toMatchObject({ trackId: 'v1', sourceAssetId: 'cam1', in: 0, out: 600, muted: true, label: 'Cam 1' })
	})

	it('starts a late angle where it started recording, and keeps it locked to the end', () => {
		const items = placed(2)
		const shot = items.find((i) => i.multicam?.role === 'shot')!
		expect(shot.sourceAssetId).toBe('cam2')
		expect(shot.timelineStart).toBeCloseTo(1.37, 9)
		expect(shot.in).toBeCloseTo(0, 9)
		expectLocked(items)
	})

	it('refuses an angle that does not exist', () => {
		expect(placeGroup(group, media, { videoTrackId: 'v1', audioTrackId: 'a1', atSec: 0, newId, angle: 'Cam 9' }))
			.toEqual({ reason: 'there is no angle "Cam 9"' })
	})
})

describe('planAngleSwitches', () => {
	it('cuts to each angle from its switch until the next, splitting the shot', () => {
		const items = placed(1)
		const plan = planAngleSwitches(items, group, [{ atSec: 10, angle: 2 }, { atSec: 20, angle: 'Cam 1' }], media, newId)
		expect(plan.dropped).toEqual([])
		expect(plan.switched).toBe(1)
		const timeline = items
			.map((i) => ({ ...i, ...plan.updates.find((u) => u.id === i.id) }))
			.concat(plan.adds)
		const shots = timeline.filter((i) => i.multicam?.role === 'shot').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(shots.map((s) => [s.label, Math.round(s.timelineStart * 1000) / 1000])).toEqual([
			['Cam 1', 0], ['Cam 2', 10], ['Cam 1', 20]
		])
		// Back-to-back, nothing moved: the pieces still cover 0..600.
		expect(shots[2].timelineStart + itemDuration(shots[2])).toBeCloseTo(600, 6)
		expectLocked(timeline)
	})

	it('switches the part an angle recorded when it stopped before the shot ends', () => {
		// Cam 2 ran 590 s from 1.37 s on: it stopped about 7.6 s before the sound did.
		// (Found driving the app: a number-key cut to it was refused outright.)
		const items = placed(1)
		const plan = planAngleSwitches(items, group, [{ atSec: 10, angle: 2 }], media, newId)
		expect(plan.dropped).toEqual([])
		const timeline = items.map((i) => ({ ...i, ...plan.updates.find((u) => u.id === i.id) })).concat(plan.adds)
		const shots = timeline.filter((i) => i.multicam?.role === 'shot').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(shots.map((s) => s.label)).toEqual(['Cam 1', 'Cam 2', 'Cam 1'])
		const cam2End = shots[1].timelineStart + itemDuration(shots[1])
		expect(groupTimeAt(shots[1], group, cam2End)).toBeCloseTo(1.37 + 590 * DRIFT, 6)
		expect(plan.notes[0]).toMatch(/Cam 2 was not recording/)
		expectLocked(timeline)
	})

	it('drops a switch to an angle that was not recording yet, and says why', () => {
		const items = placed(1)
		const plan = planAngleSwitches(items, group, [{ atSec: 0, angle: 2 }], media, newId, 1)
		expect(plan.switched).toBe(0)
		expect(plan.dropped[0]).toMatch(/Cam 2 was not recording/)
	})

	it('keeps a punch-in: pieces of one file merge back only when they look the same', () => {
		// Cam 1 split at 30 s, the second piece punched in 1.8x. A switch elsewhere (100 s) must
		// not fold the punch-in back into the wide piece before it. (Found cutting a podcast:
		// one small switch erased 63 punch-ins.)
		const items = placed(1)
		const shot = items.find((i) => i.multicam?.role === 'shot')!
		const wide = { ...shot, out: shot.in + 30, duration: 30 }
		const punch = { ...shot, id: 'punch', timelineStart: 30, in: shot.in + 30, duration: shot.duration - 30, transform: { x: -0.4, y: 0.18, scale: 1.8, rotation: 0 } }
		const before = items.filter((i) => i.id !== shot.id).concat([wide, punch])
		const plan = planAngleSwitches(before, group, [{ atSec: 100, angle: 2 }, { atSec: 110, angle: 1 }], media, newId)
		expect(plan.removeIds).not.toContain('punch')
		const timeline = before.map((i) => ({ ...i, ...plan.updates.find((u) => u.id === i.id) })).concat(plan.adds)
		const shots = timeline.filter((i) => i.multicam?.role === 'shot').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(shots[0]).toMatchObject({ id: wide.id, timelineStart: 0 })
		expect(itemDuration(shots[0])).toBeCloseTo(30, 6)
		expect(shots[1]).toMatchObject({ id: 'punch', transform: { scale: 1.8 } })
	})

	it('names the angles when one is unknown', () => {
		const plan = planAngleSwitches(placed(1), group, [{ atSec: 5, angle: 'wide' }], media, newId)
		expect(plan.dropped[0]).toContain('angles: 1 Cam 1, 2 Cam 2')
	})
})

describe('shotRun after trimming and punching in', () => {
	/**
	 * What the podcast edit looked like: a wide piece, a 1.8x punch-in on the same camera, another
	 * wide piece, then a piece after 40 s of source were trimmed out (it touches on the timeline but
	 * not on the group's clock). Found when one click on an angle tile switched four pieces.
	 */
	function trimmedAndPunched() {
		const base = placed(1)
		const shot = base.find((i) => i.multicam?.role === 'shot')!
		const piece = (id: string, start: number, inSec: number, outSec: number, over: Partial<TimelineItem> = {}): TimelineItem =>
			({ ...shot, id, timelineStart: start, in: inSec, out: outSec, duration: outSec - inSec, ...over })
		const pieces = [
			piece('wide1', 0, 0, 30),
			piece('punch', 30, 30, 40, { transform: { x: -0.4, y: 0.18, scale: 1.8, rotation: 0 } }),
			piece('wide2', 40, 40, 60),
			piece('afterTrim', 60, 100, 120)
		]
		return { items: base.filter((i) => i.id !== shot.id).concat(pieces), pieces }
	}

	it('ends a shot at a punch-in, and at time trimmed out', () => {
		const { items, pieces } = trimmedAndPunched()
		const run = (id: string) => shotRun(items, pieces.find((p) => p.id === id)!, group, media)
		expect(run('wide1')).toEqual({ start: 0, end: 30 })
		expect(run('punch')).toEqual({ start: 30, end: 40 })
		expect(run('wide2')).toEqual({ start: 40, end: 60 })
		expect(run('afterTrim')).toEqual({ start: 60, end: 80 })
	})

	it('still joins pieces that carry on from each other with the same framing', () => {
		const { items, pieces } = trimmedAndPunched()
		// afterTrim continues straight into a second piece of the same look.
		const next: TimelineItem = { ...pieces[3], id: 'afterTrim2', timelineStart: 80, in: 120, out: 130, duration: 10 }
		const run = shotRun([...items, next], pieces[3], group, media)
		expect(run).toEqual({ start: 60, end: 90 })
	})

	it('switches only the clip you chose, and drops the old camera\'s framing', () => {
		const { items, pieces } = trimmedAndPunched()
		const punch = pieces[1]
		const run = shotRun(items, punch, group, media)
		const plan = planAngleSwitches(items, group, [{ atSec: run.start, angle: 2 }], media, newId, run.end)
		expect(plan.dropped).toEqual([])
		const after = items.map((i) => ({ ...i, ...plan.updates.find((u) => u.id === i.id) })).concat(plan.adds)
		const shots = after.filter((i) => i.multicam?.role === 'shot').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(shots.map((s) => [s.timelineStart, s.label])).toEqual([[0, 'Cam 1'], [30, 'Cam 2'], [40, 'Cam 1'], [60, 'Cam 1']])
		// The iPhone-style single has the full picture: the crop belonged to the other camera.
		expect(shots[1].transform).toBeUndefined()
		const update = plan.updates.find((u) => u.id === 'punch')!
		expect('transform' in update).toBe(true)
		expect(update.transform).toBeUndefined()
		// The neighbours keep what they had.
		expect(shots[0].id).toBe('wide1')
		expect(shots[2].id).toBe('wide2')
		expect(shots[3].id).toBe('afterTrim')
	})

	it('does not strip the framing of a clip that is not switched', () => {
		const { items, pieces } = trimmedAndPunched()
		// Cut the wide piece before it to camera 2: the punch-in beside it is untouched.
		const plan = planAngleSwitches(items, group, [{ atSec: 0, angle: 2 }], media, newId, 30)
		const after = items.filter((i) => !plan.removeIds.includes(i.id)).map((i) => ({ ...i, ...plan.updates.find((u) => u.id === i.id) })).concat(plan.adds)
		const punch = after.find((i) => i.id === pieces[1].id)!
		expect(punch.transform).toMatchObject({ scale: 1.8 })
		expect(punch.label).toBe('Cam 1')
	})
})

describe('groupRippleCut', () => {
	it('takes a deleted shot’s stretch out of the sound too, so later shots stay in sync', () => {
		const base = placed(1)
		const plan = planAngleSwitches(base, group, [{ atSec: 10, angle: 2 }, { atSec: 20, angle: 1 }], media, newId)
		let timeline = base.map((i) => ({ ...i, ...plan.updates.find((u) => u.id === i.id) })).concat(plan.adds)
		const middle = timeline.find((i) => i.sourceAssetId === 'cam2')!
		// What the store's ripple delete does: remove, cut the group's sound, close both lanes.
		const cut = groupRippleCut(timeline, [middle], newId)
		timeline = timeline.filter((i) => i.id !== middle.id && !cut.removeIds.includes(i.id))
			.map((i) => cut.updated.find((u) => u.id === i.id) ?? i)
			.concat(cut.added)
		rippleTimeline(timeline, cut.changes)
		rippleAfterRemoval(timeline, [middle])
		const sounds = timeline.filter((i) => i.multicam?.role === 'sound').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(sounds.map((s) => [s.timelineStart, Math.round(s.in * 1000) / 1000])).toEqual([[0, 0], [10, 20]])
		const shots = timeline.filter((i) => i.multicam?.role === 'shot').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(shots.map((s) => Math.round(s.timelineStart * 1e6) / 1e6)).toEqual([0, 10])
		// Every remaining shot shows what the sound under it is saying.
		for (const shot of shots) {
			const t = shot.timelineStart + 1
			const sound = sounds.find((x) => t >= x.timelineStart && t < x.timelineStart + itemDuration(x))!
			expect(groupTimeAt(shot, group, t)).toBeCloseTo(groupTimeAt(sound, group, t)!, 6)
		}
	})

	it('leaves plain clips alone', () => {
		const plain: TimelineItem = { id: 'p', trackId: 'v1', sourceAssetId: 'cam1', timelineStart: 0, in: 0, out: 5, speed: 1, preservePitch: true, duration: 5 }
		expect(groupRippleCut([plain], [plain], newId).changes).toEqual([])
	})
})

describe('rederiveGroupItems', () => {
	it('keeps every clip on the same moment after a nudge', () => {
		const base = placed(1)
		const plan = planAngleSwitches(base, group, [{ atSec: 10, angle: 2 }, { atSec: 20, angle: 1 }], media, newId)
		const items = base.map((i) => ({ ...i, ...plan.updates.find((u) => u.id === i.id) })).concat(plan.adds)
		const nudged = nudgeCamera(group, 'cam2', 0.1)
		expect(nudged.members[1].sync.nudgeSec).toBe(0.1)
		const { updates, dropped } = rederiveGroupItems(items, group, nudged, media)
		expect(dropped).toEqual([])
		const shot = items.find((i) => i.sourceAssetId === 'cam2')!
		const update = updates.find((u) => u.id === shot.id)!
		// Cam 2 now sits 0.1 s later on the clock, so the same moment is 0.1 s earlier in its file.
		expect(update.in! - shot.in).toBeCloseTo(-0.1 / DRIFT, 9)
		expectLocked(items.map((i) => ({ ...i, ...updates.find((u) => u.id === i.id) })), nudged)
	})

	it('trims a shot whose start a nudge pushed before the camera started', () => {
		const items = placed(2) // Cam 2's shot starts at the first frame it recorded
		const nudged = nudgeCamera(group, 'cam2', 0.1)
		const { updates, dropped } = rederiveGroupItems(items, group, nudged, media)
		expect(dropped).toEqual([])
		const shot = items.find((i) => i.multicam?.role === 'shot')!
		const update = updates.find((u) => u.id === shot.id)!
		expect(update.in).toBe(0)
		expect(update.timelineStart! - shot.timelineStart).toBeCloseTo(0.1, 3)
		expectLocked(items.map((i) => ({ ...i, ...updates.find((u) => u.id === i.id) })), nudged)
	})

	it('moves the sound to another member and re-times every shot against it', () => {
		const items = placed(2)
		const onRecorder = { ...group, soundAssetId: 'rec' }
		const { updates, dropped } = rederiveGroupItems(items, group, onRecorder, media)
		expect(dropped).toEqual([])
		const timeline = items.map((i) => ({ ...i, ...updates.find((u) => u.id === i.id) }))
		const sound = timeline.find((i) => i.multicam?.role === 'sound')!
		expect(sound.sourceAssetId).toBe('rec')
		expect(sound.in).toBeCloseTo(4, 9) // the recorder started 4 s before Cam 1
		expectLocked(timeline, onRecorder)
	})
})

describe('resolveAngle', () => {
	it('takes a number, a name or an asset id, and never a sound-only member', () => {
		expect(resolveAngle(group, media, 2)?.members[0].assetId).toBe('cam2')
		expect(resolveAngle(group, media, 'cam 1')?.members[0].assetId).toBe('cam1')
		expect(resolveAngle(group, media, 'cam2')?.members[0].assetId).toBe('cam2')
		expect(resolveAngle(group, media, 3)).toBeUndefined()
	})
})

describe('groupTranscript', () => {
	it('puts the main sound’s transcript on the group clock', () => {
		const onCam2 = { ...group, soundAssetId: 'cam2' }
		const lines = groupTranscript(onCam2, { cam2: [{ start: 10, end: 12, text: 'hello' }] })
		expect(lines[0].start).toBeCloseTo(1.37 + 10 * DRIFT, 9)
		expect(lines[0].text).toBe('hello')
	})
})

describe('suggestCameraGroups', () => {
	it('reads the start time DJI writes into its file names', () => {
		expect(cameraStartFromName('DJI_20260717171155_0022_D.MP4')).toBe(Date.UTC(2026, 6, 17, 17, 11, 55))
		expect(cameraStartFromName('IMG_0042.MOV')).toBeUndefined()
	})

	it('groups files whose recordings overlap, and not one camera’s consecutive files', () => {
		const files = [
			asset('a', { name: 'DJI_20260717171155_0022_D.MP4', duration: 1800 }),
			asset('b', { name: 'DJI_20260717171157_0007_D.MP4', duration: 1790 }),
			// Cam A's next file starts when the first ended: never the same moment.
			asset('c', { name: 'DJI_20260717174155_0023_D.MP4', duration: 900 })
		]
		const groups = suggestCameraGroups(files)
		expect(groups).toHaveLength(1)
		expect(groups[0]).toMatchObject({ assetIds: ['a', 'b'], strength: 'strong' })
		expect(groups[0].reasons[0]).toMatch(/file names/)
	})

	it('falls back to recording times from the file, then to camera folders', () => {
		const t = Date.UTC(2026, 0, 1, 10, 0, 0)
		expect(suggestCameraGroups([
			asset('a', { recordedAt: t, duration: 300 }), asset('b', { recordedAt: t + 2000, duration: 300 })
		])[0]?.strength).toBe('strong')
		const weak = suggestCameraGroups([
			asset('x', { originalPath: '/shoot/Cam01/x.mp4', duration: 300 }),
			asset('y', { originalPath: '/shoot/Cam02/y.mp4', duration: 310 })
		])
		expect(weak[0]).toMatchObject({ strength: 'weak' })
		expect(weak[0].reasons[0]).toMatch(/Cam01, Cam02/)
	})

	it('leaves out files that are already in a group', () => {
		const t = Date.UTC(2026, 0, 1, 10, 0, 0)
		const files = [asset('cam1', { recordedAt: t }), asset('cam2', { recordedAt: t })]
		expect(suggestCameraGroups(files, [group])).toEqual([])
	})
})

// ===== The real shoot (Gap-time, 2026-07-17): numbers measured by the sync =====
describe('a camera that split its recording into files', () => {
	const shootMedia = [
		asset('iphone', { name: 'IMG_4913.MOV', originalPath: '/Gap-time/Cam02/IMG_4913.MOV', duration: 5475.743, recordedAt: Date.UTC(2026, 6, 17, 15, 4, 22) }),
		asset('dji1', { name: 'DJI_20260717171155_0022_D.MP4', originalPath: '/Gap-time/Cam01/DJI_20260717171155_0022_D.MP4', duration: 2604.949, recordedAt: Date.UTC(2026, 6, 17, 15, 11, 55) }),
		asset('dji2', { name: 'DJI_20260717175520_0023_D.MP4', originalPath: '/Gap-time/Cam01/DJI_20260717175520_0023_D.MP4', duration: 2610.304, recordedAt: Date.UTC(2026, 6, 17, 15, 55, 22) }),
		asset('dji3', { name: 'DJI_20260717183851_0024_D.MP4', originalPath: '/Gap-time/Cam01/DJI_20260717183851_0024_D.MP4', duration: 321.488, recordedAt: Date.UTC(2026, 6, 17, 16, 38, 52) })
	]
	const sync = (method: 'reference' | 'audio', driftPpm = 0) => ({ method, confidence: 'strong' as const, driftPpm })
	const measured: MulticamGroup = {
		id: 'shoot', name: 'Gap-time', soundAssetId: 'dji1', createdAt: 0,
		members: [
			{ assetId: 'iphone', name: 'Cam02', camera: 'Cam02', offset: 0, rate: 1, sync: sync('reference') },
			{ assetId: 'dji1', name: 'Cam01', camera: 'Cam01', offset: -50.1826, rate: 1.0000052, sync: sync('audio', 5.2) },
			{ assetId: 'dji2', name: 'Cam01', camera: 'Cam01', offset: 2554.7827, rate: 1.0000063, sync: sync('audio', 6.3) },
			{ assetId: 'dji3', name: 'Cam01', camera: 'Cam01', offset: 5165.1101, rate: 0.9999794, sync: sync('audio', -20.6) }
		]
	}
	const shoot = sealCameraJoins(measured, shootMedia)

	it('seals the joins between one camera’s files: measured a few ms apart, they are one recording', () => {
		const end = (id: string) => {
			const m = shoot.members.find((x) => x.assetId === id)!
			return m.offset + shootMedia.find((a) => a.id === id)!.metadata!.duration * m.rate
		}
		expect(shoot.members.find((m) => m.assetId === 'dji2')!.offset).toBeCloseTo(end('dji1'), 9)
		expect(shoot.members.find((m) => m.assetId === 'dji3')!.offset).toBeCloseTo(end('dji2'), 9)
		// The move is noise-sized, never a real change: 2.8 ms and 7 ms here.
		expect(Math.abs(shoot.members[3].offset - measured.members[3].offset)).toBeLessThan(0.01)
		expect(shoot.members[0]).toBe(measured.members[0])
	})

	it('knows the three DJI files are one camera, numbered by its folder', () => {
		expect(anglesOf(shoot, shootMedia).map((c) => [c.name, c.members.length])).toEqual([['Cam01', 3], ['Cam02', 1]])
		const names = assignCameras(shootMedia)
		expect([...new Set(names.values())].sort()).toEqual(['Cam01', 'Cam02'])
		expect(names.get('dji3')).toBe('Cam01')
	})

	it('suggests all four files as one recording, the last DJI file joining through its camera', () => {
		const found = suggestCameraGroups(shootMedia)
		expect(found).toHaveLength(1)
		expect([...found[0].assetIds].sort()).toEqual(['dji1', 'dji2', 'dji3', 'iphone'])
		expect(found[0].strength).toBe('strong')
	})

	it('lays the DJI sound as three clips back to back, and the iPhone shot over them in sync', () => {
		const out = placeGroup(shoot, shootMedia, { videoTrackId: 'v1', audioTrackId: 'a1', atSec: 0, newId, angle: 'Cam02' })
		if ('reason' in out) throw new Error(out.reason)
		const sounds = out.items.filter((i) => i.multicam?.role === 'sound').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(sounds.map((s) => s.sourceAssetId)).toEqual(['dji1', 'dji2', 'dji3'])
		for (let k = 1; k < sounds.length; k++) {
			// Back to back to the millisecond: the files are one recording.
			expect(sounds[k].timelineStart - (sounds[k - 1].timelineStart + itemDuration(sounds[k - 1]))).toBeCloseTo(0, 6)
		}
		const shot = out.items.find((i) => i.multicam?.role === 'shot')!
		expect(shot.sourceAssetId).toBe('iphone')
		for (const t of [shot.timelineStart + 1, 2600, 5000, shot.timelineStart + itemDuration(shot) - 1]) {
			const under = sounds.find((s) => t >= s.timelineStart && t < s.timelineStart + itemDuration(s))!
			expect(groupTimeAt(shot, shoot, t)).toBeCloseTo(groupTimeAt(under, shoot, t)!, 6)
		}
	})

	it('treats the DJI’s back-to-back files as one shot: a join is not a cut', () => {
		const out = placeGroup(shoot, shootMedia, { videoTrackId: 'v1', audioTrackId: 'a1', atSec: 0, newId, angle: 'Cam01' })
		if ('reason' in out) throw new Error(out.reason)
		const shots = out.items.filter((i) => i.multicam?.role === 'shot').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(shots).toHaveLength(3)
		const run = shotRun(out.items, shots[1], shoot, shootMedia)
		expect(run.start).toBeCloseTo(shots[0].timelineStart, 9)
		expect(run.end).toBeCloseTo(shots[2].timelineStart + itemDuration(shots[2]), 9)
		// Alt + 2 on it: the whole run shows the iPhone, except where only the DJI was recording.
		const plan = planAngleSwitches(out.items, shoot, [{ atSec: run.start, angle: 2 }], shootMedia, newId, run.end)
		const timeline = out.items.filter((i) => !plan.removeIds.includes(i.id))
			.map((i) => ({ ...i, ...plan.updates.find((u) => u.id === i.id) })).concat(plan.adds)
		const after = timeline.filter((i) => i.multicam?.role === 'shot').sort((a, b) => a.timelineStart - b.timelineStart)
		const iphone = after.filter((s) => s.sourceAssetId === 'iphone')
		expect(iphone.reduce((sum, s) => sum + itemDuration(s), 0)).toBeGreaterThan(5400)
		// One file straight through is one clip, not three pieces split where the DJI's files met.
		expect(iphone).toHaveLength(1)
		expect(after.map((s) => s.sourceAssetId)).toEqual(['dji1', 'iphone', 'dji3'])
	})

	it('cuts to the DJI across the join between its files, each part from its own file', () => {
		const out = placeGroup(shoot, shootMedia, { videoTrackId: 'v1', audioTrackId: 'a1', atSec: 0, newId, angle: 'Cam02' })
		if ('reason' in out) throw new Error(out.reason)
		const plan = planAngleSwitches(out.items, shoot, [{ atSec: 2500, angle: 1 }, { atSec: 2700, angle: 2 }], shootMedia, newId)
		expect(plan.dropped).toEqual([])
		const timeline = out.items.map((i) => ({ ...i, ...plan.updates.find((u) => u.id === i.id) })).concat(plan.adds)
		const shots = timeline.filter((i) => i.multicam?.role === 'shot').sort((a, b) => a.timelineStart - b.timelineStart)
		expect(shots.map((s) => s.sourceAssetId)).toEqual(['iphone', 'dji1', 'dji2', 'iphone'])
		const sounds = timeline.filter((i) => i.multicam?.role === 'sound')
		for (const s of shots) {
			const t = s.timelineStart + itemDuration(s) / 2
			const under = sounds.find((x) => t >= x.timelineStart && t < x.timelineStart + itemDuration(x))!
			expect(groupTimeAt(s, shoot, t)).toBeCloseTo(groupTimeAt(under, shoot, t)!, 6)
		}
		expect(recordedPieces(shots[0], shoot, anglesOf(shoot, shootMedia)[0], shootMedia).map((p) => p.member.assetId)).toEqual(['dji1'])
	})
})
