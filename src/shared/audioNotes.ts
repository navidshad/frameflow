import type { AudioCapability, ProviderId } from './audioProviders'
import { isCapability } from './audioProviders'

/**
 * What agents have learned about the provider's models, kept for every project.
 *
 * FrameFlow has no opinion of its own about which model is best: models change
 * too often for one written here to stay right. An agent researches them (the
 * provider's own list and docs, and what FrameFlow measured), decides, and
 * writes down what it found and which model it picks for each kind, with why.
 * The next project, and the next agent, start from those notes instead of from
 * nothing; "Auto" uses the pick. The person can read and delete every note in
 * Settings → Audio.
 *
 * Pure: the shapes, the checks, and how a save is merged. Main keeps the file.
 */

/** Where a note came from: the provider's docs, something an agent made and measured, or the person. */
export type NoteSource = 'docs' | 'tried' | 'person'

export interface ModelNote {
	provider: ProviderId
	capability: AudioCapability
	model: string
	/** What was found, in a few sentences: what it is good at, where it falls short. */
	text: string
	source: NoteSource
	/** "The assistant", "Claude Code". */
	by: string
	at: number
}

/** The model an agent chose for a kind, and why. Auto uses it. */
export interface ModelPick {
	provider: ProviderId
	capability: AudioCapability
	model: string
	why: string
	by: string
	at: number
}

export interface AudioNotes {
	notes: ModelNote[]
	picks: ModelPick[]
}

export const EMPTY_NOTES: AudioNotes = { notes: [], picks: [] }

/** Long enough for a finding, short enough that a dozen still read at a glance. */
export const NOTE_MAX_CHARS = 600
export const WHY_MAX_CHARS = 300
/** The oldest go first past this many. */
export const MAX_NOTES = 200

const isSource = (v: unknown): v is NoteSource => v === 'docs' || v === 'tried' || v === 'person'
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
const sameModel = (a: { provider: string; capability: string; model: string }, b: typeof a) =>
	a.provider === b.provider && a.capability === b.capability && a.model === b.model

/** Whatever the file holds, as notes: anything broken is left out rather than failing. */
export function normalizeNotes(value: unknown): AudioNotes {
	const v = (value && typeof value === 'object' ? value : {}) as Partial<AudioNotes>
	const ok = (x: any) => x && typeof x.provider === 'string' && isCapability(x.capability) && typeof x.model === 'string' && typeof x.at === 'number'
	const notes = (Array.isArray(v.notes) ? v.notes : [])
		.filter((n: any) => ok(n) && typeof n.text === 'string' && isSource(n.source))
		.map((n: any) => ({ ...n, by: typeof n.by === 'string' ? n.by : 'An agent' })) as ModelNote[]
	const picks = (Array.isArray(v.picks) ? v.picks : [])
		.filter((p: any) => ok(p) && typeof p.why === 'string')
		.map((p: any) => ({ ...p, by: typeof p.by === 'string' ? p.by : 'An agent' })) as ModelPick[]
	return { notes, picks }
}

/** What an agent sends to save. */
export interface NotesInput {
	notes?: { capability: unknown; model: unknown; note: unknown; source?: unknown }[]
	pick?: { capability: unknown; model: unknown; why: unknown }
}

/**
 * Merge an agent's findings into what is kept. A model's note from the same
 * source is replaced (the newer finding wins), other sources stay beside it;
 * a pick replaces the pick for that kind. `known` says whether a model exists
 * today, so a typo is refused instead of kept.
 */
export function mergeNotes(
	current: AudioNotes, input: NotesInput, by: string, provider: ProviderId, now: number,
	known: (capability: AudioCapability, model: string) => boolean
): { notes: AudioNotes; saved: number; problems: string[] } {
	const problems: string[] = []
	let notes = [...current.notes]
	let picks = [...current.picks]
	let saved = 0

	for (const [i, raw] of (input.notes ?? []).entries()) {
		const model = typeof raw.model === 'string' ? raw.model.trim() : ''
		const text = typeof raw.note === 'string' ? raw.note.trim() : ''
		if (!isCapability(raw.capability)) { problems.push(`notes[${i}]: capability must be speech, sfx or music.`); continue }
		if (!model || !known(raw.capability, model)) { problems.push(`notes[${i}]: no ${raw.capability} model "${model}" in today's list.`); continue }
		if (text.length < 10) { problems.push(`notes[${i}]: say what you found, in a sentence or more.`); continue }
		const note: ModelNote = {
			provider, capability: raw.capability, model, text: clip(text, NOTE_MAX_CHARS),
			source: isSource(raw.source) ? raw.source : 'docs', by, at: now
		}
		notes = [...notes.filter((n) => !(sameModel(n, note) && n.source === note.source)), note]
		saved++
	}

	if (input.pick) {
		const { capability } = input.pick
		const model = typeof input.pick.model === 'string' ? input.pick.model.trim() : ''
		const why = typeof input.pick.why === 'string' ? input.pick.why.trim() : ''
		if (!isCapability(capability)) problems.push('pick: capability must be speech, sfx or music.')
		else if (!model || !known(capability, model)) problems.push(`pick: no ${capability} model "${model}" in today's list.`)
		else if (why.length < 10) problems.push('pick: say why, in a sentence.')
		else {
			picks = [...picks.filter((p) => !(p.provider === provider && p.capability === capability)),
				{ provider, capability, model, why: clip(why, WHY_MAX_CHARS), by, at: now }]
			saved++
		}
	}

	// The oldest notes go first when there are too many.
	if (notes.length > MAX_NOTES) notes = [...notes].sort((a, b) => a.at - b.at).slice(notes.length - MAX_NOTES)
	return { notes: { notes, picks }, saved, problems }
}

/** The kept pick for a kind, when there is one. */
export const pickFor = (n: AudioNotes, provider: ProviderId, capability: AudioCapability): ModelPick | undefined =>
	n.picks.find((p) => p.provider === provider && p.capability === capability)

/** Notes about one model, newest first. */
export const notesFor = (n: AudioNotes, provider: ProviderId, capability: AudioCapability, model: string): ModelNote[] =>
	n.notes.filter((x) => x.provider === provider && x.capability === capability && x.model === model).sort((a, b) => b.at - a.at)
