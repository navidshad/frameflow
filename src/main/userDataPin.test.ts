import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { importStrayProjects, pinnedUserDataDir } from './userDataPin'

let root: string
let stray: string
let pinned: string
const write = (...p: string[]) => {
	const [content, ...rest] = [p[p.length - 1], ...p.slice(0, -1)]
	const file = path.join(...rest)
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, content)
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

	it('never overwrites a project the pinned folder already has', () => {
		write(stray, 'threads', 'a.json', 'old')
		write(pinned, 'threads', 'a.json', 'mine')
		expect(importStrayProjects(stray, pinned)).toEqual([])
		expect(read(pinned, 'threads', 'a.json')).toBe('mine')
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
