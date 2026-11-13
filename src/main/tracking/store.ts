import fs from 'node:fs'
import path from 'node:path'
import type { ObjectTrack } from '@shared/tracking'
import type { TimelineItem } from '@shared/types'
import { THREAD_DIRS } from '../constants/paths'

/**
 * Tracks on disk: one JSON file each, in `tracks/` beside the rest of what is
 * known about a media file (its proxy, transcript, scenes). They are kept out
 * of the project document on purpose: a track is a few hundred samples per
 * second of footage, and the document is saved on every edit.
 */

const TRACK_ID = /^trk_[a-f0-9]{8}$/

export const tracksDir = (assetDir: string): string => path.join(assetDir, 'tracks')

const round = (n: number, places: number): number => {
	const f = 10 ** places
	return Math.round(n * f) / f
}

export function saveTrack(assetDir: string, track: ObjectTrack): void {
	const dir = tracksDir(assetDir)
	fs.mkdirSync(dir, { recursive: true })
	const slim: ObjectTrack = {
		...track,
		samples: track.samples.map((s) => ({
			t: round(s.t, 4), cx: round(s.cx, 5), cy: round(s.cy, 5), w: round(s.w, 5), h: round(s.h, 5), score: round(s.score, 3),
			...(s.filled ? { filled: true } : {}),
			...(s.bridged ? { bridged: true } : {})
		}))
	}
	const file = path.join(dir, `${track.id}.json`)
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(slim))
	fs.renameSync(`${file}.tmp`, file)
}

export function loadTrack(assetDir: string, id: string): ObjectTrack | null {
	if (!TRACK_ID.test(id)) return null
	try {
		return JSON.parse(fs.readFileSync(path.join(tracksDir(assetDir), `${id}.json`), 'utf8')) as ObjectTrack
	} catch {
		return null
	}
}

export function listTracks(assetDir: string): ObjectTrack[] {
	let files: string[] = []
	try {
		files = fs.readdirSync(tracksDir(assetDir))
	} catch {
		return []
	}
	return files
		.filter((f) => f.endsWith('.json') && TRACK_ID.test(f.slice(0, -5)))
		.map((f) => loadTrack(assetDir, f.slice(0, -5)))
		.filter((t): t is ObjectTrack => !!t)
		.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name))
}

export function deleteTrack(assetDir: string, id: string): boolean {
	if (!TRACK_ID.test(id)) return false
	const file = path.join(tracksDir(assetDir), `${id}.json`)
	if (!fs.existsSync(file)) return false
	fs.rmSync(file)
	return true
}

/**
 * The tracks the timeline's following layers name, read from the project
 * folder. What the export and the exact frame are handed, so they draw a
 * following layer from the same track the monitor does.
 */
export function followTracksFor(timeline: readonly TimelineItem[], projectDir: string): ObjectTrack[] {
	const wanted = new Map<string, string>()
	for (const item of timeline) if (item.follow && item.motion) wanted.set(item.follow.trackId, item.follow.assetId)
	const tracks: ObjectTrack[] = []
	for (const [trackId, assetId] of wanted) {
		const track = loadTrack(path.join(projectDir, THREAD_DIRS.MEDIA, assetId), trackId)
		if (track) tracks.push(track)
	}
	return tracks
}
