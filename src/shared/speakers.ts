import type { MediaAsset, MulticamGroup, MulticamSpeaker, MulticamSpeakers, SpeakerTurn } from './types'
import type { TranscriptEntry } from './captions'
import { camerasOf, resolveCamera } from './multicam'

/**
 * Who speaks when, on a camera group's clock. The analysis (main/multicam/
 * diarize.ts) finds voices and their turns by sound; everything a person or an
 * agent does afterwards — name a voice, merge two, fix a stretch — and
 * everything that READS it — a speaker on each transcript line — lives here, so
 * the editor and MCP cannot answer differently.
 *
 * A turn with `speaker: null` is "unsure": the analysis would rather say so
 * than guess (overlapping speech, a voice it heard too little of, two people
 * on one microphone who sound alike).
 */

type Media = readonly Pick<MediaAsset, 'id' | 'kind' | 'metadata'>[]

/** Distinct, readable on both a dark and a light panel. */
export const SPEAKER_COLORS = ['#f97316', '#38bdf8', '#a78bfa', '#4ade80', '#f472b6', '#facc15'] as const

export const colorFor = (index: number): string => SPEAKER_COLORS[index % SPEAKER_COLORS.length]

/** A turn at or above this confidence is stated as fact; below it, say "probably". */
export const SURE = 0.8

const round2 = (n: number) => Math.round(n * 100) / 100

// ===== Finding a speaker =====

/** A speaker by id, 1-based number ("2"), or name (case-insensitive). */
export function resolveSpeaker(sp: MulticamSpeakers | undefined, ref: string | number): MulticamSpeaker | undefined {
	if (!sp) return undefined
	const text = String(ref).trim()
	return sp.people.find((p) => p.id === text) ??
		(/^\d+$/.test(text) ? sp.people[Number(text) - 1] : undefined) ??
		sp.people.find((p) => p.name.trim().toLowerCase() === text.toLowerCase())
}

/** The turn covering a group instant (binary search; turns are ascending). */
export function turnAt(sp: MulticamSpeakers | undefined, groupSec: number): SpeakerTurn | undefined {
	const turns = sp?.turns
	if (!turns?.length) return undefined
	let lo = 0, hi = turns.length - 1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const t = turns[mid]
		if (groupSec < t.start) hi = mid - 1
		else if (groupSec >= t.end) lo = mid + 1
		else return t
	}
	return undefined
}

export interface SpeakerShare {
	speaker: MulticamSpeaker | null
	/** 0..1: how much of the stretch's SPEECH this speaker holds. */
	share: number
	/** The model's confidence in the turns that decided it, 0..1. */
	confidence: number
	/** Others heard in the stretch (more than a second), by name. */
	alsoHeard: string[]
}

/**
 * Who speaks in [start, end): the speaker holding most of the speech there, with
 * how much that is. null when no turn overlaps (silence) or the biggest share is "unsure".
 */
export function speakerIn(sp: MulticamSpeakers | undefined, start: number, end: number): SpeakerShare | undefined {
	if (!sp?.turns.length || end <= start) return undefined
	const held = new Map<string | null, { sec: number; conf: number }>()
	let total = 0
	for (let i = lowerBound(sp.turns, start); i < sp.turns.length && sp.turns[i].start < end; i++) {
		const t = sp.turns[i]
		const sec = Math.min(end, t.end) - Math.max(start, t.start)
		if (sec <= 0) continue
		const h = held.get(t.speaker) ?? { sec: 0, conf: 0 }
		h.sec += sec
		h.conf += t.confidence * sec
		held.set(t.speaker, h)
		total += sec
	}
	if (!total) return undefined
	const ranked = [...held.entries()].sort((a, b) => b[1].sec - a[1].sec)
	const [topId, top] = ranked[0]
	const name = (id: string | null) => sp.people.find((p) => p.id === id)?.name
	return {
		speaker: topId ? sp.people.find((p) => p.id === topId) ?? null : null,
		share: round2(top.sec / total),
		confidence: round2(top.conf / top.sec),
		alsoHeard: ranked.slice(1).filter(([id, h]) => id && h.sec >= 1).map(([id]) => name(id)!).filter(Boolean)
	}
}

function lowerBound(turns: readonly SpeakerTurn[], t: number): number {
	let lo = 0, hi = turns.length
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (turns[mid].end <= t) lo = mid + 1
		else hi = mid
	}
	return lo
}

// ===== Transcript lines =====

export interface SpokenLine extends TranscriptEntry {
	/** The speaker's name; "unsure" when the analysis would not say; absent before "Find speakers" ran. */
	speaker?: string
	speakerId?: string | null
	/** The analysis's confidence in that speaker, 0..1. */
	speakerConfidence?: number
	/** Other voices heard during the line (it spans a change of speaker, or an interjection). */
	alsoHeard?: string[]
}

/** Each line of the group's transcript with the speaker holding most of it. */
export function labelTranscript(lines: readonly TranscriptEntry[], sp: MulticamSpeakers | undefined): SpokenLine[] {
	if (!sp) return [...lines]
	return lines.map((line) => {
		const found = speakerIn(sp, line.start, line.end)
		if (!found) return { ...line, speaker: 'unsure', speakerId: null }
		return {
			...line,
			speaker: found.speaker && found.share >= 0.5 ? found.speaker.name : 'unsure',
			speakerId: found.speaker && found.share >= 0.5 ? found.speaker.id : null,
			speakerConfidence: round2(found.confidence * found.share),
			...(found.alsoHeard.length ? { alsoHeard: found.alsoHeard } : {})
		}
	})
}

// ===== Edits =====

const withSpeakers = (group: MulticamGroup, speakers: MulticamSpeakers): MulticamGroup => ({ ...group, speakers })

export function renameSpeaker(group: MulticamGroup, ref: string | number, name: string): MulticamGroup | string {
	const sp = group.speakers
	const target = resolveSpeaker(sp, ref)
	const clean = name.trim()
	if (!sp || !target) return `there is no speaker "${ref}" (speakers: ${listSpeakers(sp)})`
	if (!clean) return 'a speaker needs a name'
	if (sp.people.some((p) => p.id !== target.id && p.name.trim().toLowerCase() === clean.toLowerCase())) {
		return `another speaker is already called "${clean}"; merge them with mergeSpeakers if they are one person`
	}
	return withSpeakers(group, { ...sp, people: sp.people.map((p) => (p.id === target.id ? { ...p, name: clean } : p)) })
}

export interface SpeakerPatch {
	name?: string
	/** Camera key, or null to clear. */
	camera?: string | null
	framing?: string | null
	color?: string
}

/** Name or describe a voice. `camera` is a camera key (already resolved by the caller). */
export function patchSpeaker(group: MulticamGroup, ref: string | number, patch: SpeakerPatch): MulticamGroup | string {
	const sp = group.speakers
	const target = resolveSpeaker(sp, ref)
	if (!sp || !target) return `there is no speaker "${ref}" (speakers: ${listSpeakers(sp)})`
	let next = group
	if (patch.name !== undefined) {
		const renamed = renameSpeaker(group, ref, patch.name)
		if (typeof renamed === 'string') return renamed
		next = renamed
	}
	const people = next.speakers!.people.map((p) => {
		if (p.id !== target.id) return p
		const out: MulticamSpeaker = { ...p }
		if (patch.camera !== undefined) { if (patch.camera === null) delete out.camera; else out.camera = patch.camera }
		if (patch.framing !== undefined) { if (patch.framing === null || !patch.framing.trim()) delete out.framing; else out.framing = patch.framing.trim() }
		if (patch.color) out.color = patch.color
		return out
	})
	return withSpeakers(next, { ...next.speakers!, people })
}

/** Two voices that are one person: every turn of `from` becomes `into`'s, and `from` is gone. */
export function mergeSpeakers(group: MulticamGroup, from: string | number, into: string | number): MulticamGroup | string {
	const sp = group.speakers
	const a = resolveSpeaker(sp, from), b = resolveSpeaker(sp, into)
	if (!sp || !a) return `there is no speaker "${from}" (speakers: ${listSpeakers(sp)})`
	if (!b) return `there is no speaker "${into}" (speakers: ${listSpeakers(sp)})`
	if (a.id === b.id) return 'from and into are the same speaker'
	const turns = coalesce(sp.turns.map((t) => (t.speaker === a.id ? { ...t, speaker: b.id } : t)))
	const talk = (a.talkSec ?? 0) + (b.talkSec ?? 0)
	const people = sp.people.filter((p) => p.id !== a.id).map((p) => (p.id === b.id ? { ...p, talkSec: talk ? round2(talk) : p.talkSec } : p))
	return withSpeakers(group, { ...sp, people, turns })
}

/** Neighbouring turns of one speaker that touch or nearly touch become one. */
function coalesce(turns: SpeakerTurn[], gap = 0.5): SpeakerTurn[] {
	const out: SpeakerTurn[] = []
	for (const t of turns) {
		const prev = out[out.length - 1]
		if (prev && prev.speaker === t.speaker && !!prev.fixed === !!t.fixed && t.start - prev.end <= gap) {
			const a = prev.end - prev.start, b = t.end - t.start
			prev.confidence = round2((prev.confidence * a + t.confidence * b) / (a + b || 1))
			prev.end = Math.max(prev.end, t.end)
		} else out.push({ ...t })
	}
	return out
}

/**
 * Give [fromSec, toSec) to `speaker` (null: unsure). Turns it overlaps are cut
 * back; the stretch becomes one turn marked fixed, with confidence 1 (a person
 * decided). A re-run of the analysis keeps fixed turns.
 */
export function assignStretch(group: MulticamGroup, fromSec: number, toSec: number, ref: string | number | null): MulticamGroup | string {
	const sp = group.speakers
	if (!sp) return 'this group has no speakers yet: run the speaker analysis first'
	if (!(toSec > fromSec)) return 'toSec must be after fromSec'
	let id: string | null = null
	if (ref !== null) {
		const target = resolveSpeaker(sp, ref)
		if (!target) return `there is no speaker "${ref}" (speakers: ${listSpeakers(sp)})`
		id = target.id
	}
	const out: SpeakerTurn[] = []
	for (const t of sp.turns) {
		if (t.end <= fromSec || t.start >= toSec) { out.push(t); continue }
		if (t.start < fromSec) out.push({ ...t, end: fromSec })
		if (t.end > toSec) out.push({ ...t, start: toSec })
	}
	out.push({ start: fromSec, end: toSec, speaker: id, confidence: 1, fixed: true })
	out.sort((a, b) => a.start - b.start)
	return withSpeakers(group, { ...sp, turns: out })
}

/**
 * A fresh analysis replaces the old one, keeping what a person added: names,
 * cameras and framing carry to the new voice with the nearest pitch, and turns
 * set by hand stay where they were set.
 */
export function carryOver(previous: MulticamSpeakers | undefined, fresh: MulticamSpeakers): MulticamSpeakers {
	if (!previous) return fresh
	const taken = new Set<string>()
	const idFor = new Map<string, string>()
	const people = fresh.people.map((p) => {
		const before = previous.people
			.filter((q) => !taken.has(q.id) && (q.name !== defaultName(previous.people.indexOf(q)) || q.camera || q.framing))
			.map((q) => ({ q, d: Math.abs(Math.log2((q.pitchHz || 1) / (p.pitchHz || 1))) }))
			.filter((x) => x.d < 0.2)
			.sort((a, b) => a.d - b.d)[0]?.q
		if (!before) return p
		taken.add(before.id)
		idFor.set(before.id, p.id)
		return { ...p, name: before.name, camera: before.camera, framing: before.framing, color: before.color ?? p.color }
	})
	let result: MulticamSpeakers = { ...fresh, people }
	const group = { speakers: result } as MulticamGroup
	let g: MulticamGroup | string = group
	for (const t of previous.turns.filter((t) => t.fixed)) {
		const mapped = t.speaker === null ? null : idFor.get(t.speaker)
		if (mapped === undefined) continue
		g = assignStretch(g as MulticamGroup, t.start, t.end, mapped)
		if (typeof g === 'string') return result
	}
	result = (g as MulticamGroup).speakers!
	return result
}

export const defaultName = (index: number) => `Speaker ${index + 1}`

/** "1 Navid, 2 Somi": for messages. */
export function listSpeakers(sp: MulticamSpeakers | undefined): string {
	return sp?.people.length ? sp.people.map((p, i) => `${i + 1} ${p.name}`).join(', ') : 'none yet'
}

/** The camera a speaker is on, as a key `resolveCamera` finds (angle number, name or id). */
export function cameraKeyFor(group: MulticamGroup, media: Media, ref: string | number): string | undefined {
	return resolveCamera(camerasOf(group, media), ref)?.key
}

// ===== A summary for readers (MCP, the Inspector) =====

export function summarizeSpeakers(group: MulticamGroup, media: Media) {
	const sp = group.speakers
	if (!sp) return undefined
	const cameras = camerasOf(group, media)
	return {
		speakers: sp.people.map((p, i) => ({
			number: i + 1,
			id: p.id,
			name: p.name,
			camera: p.camera ? cameras.find((c) => c.key === p.camera)?.name ?? p.camera : undefined,
			framing: p.framing,
			talkMinutes: p.talkSec !== undefined ? round2(p.talkSec / 60) : undefined,
			pitchHz: p.pitchHz ?? undefined,
			named: p.name !== defaultName(i)
		})),
		unsureShare: sp.analysis.unsureShare,
		warnings: sp.analysis.warnings.length ? sp.analysis.warnings : undefined
	}
}
