import { describe, expect, it } from 'vitest'
import {
	compareNames, dedupePaths, describeBatch, describeSkipped, dialogExtensions,
	extensionOf, importKindOf, isHiddenName, orderDirEntries
} from './mediaFiles'

describe('importKindOf', () => {
	it('sorts video and audio by extension, any case', () => {
		expect(importKindOf('/a/Clip.MP4')).toBe('video')
		expect(importKindOf('shot.mov')).toBe('video')
		expect(importKindOf('take.WAV')).toBe('audio')
		expect(importKindOf('C:\\shoot\\voice.m4a')).toBe('audio')
	})

	it('leaves out everything else, stills included', () => {
		for (const name of ['notes.txt', 'photo.jpg', 'cover.png', 'README', 'project.fcpxml', 'clip.mp4.part']) {
			expect(importKindOf(name)).toBeNull()
		}
	})

	it('does not mistake a dotfile for an extension', () => {
		expect(extensionOf('.mp4')).toBe('')
		expect(importKindOf('.mp4')).toBeNull()
	})

	it('reads the extension from the file name, not a dotted folder', () => {
		expect(extensionOf('/shoot.v2/clip')).toBe('')
		expect(importKindOf('/shoot.v2/clip')).toBeNull()
	})

	it('offers the same list to the native dialog, without dots', () => {
		const all = dialogExtensions()
		expect(all).toContain('mp4')
		expect(all).toContain('wma')
		expect(all.every((e) => !e.startsWith('.'))).toBe(true)
		expect(dialogExtensions('audio')).not.toContain('mp4')
		expect(dialogExtensions('video')).not.toContain('mp3')
	})

	it('the dialog list and the import list can never disagree', () => {
		for (const ext of dialogExtensions()) expect(importKindOf(`x.${ext}`)).not.toBeNull()
	})
})

describe('isHiddenName', () => {
	it('catches dotfiles and macOS sidecars', () => {
		expect(isHiddenName('.DS_Store')).toBe(true)
		expect(isHiddenName('._clip.mp4')).toBe(true)
		expect(isHiddenName('.git')).toBe(true)
		expect(isHiddenName('clip.mp4')).toBe(false)
	})
})

describe('order', () => {
	it('compares numbers inside names as numbers', () => {
		const names = ['C0010.mp4', 'C0002.mp4', 'C0001.mp4']
		expect([...names].sort(compareNames)).toEqual(['C0001.mp4', 'C0002.mp4', 'C0010.mp4'])
		expect(['clip10.mp4', 'clip9.mp4', 'clip1.mp4'].sort(compareNames)).toEqual(['clip1.mp4', 'clip9.mp4', 'clip10.mp4'])
	})

	it('ignores case but stays deterministic for names that differ only by it', () => {
		expect(['b.mp4', 'A.mp4', 'a.mp4'].sort(compareNames)).toEqual(['A.mp4', 'a.mp4', 'b.mp4'])
	})

	it("puts a folder's own files before its subfolders", () => {
		const ordered = orderDirEntries([
			{ name: 'b-roll', isDirectory: true },
			{ name: 'z.mp4', isDirectory: false },
			{ name: 'a-cam', isDirectory: true },
			{ name: 'a.mp4', isDirectory: false }
		])
		expect(ordered.map((e) => e.name)).toEqual(['a.mp4', 'z.mp4', 'a-cam', 'b-roll'])
	})

	it('does not reorder the list it was given', () => {
		const input = [{ name: 'b', isDirectory: false }, { name: 'a', isDirectory: false }]
		orderDirEntries(input)
		expect(input.map((e) => e.name)).toEqual(['b', 'a'])
	})
})

describe('dedupePaths', () => {
	it('keeps the first occurrence and the original order', () => {
		expect(dedupePaths(['/a', '/b', '/a', '/c', '/b'])).toEqual(['/a', '/b', '/c'])
	})
})

describe('describeSkipped', () => {
	it('says nothing when nothing was left out', () => {
		expect(describeSkipped([])).toBe('')
	})

	it('counts by reason', () => {
		expect(describeSkipped([
			{ path: '/a.txt', reason: 'unsupported' },
			{ path: '/b.jpg', reason: 'unsupported' },
			{ path: '/.DS_Store', reason: 'hidden' }
		])).toBe('3 skipped (2 not video or audio, 1 hidden)')
	})
})

describe('describeBatch', () => {
	it('reads naturally for the clean case', () => {
		expect(describeBatch({ imported: 1, failed: [], skipped: [] })).toBe('1 file imported')
		expect(describeBatch({ imported: 12, failed: [], skipped: [] })).toBe('12 files imported')
	})

	it('reports failures, skips and an early stop', () => {
		const text = describeBatch({
			imported: 5,
			failed: [{ path: '/x.mp4', name: 'x.mp4', error: 'corrupt' }],
			skipped: [{ path: '/n.txt', reason: 'unsupported' }],
			truncated: true
		})
		expect(text).toBe('5 files imported · 1 failed · 1 skipped (1 not video or audio) · folder too large: stopped early')
	})
})
