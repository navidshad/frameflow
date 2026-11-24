import { describe, expect, it } from 'vitest'
import type { ModelCatalog } from '../../shared/audioModels'
import { CATALOG_GAP_RETRY_MS, CATALOG_MAX_AGE_MS, createCatalogStore, type FetchCatalog } from './catalog'

const HOUR = 60 * 60 * 1000
const list = (ids: string[], at: number, extra: Partial<ModelCatalog> = {}): ModelCatalog => ({
	provider: 'elevenlabs', fetchedAt: at,
	models: ids.map((id) => ({ id, provider: 'elevenlabs', capability: 'music', label: id })), ...extra
})

/** A store over an in-memory disk and a clock the test moves. */
function setup(fetchCatalog: FetchCatalog, saved: ModelCatalog | null = null) {
	const disk = { saved, writes: 0 }
	let clock = 10 * HOUR
	const store = createCatalogStore({
		provider: 'elevenlabs', fetchCatalog,
		load: () => disk.saved,
		save: (c) => { disk.saved = c; disk.writes++ },
		now: () => clock
	})
	return { store, disk, advance: (ms: number) => { clock += ms }, now: () => clock }
}

describe('the model list store', () => {
	it('starts from what was saved, and asks the provider only when that is a day old', async () => {
		let asked = 0
		const { store, advance, now } = setup(async () => { asked++; return list(['music_v3'], now()) }, list(['music_v2'], 10 * HOUR))
		expect(store.current()!.models[0].id).toBe('music_v2')
		await store.ensure()
		expect(asked).toBe(0)
		advance(CATALOG_MAX_AGE_MS - 1)
		await store.ensure()
		expect(asked).toBe(0)
		advance(2)
		expect((await store.ensure())!.models[0].id).toBe('music_v3')
		expect(asked).toBe(1)
	})

	it('asks at once when told to', async () => {
		let asked = 0
		const { store, now } = setup(async () => { asked++; return list(['music_v2'], now()) }, list(['music_v2'], 10 * HOUR))
		await store.ensure(true)
		expect(asked).toBe(1)
	})

	it('asks again sooner when part of the list was missing, but not on every use', async () => {
		let asked = 0
		const { store, advance, now } = setup(async () => { asked++; return list(['music_v2'], now(), { gaps: ['Voice models: needs a permission'] }) })
		await store.ensure()
		await store.ensure()
		expect(asked).toBe(1)
		advance(CATALOG_GAP_RETRY_MS + 1)
		await store.ensure()
		expect(asked).toBe(2)
	})

	it('shares one request between callers who ask at the same time', async () => {
		let asked = 0
		const { store, now } = setup(async () => { asked++; await new Promise((r) => setTimeout(r, 5)); return list(['music_v2'], now()) })
		const [a, b] = await Promise.all([store.ensure(), store.ensure()])
		expect(asked).toBe(1)
		expect(a).toBe(b)
	})

	it('keeps the list it had when the provider cannot be reached', async () => {
		const saved = list(['music_v2'], 1)
		const { store, disk } = setup(async () => { throw new Error('offline') }, saved)
		expect(await store.ensure()).toEqual(saved)
		expect(disk.writes).toBe(0)
	})

	it('learns what a model costs and keeps it, across refreshes and on disk', async () => {
		const { store, disk, advance, now } = setup(async () => list(['music_v2_5'], now()), list(['music_v2_5'], 10 * HOUR))
		store.learnRate('eleven_flash_v2_5', 20, 99)
		expect(store.current()!.rates!.eleven_flash_v2_5).toBeCloseTo(0.202, 3)
		expect(disk.saved!.rates!.eleven_flash_v2_5).toBeCloseTo(0.202, 3)
		advance(CATALOG_MAX_AGE_MS + 1)
		await store.ensure()
		expect(store.current()!.rates!.eleven_flash_v2_5).toBeCloseTo(0.202, 3)
	})

	it('learns nothing from a call that billed nothing measurable', () => {
		const { store } = setup(async () => list([], 0), list(['music_v2'], 1))
		store.learnRate('music_v2', 50, 0)
		store.learnRate('music_v2', Number.NaN, 5)
		expect(store.current()!.rates).toBeUndefined()
	})

	it('forgets everything for a new key, which may be another account', async () => {
		let asked = 0
		const { store, now } = setup(async () => { asked++; return list(['music_v2'], now()) }, list(['music_v2'], 10 * HOUR, { rates: { music_v2: 9 } }))
		store.reset()
		expect(store.current()).toBeNull()
		expect((await store.ensure())!.rates).toEqual({})
		expect(asked).toBe(1)
	})

	it('reads a broken file as no list rather than failing', () => {
		const store = createCatalogStore({
			provider: 'elevenlabs', fetchCatalog: async () => list([], 0),
			load: () => { throw new SyntaxError('Unexpected end of JSON input') }, save: () => {}
		})
		expect(store.current()).toBeNull()
	})
})
