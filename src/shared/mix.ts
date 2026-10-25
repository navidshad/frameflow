/**
 * A read on the mix: how loud each kind of sound sits against the voice.
 *
 * An agent cannot hear, and the real mix is only made when the video is
 * exported, so this ESTIMATES from what is already measured: each source's
 * loudness and peak (shared/audio.ts), moved by the gain its clip and its track
 * apply. That is exact for a clip playing alone and a fair picture of the whole;
 * it does not model two clips adding together or music ducking under speech,
 * and says so rather than pretending.
 *
 * Pure: the caller supplies the analyses.
 */
import type { MediaAsset, Track, TimelineItem } from './types'
import { gainToDb, roleSpec, type AudioAnalysis, type TrackRole } from './audio'

export interface MixClip {
	id: string
	label: string
	track: string
	role: TrackRole | null
	startSec: number
	endSec: number
	/** Source loudness moved by the clip's and track's gain. Null when the source was not measured. */
	estLufs: number | null
	estPeakDb: number | null
	gainDb: number
}

export interface MixRole {
	role: TrackRole | 'unassigned'
	clips: number
	/** The middle clip's estimated loudness: one number to compare roles by. */
	medianLufs: number | null
	loudestPeakDb: number | null
}

export interface MixReport {
	roles: MixRole[]
	clips: MixClip[]
	/** Plain sentences about what is off. Empty means nothing stood out. */
	warnings: string[]
	/** What the estimate leaves out, so a reader knows how far to trust it. */
	caveats: string[]
}

type MixDoc = { tracks: Track[]; timeline: TimelineItem[]; media: MediaAsset[]; loudnessEnabled?: boolean }

const median = (values: number[]): number | null => {
	if (!values.length) return null
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const r1 = (n: number | null): number | null => (n === null ? null : Math.round(n * 10) / 10)

/**
 * The loudness meter's floor. A sound shorter than its 400 ms window (a pop, a
 * swish) reads as this, which says nothing about how loud it is: such a clip
 * is left out of its role's median rather than dragging it to "too quiet".
 */
export const UNMEASURED_LUFS = -69.5

/** The clips that make sound: on an audio track, or carrying audio in a video clip. */
export function estimateMix(doc: MixDoc, analyses: Record<string, AudioAnalysis | undefined>): MixReport {
	const tracks = new Map(doc.tracks.map((t) => [t.id, t]))
	const clips: MixClip[] = []
	/** Clips too short for the meter: judged by their peak, not their loudness. */
	const tooShort = new Set<string>()

	for (const item of doc.timeline) {
		if (item.muted || item.text || item.generator || item.motion) continue
		const track = tracks.get(item.trackId)
		if (!track || track.muted || track.hidden) continue
		const asset = doc.media.find((a) => a.id === item.sourceAssetId)
		if (!asset) continue
		// Sound from an audio track, or the voice riding on a video clip. A video
		// with no audio stream makes none.
		const a = analyses[asset.id]
		if (track.kind === 'video' && (asset.kind !== 'video' || a?.hasAudio === false)) continue
		if (track.kind === 'audio' && a?.hasAudio === false) continue

		if (a?.lufs != null && a.lufs <= UNMEASURED_LUFS) tooShort.add(item.id)
		const gainDb = gainToDb((item.gain ?? 1) * (track.gain ?? 1))
		const finite = Number.isFinite(gainDb)
		clips.push({
			id: item.id,
			label: item.label || asset.name,
			track: track.name,
			role: track.kind === 'audio' ? track.role ?? null : 'voice',
			startSec: item.timelineStart,
			endSec: item.timelineStart + item.duration,
			estLufs: a?.lufs != null && a.lufs > UNMEASURED_LUFS && finite ? r1(a.lufs + gainDb) : null,
			estPeakDb: a?.truePeakDb != null && finite ? r1(a.truePeakDb + gainDb) : null,
			gainDb: finite ? r1(gainDb)! : -120
		})
	}

	const roleOf = (c: MixClip): MixRole['role'] => c.role ?? 'unassigned'
	const names: MixRole['role'][] = ['voice', 'music', 'sfx', 'unassigned']
	const roles: MixRole[] = names
		.map((role) => {
			const mine = clips.filter((c) => roleOf(c) === role)
			const loud = mine.map((c) => c.estLufs).filter((v): v is number => v !== null)
			const peaks = mine.map((c) => c.estPeakDb).filter((v): v is number => v !== null)
			return {
				role, clips: mine.length,
				medianLufs: r1(median(loud)),
				loudestPeakDb: peaks.length ? r1(Math.max(...peaks)) : null
			}
		})
		.filter((r) => r.clips > 0)

	const warnings: string[] = []
	const by = (role: MixRole['role']) => roles.find((r) => r.role === role)
	const voice = by('voice')?.medianLufs ?? null

	for (const role of ['music', 'sfx'] as const) {
		const mine = by(role)
		const spec = roleSpec(role)!
		if (voice === null || !mine || mine.medianLufs === null) continue
		const under = voice - mine.medianLufs
		const want = Math.abs(spec.offsetLU)
		if (under < want / 2) {
			warnings.push(
				`${spec.label} sits only ${under.toFixed(1)} LU under the voice (${mine.medianLufs} vs ${voice} LUFS); ` +
				`it should sit about ${want} LU under. Lower its level or its clips' gain.`
			)
		} else if (under > want + 12) {
			warnings.push(
				`${spec.label} is ${under.toFixed(1)} LU under the voice (${mine.medianLufs} vs ${voice} LUFS): ` +
				`probably too quiet to be heard. About ${want} LU under is usual.`
			)
		}
	}

	const hot = clips.filter((c) => c.estPeakDb !== null && c.estPeakDb > -1)
	for (const c of hot.slice(0, 5)) {
		warnings.push(`"${c.label}" on ${c.track} peaks at ${c.estPeakDb} dBTP: it will clip. Lower its gain.`)
	}
	if (hot.length > 5) warnings.push(`${hot.length - 5} more clips peak above −1 dBTP.`)

	const unmeasured = clips.filter((c) => c.estLufs === null && !tooShort.has(c.id)).length
	if (unmeasured) warnings.push(`${unmeasured} clip${unmeasured === 1 ? ' has' : 's have'} not been measured yet; read again in a moment.`)

	return {
		roles,
		clips: [...clips].sort((a, b) => a.startSec - b.startSec),
		warnings,
		caveats: [
			'Estimated from each source’s measured loudness and the gain applied; two clips playing together add, which this does not model.',
			'A music bed ducks under speech at export, which this does not model.',
			...(tooShort.size ? [`${tooShort.size} clip${tooShort.size === 1 ? ' is' : 's are'} shorter than the loudness meter's 400 ms window (pops, clicks, swishes): left out of the role levels; check them by their peak.`] : []),
			doc.loudnessEnabled
				? 'Loudness is on: the finished mix is normalised to −14 LUFS, so the gaps BETWEEN roles matter, not their absolute levels.'
				: 'Loudness is off: the finished mix keeps the levels above.'
		]
	}
}
