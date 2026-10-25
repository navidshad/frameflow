import { v4 as uuidv4 } from 'uuid'
import type { MediaAsset, MulticamGroup, MulticamMember } from '@shared/types'
import { assignCameras, cameraSound, defaultGroupName, sealCameraJoins, soundChoicesOf, soundScore, startTimes } from '@shared/multicam'
import { syncRecordings, type SyncedMember } from './sync'

export type SyncRunner = typeof syncRecordings

/**
 * Build (or rebuild) a camera group from files in the project: work out which
 * files are one camera, sync every file by sound against the longest one, and
 * pick the cleanest camera as the main sound. The group is returned, not
 * saved: the caller commits it as an undoable edit.
 */
export async function buildCameraGroup(
	media: readonly MediaAsset[],
	assetIds: readonly string[],
	opts: {
		name?: string
		/** Rebuilding: keep its id, names, main sound and creation time. */
		existing?: MulticamGroup
		signal?: AbortSignal
		onProgress?: (fraction: number, label: string) => void
		/** Swappable for tests. */
		sync?: SyncRunner
	} = {}
): Promise<{ group: MulticamGroup; ranking: string[]; synced: SyncedMember[] }> {
	const unique = [...new Set(assetIds)]
	const assets = unique.map((id) => {
		const asset = media.find((a) => a.id === id || a.name === id)
		if (!asset) throw new Error(`There is no media "${id}" in this project.`)
		if (asset.kind !== 'video' && asset.kind !== 'audio') throw new Error(`${asset.name} is a still image; a camera group holds recordings.`)
		if (!asset.metadata?.duration) throw new Error(`${asset.name} is still being read. Wait for it to finish importing.`)
		return asset
	})
	if (assets.length < 2) throw new Error('A camera group needs at least two recordings.')
	if (!assets.some((a) => a.kind === 'video')) throw new Error('A camera group needs at least one camera (a file with a picture).')

	// Which files are one camera. Kept from the existing group on a re-sync.
	const cameras = assignCameras(assets)
	if (opts.existing) for (const m of opts.existing.members) if (m.camera) cameras.set(m.assetId, m.camera)
	if (new Set(cameras.values()).size < 2) throw new Error('These files all look like one camera. A camera group needs at least two cameras.')

	// The reference is the longest file with a picture: it overlaps the most of
	// everything else, so the most files can be measured against it directly.
	const reference = [...assets].filter((a) => a.kind === 'video')
		.sort((a, b) => (b.metadata!.duration) - (a.metadata!.duration))[0]
	const ordered = [reference, ...assets.filter((a) => a !== reference)]
	const times = startTimes(ordered)

	const synced = await (opts.sync ?? syncRecordings)(
		ordered.map((a, i) => ({ assetId: a.id, path: a.originalPath, startedAt: times[i] })),
		{ signal: opts.signal, onProgress: opts.onProgress }
	)
	continueSplitRecordings(synced, ordered, cameras, times)

	const members: MulticamMember[] = synced.map((s) => {
		const kept = opts.existing?.members.find((m) => m.assetId === s.assetId)
		const camera = cameras.get(s.assetId)!
		return {
			assetId: s.assetId,
			name: kept?.name ?? camera,
			camera,
			offset: s.offset,
			rate: s.rate,
			sync: s.sync,
			...(s.quality ? { sound: { snrDb: round1(s.quality.snrDb), clipped: s.quality.clipped } } : {})
		}
	})

	const draft: MulticamGroup = {
		id: opts.existing?.id ?? uuidv4(),
		name: opts.name ?? opts.existing?.name ?? defaultGroupName(ordered),
		members,
		soundAssetId: ordered[0].id,
		createdAt: opts.existing?.createdAt ?? Date.now()
	}
	// The main sound: the cleanest camera, judged over all its files.
	const choices = soundChoicesOf(draft, media)
		.sort((a, b) => soundScore(cameraSound(b, media)) - soundScore(cameraSound(a, media)))
	const ranking = choices.map((c) => c.members[0].assetId)
	const keepSound = opts.existing && members.some((m) => m.assetId === opts.existing!.soundAssetId)
	const group: MulticamGroup = sealCameraJoins({
		...draft,
		soundAssetId: keepSound ? opts.existing!.soundAssetId : ranking[0] ?? ordered[0].id
	}, media)
	return { group, ranking, synced }
}

/**
 * A file the sound could not place (its camera kept recording after the
 * reference stopped, say) follows on from the same camera's neighbouring
 * file: a split recording is seamless, which the sound itself proves on every
 * real one measured (the files meet to the millisecond). Marked 'continued'.
 */
function continueSplitRecordings(
	synced: SyncedMember[],
	assets: MediaAsset[],
	cameras: Map<string, string>,
	times: Array<number | undefined>
): void {
	const info = (s: SyncedMember) => {
		const i = assets.findIndex((a) => a.id === s.assetId)
		return { dur: assets[i].metadata!.duration, start: times[i] }
	}
	const byCamera = new Map<string, SyncedMember[]>()
	for (const s of synced) {
		const cam = cameras.get(s.assetId)!
		byCamera.set(cam, [...(byCamera.get(cam) ?? []), s])
	}
	for (const files of byCamera.values()) {
		if (files.length < 2) continue
		files.sort((a, b) => (info(a).start ?? 0) - (info(b).start ?? 0))
		// The gap the clocks report between two files, if any (never negative).
		const gap = (a: SyncedMember, b: SyncedMember) => {
			const ia = info(a), ib = info(b)
			return ia.start !== undefined && ib.start !== undefined
				? Math.max(0, (ib.start - ia.start) / 1000 - ia.dur)
				: 0
		}
		const placed = (s: SyncedMember) => s.sync.confidence !== 'failed'
		for (let pass = 0; pass < files.length; pass++) {
			for (let i = 0; i < files.length; i++) {
				const s = files[i]
				if (placed(s)) continue
				const prev = files[i - 1]
				const next = files[i + 1]
				if (prev && placed(prev)) {
					s.offset = prev.offset + info(prev).dur * prev.rate + gap(prev, s)
					s.rate = prev.rate
				} else if (next && placed(next)) {
					s.rate = next.rate
					s.offset = next.offset - gap(s, next) - info(s).dur * s.rate
				} else continue
				s.sync = { method: 'continued', confidence: 'weak', driftPpm: Math.round((s.rate - 1) * 1e7) / 10 }
			}
		}
	}
}

const round1 = (n: number) => Math.round(n * 10) / 10
