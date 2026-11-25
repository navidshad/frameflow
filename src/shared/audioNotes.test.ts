import { describe, expect, it } from 'vitest'
import { EMPTY_NOTES, MAX_NOTES, mergeNotes, normalizeNotes, notesFor, pickFor, type AudioNotes } from './audioNotes'
import { chooseModel, parseSpecModels, type ModelCatalog } from './audioModels'
import spec from './__fixtures__/elevenlabs-openapi-slice.json'

const KNOWN = new Set(['speech:eleven_v4', 'speech:eleven_flash_v2_5', 'music:music_v2_5', 'music:music_v1'])
const known = (capability: string, model: string) => KNOWN.has(`${capability}:${model}`)
const save = (current: AudioNotes, input: Parameters<typeof mergeNotes>[1], at = 100) =>
	mergeNotes(current, input, 'The assistant', 'elevenlabs', at, known)

describe('saving what an agent found', () => {
	it('keeps a note per model and source, and the newer finding from the same source wins', () => {
		let n = save(EMPTY_NOTES, { notes: [{ capability: 'speech', model: 'eleven_v4', note: 'Most natural with cloned voices.', source: 'docs' }] }).notes
		n = save(n, { notes: [{ capability: 'speech', model: 'eleven_v4', note: 'Sounded clearer than Flash on a Persian line.', source: 'tried' }] }, 200).notes
		n = save(n, { notes: [{ capability: 'speech', model: 'eleven_v4', note: 'The docs now say 100k characters a request.', source: 'docs' }] }, 300).notes
		const v4 = notesFor(n, 'elevenlabs', 'speech', 'eleven_v4')
		expect(v4.map((x) => [x.source, x.text])).toEqual([
			['docs', 'The docs now say 100k characters a request.'],
			['tried', 'Sounded clearer than Flash on a Persian line.']
		])
		expect(v4[0]).toMatchObject({ by: 'The assistant', at: 300, provider: 'elevenlabs' })
	})

	it('keeps one pick per kind, the latest', () => {
		let n = save(EMPTY_NOTES, { pick: { capability: 'speech', model: 'eleven_flash_v2_5', why: 'Cheapest for draft voice-overs.' } }).notes
		n = save(n, { pick: { capability: 'speech', model: 'eleven_v4', why: 'Most natural for final narration.' } }, 200).notes
		expect(n.picks).toHaveLength(1)
		expect(pickFor(n, 'elevenlabs', 'speech')).toMatchObject({ model: 'eleven_v4', why: 'Most natural for final narration.' })
		expect(pickFor(n, 'elevenlabs', 'music')).toBeUndefined()
	})

	it('refuses a model not in today’s list, an empty finding and a pick with no reason, and keeps the rest', () => {
		const r = save(EMPTY_NOTES, {
			notes: [
				{ capability: 'speech', model: 'eleven_v9', note: 'Does not exist yet.' },
				{ capability: 'speech', model: 'eleven_v4', note: 'ok' },
				{ capability: 'jingle', model: 'x', note: 'Not a kind at all.' },
				{ capability: 'music', model: 'music_v2_5', note: 'Follows the prompt closely.' }
			],
			pick: { capability: 'music', model: 'music_v2_5', why: 'yes' }
		})
		expect(r.saved).toBe(1)
		expect(r.problems).toEqual([
			'notes[0]: no speech model "eleven_v9" in today\'s list.',
			'notes[1]: say what you found, in a sentence or more.',
			'notes[2]: capability must be speech, sfx or music.',
			'pick: say why, in a sentence.'
		])
	})

	it('allows a retiring model, which is still in today’s list', () => {
		expect(save(EMPTY_NOTES, { notes: [{ capability: 'music', model: 'music_v1', note: 'Retiring on 2027-01-31; avoid for new work.' }] }).saved).toBe(1)
	})

	it('shortens a long note, and drops the oldest past the limit', () => {
		const long = save(EMPTY_NOTES, { notes: [{ capability: 'speech', model: 'eleven_v4', note: 'x'.repeat(2000) }] }).notes
		expect(long.notes[0].text.length).toBeLessThanOrEqual(600)
		const many: AudioNotes = {
			picks: [],
			notes: Array.from({ length: MAX_NOTES }, (_, i) => ({ provider: 'elevenlabs', capability: 'speech', model: `m${i}`, text: 'a finding', source: 'docs', by: 'x', at: i }))
		}
		const after = save(many, { notes: [{ capability: 'speech', model: 'eleven_v4', note: 'The newest finding.' }] }, 10_000).notes
		expect(after.notes).toHaveLength(MAX_NOTES)
		expect(after.notes.some((x) => x.model === 'm0')).toBe(false)
		expect(after.notes.some((x) => x.model === 'eleven_v4')).toBe(true)
	})
})

describe('reading the file', () => {
	it('keeps what is well formed and leaves the rest out', () => {
		const n = normalizeNotes({
			notes: [
				{ provider: 'elevenlabs', capability: 'speech', model: 'eleven_v4', text: 'Fine.', source: 'docs', at: 1 },
				{ provider: 'elevenlabs', capability: 'speech', model: 'eleven_v4', text: 'Bad source.', source: 'rumour', at: 1 },
				'junk'
			],
			picks: [{ provider: 'elevenlabs', capability: 'music', model: 'music_v2_5', why: 'Newest.', at: 2, by: 'Claude Code' }]
		})
		expect(n.notes).toHaveLength(1)
		expect(n.notes[0].by).toBe('An agent')
		expect(n.picks[0].by).toBe('Claude Code')
		expect(normalizeNotes(null)).toEqual(EMPTY_NOTES)
	})
})

describe('Auto, from the saved pick', () => {
	const catalog = (picks?: ModelCatalog['picks']): ModelCatalog => ({ provider: 'elevenlabs', fetchedAt: 1, models: parseSpecModels(spec), picks })

	it('uses the pick an agent saved', () => {
		expect(chooseModel(catalog({ music: 'music_v2' }), { capability: 'music', prompt: 'calm' })!.id).toBe('music_v2')
	})

	it('does not use a pick the provider has since retired or dropped, and takes its newest current model instead', () => {
		expect(chooseModel(catalog({ music: 'music_v1' }), { capability: 'music', prompt: 'calm' })!.id).toBe('music_v2_5')
		expect(chooseModel(catalog({ music: 'music_v0' }), { capability: 'music', prompt: 'calm' })!.id).toBe('music_v2_5')
	})

	it('takes the provider’s newest current model before anyone has researched', () => {
		expect(chooseModel(catalog(), { capability: 'sfx', prompt: 'a door' })!.id).toBe('eleven_text_to_sound_v3')
	})
})
