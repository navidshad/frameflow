import { mkdtempSync, mkdirSync, realpathSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { describe, expect, it } from 'vitest'
import { checkProjectsFolder, isInsideTemp, nestProjectsFolder, suggestProjectsFolder } from './folder'

describe('projects folder', () => {
	it('suggests a media folder per platform', () => {
		expect(suggestProjectsFolder('/Users/ada', 'darwin')).toBe('/Users/ada/Movies/FrameFlow')
		expect(suggestProjectsFolder('/home/ada', 'linux')).toBe('/home/ada/Videos/FrameFlow')
	})
	it('nests a FrameFlow folder unless the user picked it', () => {
		expect(nestProjectsFolder('/Users/ada/Movies')).toBe('/Users/ada/Movies/FrameFlow')
		expect(nestProjectsFolder('/Users/ada/Movies/FrameFlow')).toBe('/Users/ada/Movies/FrameFlow')
	})
	it('refuses the system temp folder, folders inside it, and folders not yet created inside it', () => {
		const tmp = realpathSync(mkdtempSync(join(os.tmpdir(), 'ff-setup-')))
		mkdirSync(join(tmp, 'a'))
		expect(isInsideTemp(tmp, tmp)).toBe(true)
		expect(isInsideTemp(join(tmp, 'a'), tmp)).toBe(true)
		expect(isInsideTemp(join(tmp, 'a', 'b', 'FrameFlow'), tmp)).toBe(true)
		expect(checkProjectsFolder(join(tmp, 'a'), tmp).ok).toBe(false)
	})
	it('does not treat a sibling with the same prefix as inside', () => {
		expect(isInsideTemp('/private/tmpfoo/x', '/private/tmp')).toBe(false)
	})
	it('accepts a writable folder outside temp and reports its free space', () => {
		const result = checkProjectsFolder(join(os.homedir(), 'FrameFlow-does-not-exist-yet'), '/definitely/not/here')
		expect(result.ok).toBe(true)
		expect(typeof result.freeBytes).toBe('number')
	})
	it('rejects an empty or relative path', () => {
		expect(checkProjectsFolder('').ok).toBe(false)
		expect(checkProjectsFolder('Movies/FrameFlow').ok).toBe(false)
	})
})
