import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { exportsDirFor, listExportFiles, resolveExportPath } from './exports'

let temp: string
let dir: string

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-exports-'))
	dir = exportsDirFor(temp)
	fs.mkdirSync(dir, { recursive: true })
})
afterEach(() => { fs.rmSync(temp, { recursive: true, force: true }) })

const put = (name: string, bytes: number, mtimeSec?: number) => {
	const full = path.join(dir, name)
	fs.writeFileSync(full, Buffer.alloc(bytes))
	if (mtimeSec) fs.utimesSync(full, mtimeSec, mtimeSec)
	return full
}

describe('listExportFiles', () => {
	it('is empty when the project never exported', () => {
		fs.rmSync(dir, { recursive: true })
		expect(listExportFiles(temp)).toEqual([])
	})

	it('lists videos newest first with name, path, size and modified time', () => {
		put('old.mp4', 10, 1_000)
		put('new.mp4', 20, 3_000)
		put('mid.mov', 30, 2_000)
		const files = listExportFiles(temp)
		expect(files.map((f) => f.name)).toEqual(['new.mp4', 'mid.mov', 'old.mp4'])
		expect(files[0]).toEqual({ name: 'new.mp4', path: path.join(dir, 'new.mp4'), size: 20, modifiedAt: 3_000_000 })
	})

	it('skips work folders, temp files, dotfiles and non-video files', () => {
		fs.mkdirSync(path.join(dir, '5b0c6f2e-work'))
		fs.writeFileSync(path.join(dir, '5b0c6f2e-work', 'inner.mp4'), 'x')
		put('half.mp4.tmp', 5)
		put('half.part', 5)
		put('.hidden.mp4', 5)
		put('notes.txt', 5)
		put('Final.MP4', 7)
		expect(listExportFiles(temp).map((f) => f.name)).toEqual(['Final.MP4'])
	})

	it('lists delivery sidecars next to the mp4', () => {
		put('a.mp4', 1, 1_000)
		put('a.loud.mp4', 1, 2_000)
		put('a.captioned.mp4', 1, 3_000)
		expect(listExportFiles(temp).map((f) => f.name)).toEqual(['a.captioned.mp4', 'a.loud.mp4', 'a.mp4'])
	})
})

describe('resolveExportPath', () => {
	it('accepts a file directly inside the exports folder', () => {
		const file = put('a.mp4', 1)
		expect(resolveExportPath(temp, file)).toBe(file)
	})

	it('refuses paths outside the folder, nested, traversing, missing or not files', () => {
		const outside = path.join(temp, 'secret.mp4')
		fs.writeFileSync(outside, 'x')
		fs.mkdirSync(path.join(dir, 'work'))
		const nested = path.join(dir, 'work', 'in.mp4')
		fs.writeFileSync(nested, 'x')
		put('a.mp4', 1)
		expect(resolveExportPath(temp, outside)).toBeNull()
		expect(resolveExportPath(temp, path.join(dir, '..', 'secret.mp4'))).toBeNull()
		expect(resolveExportPath(temp, path.join(dir, 'work', '..', '..', 'secret.mp4'))).toBeNull()
		expect(resolveExportPath(temp, nested)).toBeNull()
		expect(resolveExportPath(temp, path.join(dir, 'work'))).toBeNull()
		expect(resolveExportPath(temp, path.join(dir, 'gone.mp4'))).toBeNull()
		expect(resolveExportPath(temp, '/etc/hosts')).toBeNull()
		expect(resolveExportPath(temp, 'a.mp4')).toBeNull()
		expect(resolveExportPath(temp, '')).toBeNull()
		expect(resolveExportPath(temp, undefined)).toBeNull()
		expect(resolveExportPath(temp, path.join(dir, 'a.mp4\0.txt'))).toBeNull()
	})

	it('refuses another project\'s exports', () => {
		const other = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-exports-other-'))
		try {
			fs.mkdirSync(exportsDirFor(other), { recursive: true })
			const theirs = path.join(exportsDirFor(other), 'x.mp4')
			fs.writeFileSync(theirs, 'x')
			expect(resolveExportPath(temp, theirs)).toBeNull()
		} finally { fs.rmSync(other, { recursive: true, force: true }) }
	})
})
