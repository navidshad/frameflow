import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expandMediaPaths, type WalkFs } from './expandMedia'

/** A tree as nested objects: a string is a file, an object is a folder. */
type Tree = { [name: string]: string | Tree }

function fakeFs(tree: Tree, links: Record<string, string> = {}): WalkFs {
	const find = (p: string): string | Tree | undefined => {
		let node: string | Tree | undefined = tree
		for (const part of p.split('/').filter(Boolean)) {
			if (typeof node !== 'object') return undefined
			node = node[part]
		}
		return node
	}
	const resolve = (p: string) => links[p] ?? p
	return {
		async kindOf(p) {
			const n = find(resolve(p))
			return n === undefined ? 'missing' : typeof n === 'string' ? 'file' : 'dir'
		},
		async list(p) {
			const n = find(resolve(p))
			if (typeof n !== 'object') throw new Error('EACCES')
			return Object.entries(n).map(([name, v]) => ({ name, isDirectory: typeof v === 'object' }))
		},
		async identity(p) { return resolve(p) }
	}
}

describe('expandMediaPaths', () => {
	const shoot: Tree = {
		shoot: {
			'C0010.mp4': '', 'C0002.mp4': '', 'C0001.mp4': '',
			'notes.txt': '', 'cover.jpg': '', '.DS_Store': '', '._C0001.mp4': '',
			sound: { 'room.wav': '', 'readme.md': '' },
			'b-roll': { 'a.mov': '', deep: { 'x.mkv': '' } }
		}
	}

	it('walks a folder: media in, everything else counted as skipped', async () => {
		const r = await expandMediaPaths(['/shoot'], fakeFs(shoot))
		expect(r.files.map((f) => f.replace('/shoot/', ''))).toEqual([
			'C0001.mp4', 'C0002.mp4', 'C0010.mp4', // own files, natural order
			'b-roll/a.mov', 'b-roll/deep/x.mkv',   // then subfolders, depth first
			'sound/room.wav'
		])
		expect(r.skipped.map((s) => [path.basename(s.path), s.reason]).sort()).toEqual([
			['._C0001.mp4', 'hidden'], ['.DS_Store', 'hidden'],
			['cover.jpg', 'unsupported'], ['notes.txt', 'unsupported'], ['readme.md', 'unsupported']
		].sort())
		expect(r.truncated).toBe(false)
	})

	it('keeps the order of files named one by one, ahead of nothing it was not given', async () => {
		const r = await expandMediaPaths(['/shoot/C0010.mp4', '/shoot/C0001.mp4'], fakeFs(shoot))
		expect(r.files).toEqual(['/shoot/C0010.mp4', '/shoot/C0001.mp4'])
	})

	it('handles a mixed selection and imports a file once when a folder also holds it', async () => {
		const r = await expandMediaPaths(['/shoot/sound/room.wav', '/shoot/b-roll', '/shoot/sound'], fakeFs(shoot))
		expect(r.files).toEqual(['/shoot/sound/room.wav', '/shoot/b-roll/a.mov', '/shoot/b-roll/deep/x.mkv'])
	})

	it('skips a named file that is not media without failing the rest', async () => {
		const r = await expandMediaPaths(['/shoot/notes.txt', '/shoot/C0001.mp4'], fakeFs(shoot))
		expect(r.files).toEqual(['/shoot/C0001.mp4'])
		expect(r.skipped).toEqual([{ path: '/shoot/notes.txt', reason: 'unsupported' }])
	})

	it('reports a path that is gone and carries on', async () => {
		const r = await expandMediaPaths(['/nope.mp4', '/shoot/C0001.mp4'], fakeFs(shoot))
		expect(r.files).toEqual(['/shoot/C0001.mp4'])
		expect(r.skipped).toEqual([{ path: '/nope.mp4', reason: 'missing' }])
	})

	it('reports a folder it cannot read and carries on', async () => {
		const base = fakeFs(shoot)
		const walkFs: WalkFs = { ...base, async list(p) { if (p.endsWith('sound')) throw new Error('EACCES'); return base.list(p) } }
		const r = await expandMediaPaths(['/shoot'], walkFs)
		expect(r.skipped).toContainEqual({ path: '/shoot/sound', reason: 'unreadable' })
		expect(r.files).toContain('/shoot/b-roll/a.mov')
		expect(r.files).not.toContain('/shoot/sound/room.wav')
	})

	it('does not loop on a link back up the tree', async () => {
		const tree: Tree = { loop: { 'a.mp4': '', back: {} } }
		const r = await expandMediaPaths(['/loop'], fakeFs(tree, { '/loop/back': '/loop' }))
		expect(r.files).toEqual(['/loop/a.mp4'])
	})

	it('stops at the limit and says so', async () => {
		const many: Tree = { f: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`c${i}.mp4`, ''])) }
		const r = await expandMediaPaths(['/f'], fakeFs(many), { maxFiles: 4 })
		expect(r.files).toHaveLength(4)
		expect(r.truncated).toBe(true)
	})

	it('does not descend past the depth limit', async () => {
		const tree: Tree = { a: { b: { c: { 'deep.mp4': '' }, 'ok.mp4': '' } } }
		const r = await expandMediaPaths(['/a'], fakeFs(tree), { maxDepth: 1 })
		expect(r.files).toEqual(['/a/b/ok.mp4'])
		expect(r.skipped).toContainEqual({ path: '/a/b/c', reason: 'unreadable' })
	})

	it('an empty selection is an empty result', async () => {
		expect(await expandMediaPaths([], fakeFs(shoot))).toEqual({ files: [], skipped: [], truncated: false })
	})
})

describe('expandMediaPaths on a real folder', () => {
	let root: string
	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-expand-'))
		fs.mkdirSync(path.join(root, 'sub'))
		for (const f of ['b.mp4', 'a.mp4', 'sub/c.wav', 'sub/d.txt', '.hidden.mp4']) fs.writeFileSync(path.join(root, f), '')
		// A link to the folder itself: the walk must not follow it forever.
		fs.symlinkSync(root, path.join(root, 'sub', 'self'))
		// A link to nothing: nothing to import, and no failure.
		fs.symlinkSync(path.join(root, 'missing.mp4'), path.join(root, 'dangling.mp4'))
	})
	afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

	it('finds the media, survives the loop and the dangling link', async () => {
		const r = await expandMediaPaths([root])
		expect(r.files.map((f) => path.relative(root, f))).toEqual(['a.mp4', 'b.mp4', path.join('sub', 'c.wav')])
		expect(r.skipped.map((s) => path.basename(s.path)).sort()).toEqual(['.hidden.mp4', 'd.txt'])
	})
})
