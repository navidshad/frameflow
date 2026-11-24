import {
	EMPTY_NOTES, mergeNotes, normalizeNotes, type AudioNotes, type NotesInput
} from '../../shared/audioNotes'
import type { AudioCapability, ProviderId } from '../../shared/audioProviders'

/**
 * The agents' notes about models, on disk once for the whole app (every
 * project reads the same file), with the person able to delete any of them.
 * Load and save are injected, so it is tested with an in-memory file.
 */

export interface NotesStoreDeps {
	load(): unknown
	save(notes: AudioNotes): void
	now?: () => number
}

export interface NotesStore {
	get(): AudioNotes
	/** An agent's findings. `known` says whether a model is in today's list. */
	save(input: NotesInput, by: string, provider: ProviderId, known: (capability: AudioCapability, model: string) => boolean): { saved: number; problems: string[] }
	/** The person deleting a note (by its model, kind and source) or a pick (by its kind). */
	remove(target: { kind: 'note'; provider: ProviderId; capability: AudioCapability; model: string; source: string } | { kind: 'pick'; provider: ProviderId; capability: AudioCapability }): AudioNotes
}

export function createNotesStore(deps: NotesStoreDeps): NotesStore {
	const now = deps.now ?? Date.now
	let current: AudioNotes | null = null
	const read = (): AudioNotes => {
		if (!current) {
			try { current = normalizeNotes(deps.load()) } catch { current = { ...EMPTY_NOTES } }
		}
		return current
	}
	const write = (next: AudioNotes) => {
		current = next
		try { deps.save(next) } catch (error) { console.warn('[audio] could not save the model notes:', (error as Error).message) }
	}

	return {
		get: read,

		save(input, by, provider, known) {
			const merged = mergeNotes(read(), input, by, provider, now(), known)
			if (merged.saved) write(merged.notes)
			return { saved: merged.saved, problems: merged.problems }
		},

		remove(target) {
			const n = read()
			const next: AudioNotes = target.kind === 'pick'
				? { ...n, picks: n.picks.filter((p) => !(p.provider === target.provider && p.capability === target.capability)) }
				: {
					...n,
					notes: n.notes.filter((x) => !(x.provider === target.provider && x.capability === target.capability &&
						x.model === target.model && x.source === target.source))
				}
			write(next)
			return next
		}
	}
}
