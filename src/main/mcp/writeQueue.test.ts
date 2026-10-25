import { afterEach, describe, expect, it, vi } from 'vitest'
import { WriteQueue } from './writeQueue'

const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))

describe('WriteQueue', () => {
	afterEach(() => vi.useRealTimers())

	it('runs writes to one project one at a time, in arrival order', async () => {
		const queue = new WriteQueue()
		const log: string[] = []
		const job = (name: string, ms: number) => async () => {
			log.push(`start ${name}`)
			await later(ms, null)
			log.push(`end ${name}`)
			return name
		}
		const results = await Promise.all([queue.run('p', job('a', 30)), queue.run('p', job('b', 5)), queue.run('p', job('c', 1))])
		expect(results).toEqual(['a', 'b', 'c'])
		expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
	})

	it('keeps going after a write fails', async () => {
		const queue = new WriteQueue()
		const failed = queue.run('p', async () => { throw new Error('bad op') })
		const next = queue.run('p', async () => 'ok')
		await expect(failed).rejects.toThrow('bad op')
		await expect(next).resolves.toBe('ok')
		expect(queue.busy()).toBe(false)
	})

	it('lets other projects through while one is busy', async () => {
		const queue = new WriteQueue()
		let release!: () => void
		const slow = queue.run('p', () => new Promise<string>((resolve) => { release = () => resolve('p') }))
		await expect(queue.run('q', async () => 'q')).resolves.toBe('q')
		expect(queue.depth('p')).toBe(1)
		release()
		await slow
	})

	it('says it is busy while writes are queued or running, and not after', async () => {
		const queue = new WriteQueue()
		expect(queue.busy()).toBe(false)
		let release!: () => void
		const first = queue.run('p', () => new Promise<void>((resolve) => { release = resolve }))
		const second = queue.run('p', async () => undefined)
		expect(queue.depth('p')).toBe(2)
		expect(queue.busy()).toBe(true)
		await later(0, null)
		release()
		await Promise.all([first, second])
		await later(0, null)
		expect(queue.busy()).toBe(false)
	})

	it('gives up, unapplied, when the wait is too long, and reports progress while waiting', async () => {
		vi.useFakeTimers()
		const queue = new WriteQueue()
		let release!: () => void
		const first = queue.run('p', () => new Promise<void>((resolve) => { release = resolve }))
		const notes: string[] = []
		const ran = vi.fn(async () => 'never')
		const waiting = queue.run('p', ran, { maxWaitMs: 12_000, progressEveryMs: 5_000, onWaiting: (m) => notes.push(m) })
		const caught = waiting.catch((e) => e)
		await vi.advanceTimersByTimeAsync(12_001)
		const error = await caught
		expect(error.message).toMatch(/earlier edit/)
		expect(error.message).toMatch(/Nothing was changed/)
		expect(ran).not.toHaveBeenCalled()
		expect(notes).toEqual(['Waiting for an earlier edit to finish (5s)…', 'Waiting for an earlier edit to finish (10s)…'])

		// The one behind it still waits for the write that is running, not for the one that gave up.
		const third = vi.fn(async () => 'third')
		const after = queue.run('p', third)
		await vi.advanceTimersByTimeAsync(1)
		expect(third).not.toHaveBeenCalled()
		release()
		await first
		await expect(after).resolves.toBe('third')
	})
})
