import type { MediaAsset, MulticamGroup, MulticamSpeakers, SpeakerTurn } from '@shared/types'
import { camerasOf, memberSpan, soundCameraOf } from '@shared/multicam'
import { carryOver, colorFor, defaultName } from '@shared/speakers'
import { decodeMono } from './sync'
import { FRAME_SEC, newMicTrack, type MicTrack } from './diarizeMath'
import { SEPARABLE, clusterVoices, fillMicTrack, type VoiceClusters } from './diarizeTracks'

/**
 * Who speaks when, for a camera group, found once by sound.
 *
 * Every camera's microphone is measured on the group's clock (so a camera that
 * split its recording into files, or started late, is one continuous track),
 * the frames are clustered into voices, and the voices' turns come back as
 * `MulticamSpeakers` for the caller to commit as an undoable edit. The method
 * and what it cannot do are in diarizeMath.ts and docs/multicam.md.
 */

export interface DiarizeOptions {
	/** How many people speak. Estimated when left out (see estimateSpeakers); say so when it is. */
	speakers?: number
	signal?: AbortSignal
	onProgress?: (fraction: number, label: string) => void
	/** A speaker analysis already on the group: names, cameras and hand-fixed turns carry over. */
	keepFrom?: MulticamSpeakers
}

/** Group seconds of speech below which the analysis refuses: not enough to tell voices apart. */
const MIN_SPEECH_SEC = 30

export async function diarizeGroup(
	group: MulticamGroup,
	media: readonly MediaAsset[],
	opts: DiarizeOptions = {}
): Promise<MulticamSpeakers> {
	const cameras = camerasOf(group, media).filter((c) => c.members.some((m) => {
		const a = media.find((x) => x.id === m.assetId)
		return !!a && a.metadata?.hasAudio !== false
	}))
	if (!cameras.length) throw new Error('None of this group\'s files has sound to listen to.')
	// The main sound first: closeness is each other microphone against it.
	const main = soundCameraOf(group, media)
	cameras.sort((a, b) => Number(b === main) - Number(a === main))

	let start = Infinity, end = -Infinity
	for (const cam of cameras) {
		for (const m of cam.members) {
			const span = memberSpan(m, media.find((a) => a.id === m.assetId)?.metadata?.duration ?? 0)
			start = Math.min(start, span.start)
			end = Math.max(end, span.end)
		}
	}
	const frames = Math.ceil((end - start) / FRAME_SEC)
	if (!(frames > 100)) throw new Error('The recordings are too short to find speakers in.')

	const files = cameras.flatMap((cam) => cam.members.map((m) => ({ cam, member: m })))
	const tracks: MicTrack[] = cameras.map(() => newMicTrack(frames))
	for (const [i, { cam, member }] of files.entries()) {
		if (opts.signal?.aborted) throw new Error('Finding speakers was cancelled.')
		const asset = media.find((a) => a.id === member.assetId)!
		// Straight from the original, as the sync does: a proxy's encode can shift or colour the sound.
		const samples = await decodeMono(asset.originalPath, opts.signal)
		fillMicTrack(tracks[cameras.indexOf(cam)], samples, member, start)
		opts.onProgress?.(((i + 1) / (files.length + 1)) * 0.9, `Listening to ${asset.name} (${i + 1} of ${files.length})`)
		await new Promise<void>((r) => setImmediate(r))
	}

	opts.onProgress?.(0.92, 'Telling voices apart')
	const clusters = clusterVoices(tracks, start, { speakers: opts.speakers })
	if (!clusters) throw new Error(`Not enough speech to tell voices apart (less than ${MIN_SPEECH_SEC} seconds).`)
	const speechSec = clusters.voices.reduce((s, v) => s + v.talkSec, 0)
	if (speechSec < MIN_SPEECH_SEC) throw new Error(`Only ${Math.round(speechSec)} seconds of speech was heard; that is not enough to tell voices apart.`)

	const result = speakersFrom(clusters, cameras.map((c) => c.key), opts.speakers)
	opts.onProgress?.(1, 'Done')
	return carryOver(opts.keepFrom, result)
}

/** Voices ordered by how much they speak, named Speaker 1…, with the cautions that matter. */
export function speakersFrom(clusters: VoiceClusters, cameraKeys: string[], requested?: number): MulticamSpeakers {
	const order = clusters.voices.map((v, i) => ({ v, i })).sort((a, b) => b.v.talkSec - a.v.talkSec)
	const idOf = new Map(order.map(({ i }, n) => [i, `spk-${n + 1}`]))
	const people = order.map(({ v, i }, n) => ({
		id: idOf.get(i)!,
		name: defaultName(n),
		color: colorFor(n),
		pitchHz: v.pitchHz,
		talkSec: Math.round(v.talkSec),
		// Only when a microphone clearly hears this voice better than it hears the others: see the
		// docs; in a shared room the cameras' microphones hear everybody, so this is usually absent.
		...(v.closest >= 0 ? { camera: cameraKeys[v.closest] } : {})
	}))
	const turns: SpeakerTurn[] = clusters.turns.map((t) => ({
		start: Math.round(t.start * 100) / 100,
		end: Math.round(t.end * 100) / 100,
		speaker: t.speaker >= 0 ? idOf.get(t.speaker)! : null,
		confidence: t.confidence
	}))
	const talk = clusters.turns.reduce((s, t) => s + (t.end - t.start), 0)
	const unsure = clusters.turns.filter((t) => t.speaker < 0).reduce((s, t) => s + (t.end - t.start), 0)

	const warnings: string[] = []
	if (!requested) warnings.push(`The number of speakers (${clusters.k}) was estimated, and the estimate is a guess. Count the people in a frame (get_angles) and run find_speakers again with speakers set; if one person was split in two, mergeSpeakers fixes it.`)
	for (let a = 0; a < clusters.k; a++) {
		for (let b = a + 1; b < clusters.k; b++) {
			if (clusters.separation[a][b] < SEPARABLE / 2) {
				const [x, y] = [people[order.findIndex((o) => o.i === a)], people[order.findIndex((o) => o.i === b)]]
				warnings.push(`${x.name} and ${y.name} sound alike (pitch ${x.pitchHz ?? '?'} and ${y.pitchHz ?? '?'} Hz) and may share a microphone: expect mix-ups between them, especially in short turns. Check their turns against a frame.`)
			}
		}
	}
	return {
		people,
		turns,
		analysis: {
			analyzedAt: Date.now(),
			requested,
			cameras: cameraKeys,
			unsureShare: talk ? Math.round((unsure / talk) * 1000) / 1000 : 0,
			warnings
		}
	}
}
