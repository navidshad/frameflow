import { describe, expect, it } from 'vitest'
import type { AudioNotes } from '../../shared/audioNotes'
import { createNotesStore } from './notesStore'
import { createDocsCache, DOCS_MAX_AGE_MS, type SavedDoc } from './docs'

describe('the notes file', () => {
	it('saves an agent’s findings to disk once for every project, and the person can delete a note or a pick', () => {
		let disk: unknown = null
		const store = createNotesStore({ load: () => disk, save: (n) => { disk = JSON.parse(JSON.stringify(n)) }, now: () => 7 })
		const known = () => true
		const r = store.save({
			notes: [{ capability: 'speech', model: 'eleven_v4', note: 'Most natural for narration.', source: 'tried' }],
			pick: { capability: 'speech', model: 'eleven_v4', why: 'Best for final voice-over.' }
		}, 'The assistant', 'elevenlabs', known)
		expect(r).toEqual({ saved: 2, problems: [] })
		expect((disk as AudioNotes).picks[0]).toMatchObject({ model: 'eleven_v4', by: 'The assistant', at: 7 })

		// Another project, another store over the same file: it starts from the same notes.
		const other = createNotesStore({ load: () => disk, save: (n) => { disk = n } })
		expect(other.get().notes).toHaveLength(1)

		other.remove({ kind: 'note', provider: 'elevenlabs', capability: 'speech', model: 'eleven_v4', source: 'tried' })
		other.remove({ kind: 'pick', provider: 'elevenlabs', capability: 'speech' })
		expect(disk).toEqual({ notes: [], picks: [] })
	})

	it('writes nothing when nothing could be saved', () => {
		let writes = 0
		const store = createNotesStore({ load: () => null, save: () => { writes++ } })
		const r = store.save({ notes: [{ capability: 'speech', model: 'nope', note: 'A finding about nothing.' }] }, 'x', 'elevenlabs', () => false)
		expect(r.saved).toBe(0)
		expect(writes).toBe(0)
	})

	it('reads a broken file as no notes', () => {
		const store = createNotesStore({ load: () => { throw new SyntaxError('bad json') }, save: () => {} })
		expect(store.get()).toEqual({ notes: [], picks: [] })
	})
})

describe('the docs cache', () => {
	const URL = 'https://vendor.example/models.md'
	function setup(reply: () => Response, saved: SavedDoc | null = null) {
		let asked = 0
		let clock = 1_000_000
		const disk = { saved }
		const cache = createDocsCache({
			fetch: (async () => { asked++; return reply() }) as unknown as typeof fetch,
			load: () => disk.saved, save: (d) => { disk.saved = d }, now: () => clock
		})
		return { cache, disk, asked: () => asked, advance: (ms: number) => { clock += ms } }
	}

	it('asks for the page at most once a day, from disk in between', async () => {
		const t = setup(() => new Response('# Models v2'), { url: URL, fetchedAt: 1_000_000 - 1000, text: '# Models v1' })
		expect((await t.cache.get(URL))!.text).toBe('# Models v1')
		expect(t.asked()).toBe(0)
		t.advance(DOCS_MAX_AGE_MS)
		expect((await t.cache.get(URL))!.text).toBe('# Models v2')
		expect(t.disk.saved!.text).toBe('# Models v2')
		expect(t.asked()).toBe(1)
	})

	it('keeps the copy it had when the page cannot be read, and has none when it never could', async () => {
		const old = { url: URL, fetchedAt: 0, text: '# Old' }
		expect((await setup(() => new Response('busy', { status: 503 }), old).cache.get(URL))!.text).toBe('# Old')
		expect(await setup(() => new Response('', { status: 200 })).cache.get(URL)).toBeNull()
	})
})
