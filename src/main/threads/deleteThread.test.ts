import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-delete-'))
const userData = path.join(root, 'userData')

vi.mock('electron', () => ({
	app: { getPath: () => userData },
	BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../settings', () => ({
	settingsManager: {
		getThreadTempDir: (id: string) => path.join(root, 'projects', id),
		getTempDir: () => path.join(root, 'projects')
	}
}))
vi.mock('../ffmpeg', () => ({ getVideoMetadata: vi.fn() }))

const { threadManager } = await import('./index')

/** A project on disk: its record in userData and a folder holding an "export". */
function makeProject(id: string, folder = path.join(root, 'projects', id)) {
	fs.mkdirSync(path.join(folder, 'exports'), { recursive: true })
	fs.writeFileSync(path.join(folder, 'exports', 'final.mp4'), 'render')
	fs.writeFileSync(
		path.join(userData, 'threads', `${id}.json`),
		JSON.stringify({ id, title: id, type: 'editor', tempDir: folder, preprocessing: {}, messages: [] })
	)
	return folder
}

const hasRecord = (id: string) => fs.existsSync(path.join(userData, 'threads', `${id}.json`))

describe('removing a project', () => {
	beforeEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
		fs.mkdirSync(path.join(root, 'projects'), { recursive: true })
		threadManager.init()
	})
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

	it('deletes the folder by default, as it always has', () => {
		const folder = makeProject('aaaa')
		expect(threadManager.deleteThread('aaaa')).toBe(true)
		expect(hasRecord('aaaa')).toBe(false)
		expect(fs.existsSync(folder)).toBe(false)
	})

	it('deletes the folder when asked to', () => {
		const folder = makeProject('bbbb')
		threadManager.deleteThread('bbbb', { deleteFiles: true })
		expect(fs.existsSync(folder)).toBe(false)
	})

	it('keeps the folder and its exports when told to keep the files', () => {
		const folder = makeProject('cccc')
		expect(threadManager.deleteThread('cccc', { deleteFiles: false })).toBe(true)
		expect(hasRecord('cccc')).toBe(false)
		expect(fs.readFileSync(path.join(folder, 'exports', 'final.mp4'), 'utf8')).toBe('render')
	})

	it('does not bring a project back at the next start when its files were kept', () => {
		const folder = makeProject('eeee')
		// The folder holds a mirror of the project, as the app writes it.
		fs.writeFileSync(path.join(folder, 'thread.json'), JSON.stringify({ id: 'eeee', title: 'eeee', type: 'editor', tempDir: folder, preprocessing: {}, messages: [] }))
		threadManager.deleteThread('eeee', { deleteFiles: false })
		expect(hasRecord('eeee')).toBe(false)
		// What the app does at every start: re-add any folder that still carries its project file.
		threadManager.syncWithArtifactDir()
		expect(hasRecord('eeee')).toBe(false)
		// The files are all still there, and the project is recoverable by hand.
		expect(fs.existsSync(path.join(folder, 'exports', 'final.mp4'))).toBe(true)
		expect(fs.existsSync(path.join(folder, 'thread.removed.json'))).toBe(true)
	})

	it('never removes a folder that is not named after the project', () => {
		const shared = makeProject('dddd', path.join(root, 'shared-footage'))
		threadManager.deleteThread('dddd')
		expect(hasRecord('dddd')).toBe(false)
		expect(fs.existsSync(path.join(shared, 'exports', 'final.mp4'))).toBe(true)
	})
})
