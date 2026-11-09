import { randomBytes } from 'node:crypto'
import {
	bridgeGap, fillGaps, groupPeople, LOST_FRAMES_TO_STOP, MAX_BRIDGE_SEC, measuredFps, objectLost, TrackletLinker,
	type BridgeGuess, type ObjectTrack, type TrackEnd, type TrackSample, type TrackShape
} from '@shared/tracking'
import { readFrames, readFramesBackward, type TimedFrame } from './frames'
import { drawBox, frameToPpm, greyThumb, pictureShift, resizeWindow, sharpness, type Frame, type Grey } from './image'
import { detectFaces, type Face } from './yunet'
import { embedFace } from './sface'
import { ObjectFollower } from './vittrack'

/**
 * The two ways a track is made: every face in a stretch of footage, or one box
 * followed from a frame. Both read frames from ffmpeg, run the models, and
 * return tracks in source seconds and picture fractions, plus small pictures
 * ("tiles") an agent or a person can look at to check the result.
 */

export interface Tile {
	/** Source seconds of the frame the tile was cut from. */
	t: number
	/** A PPM picture (ffmpeg reads it). */
	ppm: Buffer
	trackId: string
}

export type Progress = (fraction: number, label: string) => void

export const newTrackId = (): string => `trk_${randomBytes(4).toString('hex')}`

// Faces are small in a wide shot, so they get more pixels than a followed box needs.
const FACE_LONG_SIDE = 1280
const OBJECT_LONG_SIDE = 960
const SHIFT_THUMB = 240
/** A face matcher needs a face it can see: this sure, and at least this many pixels. */
const EMBED_MIN_SCORE = 0.7
const EMBED_MIN_PX = 18
const EMBED_EVERY = 4
const EMBED_MAX = 12
/** Runs shorter than this are flickers of the detector (a fist, a poster), not people. */
const MIN_TRACKLET_FRAMES = 3
const MIN_PERSON_FRAMES = 5
const TILE = 220

interface Tracklet {
	id: number
	frames: number[]
	samples: TrackSample[]
	embeddings: Float32Array[]
	best: { quality: number; t: number; ppm: Buffer } | null
}

/** The face with room around it (hair, hood, collar: what a person tells people apart by), boxed. */
function faceTile(frame: Frame, face: Face): Buffer {
	const side = Math.round(Math.max(face.w, face.h) * 2.8)
	const x = Math.round(face.x + face.w / 2 - side / 2), y = Math.round(face.y + face.h / 2 - side / 2)
	const tile = resizeWindow(frame, { x, y, w: side, h: side }, TILE, TILE)
	const k = TILE / side
	drawBox(tile, { x: (face.x - x) * k, y: (face.y - y) * k, w: face.w * k, h: face.h * k }, [0, 220, 0], 2)
	return frameToPpm(tile)
}

export interface FaceScan {
	/** One track per person, the one seen longest first. Not saved yet. */
	tracks: ObjectTrack[]
	/** One tile per track: that person's clearest frame. */
	tiles: Tile[]
	frames: number
}

export async function scanFaces(
	file: string, assetId: string, options: { fromSec: number; toSec: number; onProgress?: Progress }
): Promise<FaceScan> {
	const linker = new TrackletLinker()
	const tracklets = new Map<number, Tracklet>()
	let prev: Grey | null = null
	let index = 0
	const span = Math.max(0.001, options.toSec - options.fromSec)
	for await (const frame of readFrames(file, { fromSec: options.fromSec, toSec: options.toSec, longSide: FACE_LONG_SIDE })) {
		const faces = await detectFaces(frame)
		const grey = greyThumb(frame, SHIFT_THUMB)
		const k = frame.width / grey.width
		const moved = prev ? pictureShift(prev, grey) : { dx: 0, dy: 0 }
		prev = grey
		const ids = linker.step(
			faces.map((f) => ({ cx: f.x + f.w / 2, cy: f.y + f.h / 2, w: f.w, h: f.h })),
			{ dx: moved.dx * k, dy: moved.dy * k }
		)
		for (let n = 0; n < faces.length; n++) {
			const face = faces[n]
			let tracklet = tracklets.get(ids[n])
			if (!tracklet) tracklets.set(ids[n], (tracklet = { id: ids[n], frames: [], samples: [], embeddings: [], best: null }))
			tracklet.frames.push(index)
			tracklet.samples.push({
				t: frame.t, cx: (face.x + face.w / 2) / frame.width, cy: (face.y + face.h / 2) / frame.height,
				w: face.w / frame.width, h: face.h / frame.height, score: face.score
			})
			const px = Math.min(face.w, face.h)
			if ((tracklet.frames.length - 1) % EMBED_EVERY === 0 && tracklet.embeddings.length < EMBED_MAX && face.score >= EMBED_MIN_SCORE && px >= EMBED_MIN_PX) {
				tracklet.embeddings.push(await embedFace(frame, face.landmarks))
			}
			// The clearest look at them: sure, sharp, and not tiny.
			const quality = face.score * sharpness(frame, face) * Math.sqrt(px)
			if (!tracklet.best || quality > tracklet.best.quality * 1.15) tracklet.best = { quality, t: frame.t, ppm: faceTile(frame, face) }
		}
		index++
		if (index % 10 === 0) options.onProgress?.(Math.min(0.98, (frame.t - options.fromSec) / span), `${index} frames`)
	}

	const kept = [...tracklets.values()].filter((t) => t.frames.length >= MIN_TRACKLET_FRAMES)
	const people = groupPeople(kept.map((t) => ({ id: t.id, frames: t.frames, embeddings: t.embeddings })))
	const tracks: ObjectTrack[] = []
	const tiles: Tile[] = []
	const createdAt = Date.now()
	for (const ids of people) {
		const parts = ids.map((id) => tracklets.get(id)!)
		const measured = parts.flatMap((p) => p.samples).sort((a, b) => a.t - b.t)
		if (measured.length < MIN_PERSON_FRAMES) continue
		const fps = measuredFps(kept.reduce((a, b) => (b.samples.length > a.samples.length ? b : a)).samples)
		const id = newTrackId()
		// Where the detector lost them for a while (hidden behind someone, side-on, a blur), follow
		// the face across the gap from both ends. A short gap is simply filled on a straight line.
		const bridged: TrackSample[] = []
		for (let i = 1; i < measured.length; i++) {
			const before = measured[i - 1], after = measured[i]
			const gap = after.t - before.t
			if (gap <= FILL_MAX_SEC + 1e-6 || gap > MAX_BRIDGE_SEC) continue
			options.onProgress?.(0.99, `following ${`Person ${tracks.length + 1}`} across a gap`)
			bridged.push(...await bridgeFace(file, before, after, fps))
		}
		const joined = bridged.length ? [...measured, ...bridged].sort((a, b) => a.t - b.t) : measured
		tracks.push({
			id, assetId, kind: 'face', name: `Person ${tracks.length + 1}`, shape: 'ellipse', fps,
			samples: fillGaps(joined, fps), scannedFrom: options.fromSec, scannedTo: options.toSec, createdAt
		})
		const best = parts.map((p) => p.best).filter((b): b is NonNullable<Tracklet['best']> => !!b).sort((a, b) => b.quality - a.quality)[0]
		if (best) tiles.push({ t: best.t, ppm: best.ppm, trackId: id })
	}
	options.onProgress?.(1, `${tracks.length} people`)
	return { tracks, tiles, frames: index }
}

/** A gap this short is filled on a straight line (`fillGaps`); a longer one is followed across. */
const FILL_MAX_SEC = 0.4
/** The follower is given the head, not just the face: more to hold on to when the face turns away. */
const HEAD = 1.7

/** Follows a face's head box from `start` through `frames`, until the follower stops believing it. */
async function followHead(first: TimedFrame, start: TrackSample, frames: AsyncGenerator<TimedFrame>): Promise<BridgeGuess[]> {
	const follower = new ObjectFollower()
	const w = start.w * HEAD, h = start.h * HEAD
	await follower.start(first, { x: (start.cx - w / 2) * first.width, y: (start.cy - h / 2) * first.height, w: w * first.width, h: h * first.height })
	const out: BridgeGuess[] = []
	let believed = { w, h }
	let lostRun = 0
	for await (const frame of frames) {
		const { box, score } = await follower.step(frame)
		const now = { w: box.w / frame.width, h: box.h / frame.height, score }
		if (objectLost(now, believed)) {
			if (++lostRun >= LOST_FRAMES_TO_STOP) break
			continue
		}
		lostRun = 0
		believed = now
		out.push({ t: frame.t, cx: (box.x + box.w / 2) / frame.width, cy: (box.y + box.h / 2) / frame.height, score })
	}
	return out
}

/** The frames between two sightings of a face, followed from both ends (`bridgeGap` decides what to keep). */
async function bridgeFace(file: string, before: TrackSample, after: TrackSample, fps: number): Promise<TrackSample[]> {
	const half = 0.5 / fps
	const read = { longSide: FACE_LONG_SIDE }
	const forwardFrames = readFrames(file, { ...read, fromSec: before.t - half, toSec: after.t - half })
	const first = await forwardFrames.next()
	if (first.done) return []
	const forward = await followHead(first.value, before, forwardFrames)
	await forwardFrames.return(undefined)

	const backwardFrames = readFramesBackward(file, { ...read, fromSec: before.t + half, toSec: after.t + half })
	const last = await backwardFrames.next()
	if (last.done) return []
	const backward = await followHead(last.value, after, backwardFrames)
	await backwardFrames.return(undefined)
	return bridgeGap(before, after, forward, backward, fps)
}

// ===== Following one box =====

export interface FollowOptions {
	/** Source seconds of the frame the box was drawn on. */
	atSec: number
	/** The box on that frame: top-left corner and size, as fractions of the picture. */
	box: { x: number; y: number; w: number; h: number }
	direction: 'forward' | 'backward' | 'both'
	/** How far to follow it, in source seconds. */
	fromSec: number
	toSec: number
	name: string
	shape: TrackShape
	onProgress?: Progress
}

export interface FollowResult {
	track: ObjectTrack
	/** Frames along the track with the box drawn, for checking it by eye. */
	tiles: Tile[]
}

const MAX_TILES = 12
const TILE_WIDTH = 400

function checkTile(frame: TimedFrame, sample: TrackSample, trackId: string): Tile {
	const h = Math.round((frame.height * TILE_WIDTH) / frame.width)
	const small = resizeWindow(frame, { x: 0, y: 0, w: frame.width, h: frame.height }, TILE_WIDTH, h)
	drawBox(small, { x: (sample.cx - sample.w / 2) * TILE_WIDTH, y: (sample.cy - sample.h / 2) * h, w: sample.w * TILE_WIDTH, h: sample.h * h }, [0, 220, 0], 2)
	return { t: frame.t, ppm: frameToPpm(small), trackId }
}

/** Follows from `first` through `frames`, stopping when the follower has lost it. */
async function follow(
	first: TimedFrame, start: FollowOptions['box'], frames: AsyncGenerator<TimedFrame>, onFrame: (frame: TimedFrame, sample: TrackSample) => void
): Promise<{ samples: TrackSample[]; end: TrackEnd }> {
	const follower = new ObjectFollower()
	await follower.start(first, { x: start.x * first.width, y: start.y * first.height, w: start.w * first.width, h: start.h * first.height })
	const samples: TrackSample[] = []
	let believed = { w: start.w, h: start.h }
	let lostRun = 0
	for await (const frame of frames) {
		const { box, score } = await follower.step(frame)
		const sample: TrackSample = {
			t: frame.t, cx: (box.x + box.w / 2) / frame.width, cy: (box.y + box.h / 2) / frame.height,
			w: box.w / frame.width, h: box.h / frame.height, score
		}
		if (objectLost(sample, believed)) {
			// A doubted frame is left out (a short gap is filled in afterwards); a run of them ends the track.
			if (++lostRun >= LOST_FRAMES_TO_STOP) return { samples, end: 'lost' }
			continue
		}
		lostRun = 0
		believed = { w: sample.w, h: sample.h }
		samples.push(sample)
		onFrame(frame, sample)
	}
	return { samples, end: 'range' }
}

export async function followObject(file: string, assetId: string, options: FollowOptions): Promise<FollowResult> {
	const id = newTrackId()
	const read = { longSide: OBJECT_LONG_SIDE }
	let tiles: Tile[] = []
	let every = 1
	let seen = 0
	const span = Math.max(0.001, options.toSec - options.fromSec)
	const onFrame = (frame: TimedFrame, sample: TrackSample) => {
		if (seen++ % every === 0) tiles.push(checkTile(frame, sample, id))
		// Keep the tiles evenly spread without knowing the length in advance: when full, drop every other one.
		if (tiles.length > MAX_TILES * 2) { tiles = tiles.filter((_, i) => i % 2 === 0); every *= 2 }
		if (seen % 10 === 0) options.onProgress?.(Math.min(0.98, seen / (span * 30)), `${seen} frames`)
	}

	const forwardFrames = readFrames(file, { ...read, fromSec: options.atSec, toSec: options.direction === 'backward' ? options.atSec + 1 : options.toSec })
	const opening = await forwardFrames.next()
	if (opening.done) throw new Error('There is no frame at that time in the file.')
	const first = opening.value
	const startSample: TrackSample = {
		t: first.t, cx: options.box.x + options.box.w / 2, cy: options.box.y + options.box.h / 2, w: options.box.w, h: options.box.h, score: 1
	}
	const ended: NonNullable<ObjectTrack['ended']> = {}
	let after: TrackSample[] = []
	let before: TrackSample[] = []
	tiles.push(checkTile(first, startSample, id))

	if (options.direction !== 'backward') {
		const run = await follow(first, options.box, forwardFrames, onFrame)
		after = run.samples
		ended.forward = run.end
	}
	await forwardFrames.return(undefined)
	if (options.direction !== 'forward' && first.t > options.fromSec + 1e-3) {
		const run = await follow(first, options.box, readFramesBackward(file, { ...read, fromSec: options.fromSec, toSec: first.t }), onFrame)
		before = run.samples.reverse()
		ended.backward = run.end
	}

	const measured = [...before, startSample, ...after]
	const fps = measuredFps(measured)
	tiles.sort((a, b) => a.t - b.t)
	while (tiles.length > MAX_TILES) tiles = tiles.filter((_, i) => i % 2 === 0 || i === tiles.length - 1)
	options.onProgress?.(1, `${measured.length} frames`)
	return {
		track: {
			id, assetId, kind: 'object', name: options.name, shape: options.shape, fps,
			samples: fillGaps(measured, fps), scannedFrom: options.fromSec, scannedTo: options.toSec, ended, createdAt: Date.now()
		},
		tiles
	}
}
