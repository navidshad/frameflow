import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { storeAttachments } from './attachments'

const project = () => mkdtempSync(path.join(os.tmpdir(), 'ff-attach-'))
const jpeg = Buffer.from('not really a jpeg').toString('base64')

describe('storeAttachments', () => {
	it('writes each picture beside the project and hands back what the turn keeps', async () => {
		const dir = project()
		const { attachments, images } = await storeAttachments(dir, 'turn1', [
			{ id: 'a', timeSec: 3.5, note: '  too big  ', marked: true, thumbnail: 'data:image/jpeg;base64,x', data: jpeg, mimeType: 'image/jpeg' },
			{ id: 'b', timeSec: -2, thumbnail: 'javascript:alert(1)', data: jpeg, mimeType: 'image/png' }
		])
		expect(attachments.map((a) => [a.id, a.timeSec, a.note, a.marked, path.basename(a.path)])).toEqual([
			['a', 3.5, 'too big', true, 'turn1-1.jpg'],
			['b', 0, undefined, undefined, 'turn1-2.png']
		])
		// Only a picture's data URL is kept as a thumbnail.
		expect(attachments[1].thumbnail).toBe('')
		expect(readFileSync(attachments[0].path, 'utf-8')).toBe('not really a jpeg')
		expect(images).toEqual([{ data: jpeg, mimeType: 'image/jpeg' }, { data: jpeg, mimeType: 'image/png' }])
	})

	it('Retry reads back a file this project wrote, and nothing else', async () => {
		const dir = project()
		const first = await storeAttachments(dir, 't', [{ id: 'a', timeSec: 1, thumbnail: '', data: jpeg, mimeType: 'image/jpeg' }])
		const again = await storeAttachments(dir, 't2', [{ ...first.attachments[0] }])
		expect(again.images).toEqual([{ data: jpeg, mimeType: 'image/jpeg' }])

		const outside = path.join(project(), 'secret.jpg')
		writeFileSync(outside, 'x')
		await expect(storeAttachments(dir, 't3', [{ id: 'x', timeSec: 0, thumbnail: '', path: outside }])).rejects.toThrow(/not one of this project/)
		const sneaky = path.join(dir, 'prompt-attachments', '..', 'thread.json')
		await expect(storeAttachments(dir, 't4', [{ id: 'x', timeSec: 0, thumbnail: '', path: sneaky }])).rejects.toThrow(/not one of this project/)
	})

	it('refuses what is not a picture, and says when a kept frame is gone', async () => {
		const dir = project()
		await expect(storeAttachments(dir, 't', [{ id: 'a', timeSec: 0, thumbnail: '', data: jpeg, mimeType: 'text/html' }])).rejects.toThrow(/not a picture/)
		await expect(storeAttachments(dir, 't', [{ id: 'a', timeSec: 0, thumbnail: '', data: '', mimeType: 'image/jpeg' }])).rejects.toThrow(/empty/)
		const gone = path.join(dir, 'prompt-attachments', 'missing.jpg')
		await expect(storeAttachments(dir, 't', [{ id: 'a', timeSec: 0, thumbnail: '', path: gone }])).rejects.toThrow(/no longer on disk/)
		expect(await storeAttachments(dir, 't', undefined)).toEqual({ attachments: [], images: [] })
	})
})
