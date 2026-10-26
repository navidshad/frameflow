import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { EditorRevision, EditorRevisionsFile, RevisionSnapshot } from '@shared/types'
import { BLOB_PREFIX, dehydrate, hydrate, MissingBlobError } from './blobRefs'
import { streamTopLevelArrays, JsonStreamError } from './jsonStream'
import { MAX_REVISIONS, RevisionStore } from './revisionStore'

const THREAD = 'thread-1'
let root: string

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-revisions-')) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

/** A ~40 KB motion page, distinct per `variant`. */
const page = (variant: string) => `<!doctype html><title>${variant}</title>` + `<div>${variant}</div>`.repeat(2000)

/** A snapshot with `pages` motion items; `edited` swaps one page's HTML. */
function snapshot(pages: number, edited: Record<number, string> = {}): RevisionSnapshot {
	return {
		tracks: [{ id: 'm1', kind: 'motion', name: 'M1' } as any],
		timeline: Array.from({ length: pages }, (_, i) => ({
			id: `item-${i}`, trackId: 'm1', sourceAssetId: `asset-${i}`, sourceClipId: `clip-${i}`,
			timelineStart: pages - i, in: 0, out: 3, speed: 1, preservePitch: true, duration: 3,
			motion: { html: edited[i] ?? page(`p${i}`), passed: edited[i] ?? page(`p${i}`), definition: { duration: 3 } }
		})) as any,
		timelineMeta: { duration: 30 } as any,
		markers: [{ id: 'mk', time: 1.5, label: 'beat' }]
	}
}

const revision = (id: string, parentId: string | null, snap: RevisionSnapshot, createdAt: number): EditorRevision => ({
	id, parentId, seq: 0, origin: parentId ? 'ai' : 'init', label: id, snapshot: snap, createdAt
})

const dirSize = (dir: string): number => {
	if (!fs.existsSync(dir)) return 0
	return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
		const full = path.join(dir, entry.name)
		return sum + (entry.isDirectory() ? dirSize(full) : fs.statSync(full).size)
	}, 0)
}

describe('blobRefs', () => {
	it('stores each distinct big string once and restores the value exactly', () => {
		const stored = new Map<string, string>()
		let puts = 0
		const value = { a: page('x'), b: [page('x'), 'small'], c: { d: page('y'), n: 3, z: null } }
		const dry = dehydrate(value, (h, t) => { puts++; stored.set(h, t) })
		expect(puts).toBe(2)
		expect(dry.a).toBe(dry.b[0])
		expect(dry.b[1]).toBe('small')
		expect(hydrate(dry, (h) => stored.get(h))).toEqual(value)
	})

	it('never confuses real text that looks like a reference', () => {
		const stored = new Map<string, string>()
		const sneaky = `${BLOB_PREFIX}deadbeef`
		const dry = dehydrate({ s: sneaky }, (h, t) => stored.set(h, t))
		expect(hydrate(dry, (h) => stored.get(h))).toEqual({ s: sneaky })
	})

	it('fails loudly on missing text', () => {
		const dry = dehydrate({ s: page('gone') }, () => undefined)
		expect(() => hydrate(dry, () => undefined)).toThrow(MissingBlobError)
	})
})

describe('streamTopLevelArrays', () => {
	const write = (text: string) => {
		const file = path.join(root, 'f.json')
		fs.writeFileSync(file, text)
		return file
	}

	it('yields each element of the named arrays and returns the rest, across tiny chunks', async () => {
		const data = {
			threadId: 'x', n: 5, other: [1, 2],
			revisions: [{ s: 'a "quoted" ] } [ {' }, { u: 'وکتور ✓', deep: { arr: [[1], { k: '\\' }] } }],
			keyframes: []
		}
		const items: Array<[string, unknown]> = []
		for (const highWaterMark of [1, 3, 7, 64 * 1024]) {
			items.length = 0
			const rest = await streamTopLevelArrays(write(JSON.stringify(data)), ['revisions', 'keyframes'],
				(key, json) => { items.push([key, JSON.parse(json)]) }, { highWaterMark })
			expect(rest).toEqual({ threadId: 'x', n: 5, other: [1, 2], revisions: [], keyframes: [] })
			expect(items).toEqual(data.revisions.map((r) => ['revisions', r]))
		}
	})

	it('reports a truncated file after yielding what it could read', async () => {
		const text = JSON.stringify({ revisions: [{ a: 1 }, { b: 2 }, { c: 3 }] })
		const seen: unknown[] = []
		await expect(streamTopLevelArrays(write(text.slice(0, text.indexOf('{"c"') + 3)), ['revisions'],
			(_k, json) => { seen.push(JSON.parse(json)) })).rejects.toThrow(JsonStreamError)
		expect(seen).toEqual([{ a: 1 }, { b: 2 }])
	})

	it('refuses an element over the size cap', async () => {
		await expect(streamTopLevelArrays(write(JSON.stringify({ revisions: [{ s: 'x'.repeat(5000) }] })), ['revisions'],
			() => undefined, { maxItemBytes: 1000 })).rejects.toThrow(/too large/)
	})
})

describe('RevisionStore', () => {
	it('grows by one page per page edit, not by project size', async () => {
		const store = new RevisionStore(root)
		const base = snapshot(28)
		await store.push(THREAD, revision('r0', null, base, 1))
		const afterFirst = dirSize(path.join(root, THREAD))

		let parent = 'r0'
		for (let i = 1; i <= 20; i++) {
			const snap = snapshot(28, { [i % 28]: page(`edit-${i}`) })
			await store.push(THREAD, revision(`r${i}`, parent, snap, 1 + i))
			parent = `r${i}`
		}
		const total = dirSize(path.join(root, THREAD))
		const naive = JSON.stringify(base).length * 21
		// 28 pages ≈ 1.1 MB per full snapshot; 20 edits must cost ~20 pages, not 20 snapshots.
		expect(total - afterFirst).toBeLessThan(21 * 60_000)
		expect(total).toBeLessThan(naive / 10)
	})

	it('replaces a revision in place: same id and seq, new snapshot, old text collected', async () => {
		const store = new RevisionStore(root)
		await store.push(THREAD, revision('a', null, snapshot(3), 1))
		await store.push(THREAD, revision('b', 'a', snapshot(3, { 1: page('first') }), 2))
		const before = fs.readdirSync(path.join(root, THREAD, 'blobs')).length

		const res = await store.replace(THREAD, { ...revision('b', 'a', snapshot(3, { 1: page('second') }), 99), label: 'round' })
		expect(res.seq).toBe(2)

		const index = await store.loadIndex(THREAD)
		expect(index.revisions.map((r) => [r.id, r.seq, r.parentId, r.label, r.createdAt])).toEqual([['a', 1, null, 'a', 1], ['b', 2, 'a', 'round', 2]])
		const restored = await store.getSnapshot(THREAD, 'b')
		expect(restored?.timeline[1].motion?.html).toBe(page('second'))
		// The first edit's page is no revision's any more: its text is gone, the new one took its place.
		expect(fs.readdirSync(path.join(root, THREAD, 'blobs')).length).toBe(before)
		expect(index.revisions).toHaveLength(2)
	})

	it('replace of an unknown id appends it, so a save is never lost', async () => {
		const store = new RevisionStore(root)
		await store.push(THREAD, revision('a', null, snapshot(2), 1))
		const res = await store.replace(THREAD, revision('z', 'a', snapshot(2), 5))
		expect(res.seq).toBe(2)
		expect((await store.loadIndex(THREAD)).revisions.map((r) => r.id)).toEqual(['a', 'z'])
	})

	it('lists summaries without snapshots and restores any snapshot exactly', async () => {
		const store = new RevisionStore(root)
		const snaps = [snapshot(5), snapshot(5, { 2: page('two') }), snapshot(3)]
		await store.push(THREAD, revision('a', null, snaps[0], 1))
		await store.push(THREAD, revision('b', 'a', snaps[1], 2))
		const res = await store.push(THREAD, revision('c', 'b', snaps[2], 3))
		expect(res.seq).toBe(3)

		const index = await store.loadIndex(THREAD)
		expect(index.revisions.map((r) => [r.id, r.seq, r.itemCount])).toEqual([['a', 1, 5], ['b', 2, 5], ['c', 3, 3]])
		expect(index.revisions[0]).not.toHaveProperty('snapshot')
		expect(index.revisions[0]).not.toHaveProperty('blobRefs')
		expect(index.revisions[0].firstClips[0]).toEqual({ sourceAssetId: 'asset-4', sourceClipId: 'clip-4' })
		expect(JSON.stringify(index).length).toBeLessThan(5000)

		for (const [i, id] of ['a', 'b', 'c'].entries()) {
			expect(await new RevisionStore(root).getSnapshot(THREAD, id)).toEqual(snaps[i])
		}
		expect(await store.getSnapshot(THREAD, 'nope')).toBeNull()
	})

	it('frees the text of deleted and pruned revisions only when nothing else uses it', async () => {
		const store = new RevisionStore(root)
		await store.push(THREAD, revision('a', null, snapshot(2), 1))
		await store.push(THREAD, revision('b', 'a', snapshot(2, { 0: page('only-b') }), 2))
		const blobs = () => fs.readdirSync(path.join(root, THREAD, 'blobs')).length
		expect(blobs()).toBe(3)
		await store.delete(THREAD, ['b', 'a'])
		expect(blobs()).toBe(2) // root survives; only b's own page goes
		expect((await store.loadIndex(THREAD)).revisions.map((r) => r.id)).toEqual(['a'])
		expect(fs.existsSync(path.join(root, THREAD, 'snapshots', 'b.json'))).toBe(false)
	})

	it('caps at MAX_REVISIONS and reports what it pruned', async () => {
		const store = new RevisionStore(root)
		await store.push(THREAD, revision('root', null, snapshot(1), 0))
		let pruned: string[] = []
		for (let i = 1; i <= MAX_REVISIONS + 1; i++) {
			const res = await store.push(THREAD, revision(`leaf${i}`, 'root', snapshot(1, { 0: page(`v${i}`) }), i))
			pruned = pruned.concat(res.prunedIds)
		}
		expect(pruned).toEqual(['leaf1', 'leaf2'])
		const index = await store.loadIndex(THREAD)
		expect(index.revisions).toHaveLength(MAX_REVISIONS)
		expect(index.revisionCounter).toBe(MAX_REVISIONS + 2)
		expect(fs.readdirSync(path.join(root, THREAD, 'blobs'))).toHaveLength(MAX_REVISIONS) // root's page + 99 leaves
	})

	it('rebuilds a damaged index from the snapshot files and says so', async () => {
		const store = new RevisionStore(root)
		await store.push(THREAD, revision('a', null, snapshot(2), 1))
		await store.push(THREAD, revision('b', 'a', snapshot(2, { 1: page('b') }), 2))
		fs.writeFileSync(path.join(root, THREAD, 'index.json'), '{"schemaVersion":2,"revis')
		const fresh = new RevisionStore(root)
		const index = await fresh.loadIndex(THREAD)
		expect(index.revisions.map((r) => r.id)).toEqual(['a', 'b'])
		expect(index.revisionCounter).toBe(2)
		expect(index.problem).toMatch(/rebuilt/)
		expect((await fresh.loadIndex(THREAD)).problem).toBeUndefined() // reported once
		expect((await fresh.push(THREAD, revision('c', 'b', snapshot(1), 3))).seq).toBe(3)
	})

	it('returns null, not a half snapshot, when stored text is missing', async () => {
		const store = new RevisionStore(root)
		await store.push(THREAD, revision('a', null, snapshot(2), 1))
		for (const name of fs.readdirSync(path.join(root, THREAD, 'blobs'))) fs.rmSync(path.join(root, THREAD, 'blobs', name))
		expect(await store.getSnapshot(THREAD, 'a')).toBeNull()
		expect((await store.loadIndex(THREAD)).revisions).toHaveLength(1)
	})
})

describe('RevisionStore migration from schema 1', () => {
	const legacyPath = () => path.join(root, `${THREAD}.json`)
	const legacyRevisions = (): EditorRevision[] => {
		const out: EditorRevision[] = []
		let parent: string | null = null
		for (let i = 1; i <= 12; i++) {
			const id = `v${i}`
			out.push({ ...revision(id, parent, snapshot(6, { [i % 6]: page(`m${i}`) }), 1000 + i), seq: i })
			parent = id
		}
		return out
	}
	const writeLegacy = (text: string) => fs.writeFileSync(legacyPath(), text)

	it('converts every revision, keeps V numbers, and removes the old file', async () => {
		const revisions = legacyRevisions()
		const legacy: EditorRevisionsFile = { threadId: THREAD, schemaVersion: 1, revisionCounter: 15, revisions }
		writeLegacy(JSON.stringify(legacy))
		const legacySize = fs.statSync(legacyPath()).size

		const store = new RevisionStore(root)
		const index = await store.loadIndex(THREAD)
		expect(index.problem).toBeUndefined()
		expect(index.revisionCounter).toBe(15)
		expect(index.revisions.map((r) => [r.id, r.seq, r.parentId])).toEqual(revisions.map((r) => [r.id, r.seq, r.parentId]))
		expect(fs.existsSync(legacyPath())).toBe(false)
		expect(dirSize(path.join(root, THREAD))).toBeLessThan(legacySize / 4)

		for (const rev of revisions) expect(await store.getSnapshot(THREAD, rev.id)).toEqual(rev.snapshot)
		expect((await store.push(THREAD, revision('next', 'v12', snapshot(1), 2000))).seq).toBe(16)
	})

	it('keeps what it could read from a truncated file and sets the file aside', async () => {
		const revisions = legacyRevisions()
		const text = JSON.stringify({ threadId: THREAD, schemaVersion: 1, revisionCounter: 12, revisions })
		writeLegacy(text.slice(0, Math.floor(text.length * 0.6)))

		const index = await new RevisionStore(root).loadIndex(THREAD)
		expect(index.revisions.length).toBeGreaterThan(3)
		expect(index.revisions.length).toBeLessThan(12)
		expect(index.revisions.map((r) => r.id)).toEqual(revisions.slice(0, index.revisions.length).map((r) => r.id))
		expect(index.problem).toMatch(/could not all be read/)
		expect(fs.existsSync(legacyPath())).toBe(false)
		expect(fs.readdirSync(root).some((n) => n.startsWith(`${THREAD}.json.unreadable-`))).toBe(true)
	})

	it('opens with no revisions when the old file is garbage', async () => {
		writeLegacy('not json at all')
		const index = await new RevisionStore(root).loadIndex(THREAD)
		expect(index.revisions).toEqual([])
		expect(index.problem).toBeTruthy()
	})

	it('serialises a push that arrives while the migration is running', async () => {
		writeLegacy(JSON.stringify({ threadId: THREAD, schemaVersion: 1, revisionCounter: 12, revisions: legacyRevisions() }))
		const store = new RevisionStore(root)
		const [index, pushed] = await Promise.all([
			store.loadIndex(THREAD),
			store.push(THREAD, revision('late', 'v12', snapshot(1), 5000))
		])
		expect(index.revisions).toHaveLength(12)
		expect(pushed.seq).toBe(13)
		expect((await store.loadIndex(THREAD)).revisions).toHaveLength(13)
	})
})
