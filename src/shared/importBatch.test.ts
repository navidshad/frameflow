import { describe, expect, it } from 'vitest'
import { baseName, errorText, importInOrder, reportOf, type BatchProgress } from './importBatch'

describe('importInOrder', () => {
	it('imports every file, in the order given', async () => {
		const seen: string[] = []
		const r = await importInOrder(['/a/1.mp4', '/a/2.mp4', '/a/3.mp4'], async (f) => { seen.push(f); return baseName(f) })
		expect(seen).toEqual(['/a/1.mp4', '/a/2.mp4', '/a/3.mp4'])
		expect(r.items).toEqual(['1.mp4', '2.mp4', '3.mp4'])
		expect(r.failed).toEqual([])
		expect(r.stopped).toBe(false)
	})

	it('one bad file does not stop the rest, and is listed afterwards', async () => {
		const r = await importInOrder(['/a/ok1.mp4', '/a/bad.mp4', '/a/ok2.mp4'], async (f) => {
			if (f.endsWith('bad.mp4')) throw new Error("Error invoking remote method 'add-media-asset': Error: Could not read media metadata.")
			return baseName(f)
		})
		expect(r.items).toEqual(['ok1.mp4', 'ok2.mp4'])
		expect(r.failed).toEqual([{ path: '/a/bad.mp4', name: 'bad.mp4', error: 'Could not read media metadata.' }])
	})

	it('an import that answers nothing counts as a failure, not a success', async () => {
		const r = await importInOrder(['/a/1.mp4'], async () => null)
		expect(r.items).toEqual([])
		expect(r.failed).toHaveLength(1)
	})

	it('tells progress before the work, after every file and at the end', async () => {
		const log: BatchProgress[] = []
		await importInOrder(['/a/1.mp4', '/a/2.mp4'], async (f) => f, { onProgress: (p) => log.push(p) })
		expect(log.map((p) => [p.done, p.current, p.imported])).toEqual([
			[0, null, 0], [0, '1.mp4', 0], [1, '2.mp4', 1], [2, null, 2]
		])
		expect(log.every((p) => p.total === 2)).toBe(true)
	})

	it('stops between files when asked, and says it stopped', async () => {
		let n = 0
		const r = await importInOrder(['/a/1.mp4', '/a/2.mp4', '/a/3.mp4'], async (f) => { n++; return f }, { shouldStop: () => n >= 1 })
		expect(r.items).toEqual(['/a/1.mp4'])
		expect(r.stopped).toBe(true)
	})

	it('an empty list is a finished batch', async () => {
		const r = await importInOrder([], async (f) => f)
		expect(r).toEqual({ items: [], failed: [], stopped: false })
	})

	it('hands the UI copies: a later failure does not rewrite an earlier snapshot', async () => {
		const log: BatchProgress[] = []
		await importInOrder(['/a/1.mp4', '/a/2.mp4'], async (f) => { if (f.endsWith('1.mp4')) throw new Error('x'); return f }, { onProgress: (p) => log.push(p) })
		expect(log[1].failed).toHaveLength(0)
		expect(log.at(-1)!.failed).toHaveLength(1)
	})
})

describe('errorText', () => {
	it('strips Electron\'s wrapper', () => {
		expect(errorText(new Error("Error invoking remote method 'x': Error: no such file"))).toBe('no such file')
	})
	it('passes a plain message through', () => {
		expect(errorText(new Error('plain'))).toBe('plain')
		expect(errorText('text')).toBe('text')
		expect(errorText(undefined)).toBe('Unknown error')
	})
})

describe('reportOf', () => {
	it('puts the expansion and the run side by side', () => {
		const rep = reportOf(
			{ skipped: [{ path: '/n.txt', reason: 'unsupported' }], truncated: false },
			{ items: ['a', 'b'], failed: [], stopped: false }
		)
		expect(rep).toEqual({ imported: 2, failed: [], skipped: [{ path: '/n.txt', reason: 'unsupported' }], truncated: false, stopped: false })
	})
})
