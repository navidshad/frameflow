import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BACKUP_DIR_NAME, importStrayProjects, pinnedUserDataDir } from './userDataPin'

let root: string
let stray: string
let pinned: string
const write = (...p: string[]) => {
	const [content, ...rest] = [p[p.length - 1], ...p.slice(0, -1)]
	const file = path.join(...rest)
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, content)
}
const age = (file: string, secondsAgo: number) => {
	const t = new Date(Date.now() - secondsAgo * 1000)
	fs.utimesSync(file, t, t)
}
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8')

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-pin-'))
	stray = path.join(root, 'Electron')
	pinned = pinnedUserDataDir(root)
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('one data folder for every launch', () => {
	it('pins to the folder npm run dev already used', () => {
		expect(pinned).toBe(path.join(root, 'frameflow'))
	})

	it('brings over a project only the stray folder has, with its undo history', () => {
		write(stray, 'threads', 'a.json', '{"id":"a"}')
		write(stray, 'editor-history', 'a.json', 'history-a')
		write(stray, 'editor-revisions', 'a', 'r1.json', 'rev')
		expect(importStrayProjects(stray, pinned)).toEqual(['a'])
		expect(read(pinned, 'threads', 'a.json')).toBe('{"id":"a"}')
		expect(read(pinned, 'editor-history', 'a.json')).toBe('history-a')
		expect(read(pinned, 'editor-revisions', 'a', 'r1.json')).toBe('rev')
	})

	it('keeps a pinned project that is as new or newer than the stray copy', () => {
		write(stray, 'threads', 'a.json', 'old')
		write(pinned, 'threads', 'a.json', 'mine')
		age(path.join(stray, 'threads', 'a.json'), 60)
		expect(importStrayProjects(stray, pinned)).toEqual([])
		expect(read(pinned, 'threads', 'a.json')).toBe('mine')
		expect(fs.existsSync(path.join(pinned, BACKUP_DIR_NAME))).toBe(false)
	})

	it('replaces a stale pinned project with the newer stray copy, backing the old one up', () => {
		write(pinned, 'threads', 'a.json', 'stale')
		write(pinned, 'editor-history', 'a.json', 'stale-history')
		write(pinned, 'editor-revisions', 'a', 'r1.json', 'stale-rev')
		age(path.join(pinned, 'threads', 'a.json'), 60)
		write(stray, 'threads', 'a.json', 'fresh')
		write(stray, 'editor-history', 'a.json', 'fresh-history')
		write(stray, 'editor-revisions', 'a', 'r2.json', 'fresh-rev')
		expect(importStrayProjects(stray, pinned, new Date('2026-11-09T22:00:00Z'))).toEqual(['a'])
		expect(read(pinned, 'threads', 'a.json')).toBe('fresh')
		expect(read(pinned, 'editor-history', 'a.json')).toBe('fresh-history')
		expect(fs.existsSync(path.join(pinned, 'editor-revisions', 'a', 'r1.json'))).toBe(false)
		expect(read(pinned, 'editor-revisions', 'a', 'r2.json')).toBe('fresh-rev')
		const backup = path.join(pinned, BACKUP_DIR_NAME, '2026-11-09T22-00-00-000Z')
		expect(read(backup, 'threads', 'a.json')).toBe('stale')
		expect(read(backup, 'editor-history', 'a.json')).toBe('stale-history')
		expect(read(backup, 'editor-revisions', 'a', 'r1.json')).toBe('stale-rev')
	})

	it('skips backup copies', () => {
		write(stray, 'threads', 'a.json.bak', 'x')
		expect(importStrayProjects(stray, pinned)).toEqual([])
		expect(fs.existsSync(path.join(pinned, 'threads', 'a.json.bak'))).toBe(false)
	})

	it('runs once, so a project removed later does not come back', () => {
		write(stray, 'threads', 'a.json', '{}')
		importStrayProjects(stray, pinned)
		fs.rmSync(path.join(pinned, 'threads', 'a.json'))
		expect(importStrayProjects(stray, pinned)).toEqual([])
		expect(fs.existsSync(path.join(pinned, 'threads', 'a.json'))).toBe(false)
	})

	it('does nothing when there is no stray folder', () => {
		expect(importStrayProjects(stray, pinned)).toEqual([])
	})
})
