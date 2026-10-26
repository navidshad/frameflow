import { describe, expect, it, vi } from 'vitest'
import { runPool } from './transcript-pool'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('runPool', () => {
	it('never has more than `limit` in flight and starts items in order', async () => {
		let inFlight = 0
		let peak = 0
		const started: number[] = []
		await runPool([0, 1, 2, 3, 4, 5, 6], 3, async (n) => {
			started.push(n)
			inFlight++
			peak = Math.max(peak, inFlight)
			await tick(); await tick()
			inFlight--
		})
		expect(peak).toBe(3)
		expect(started).toEqual([0, 1, 2, 3, 4, 5, 6])
	})

	it('runs one at a time when the limit is 1, and copes with a limit larger than the list', async () => {
		let peak = 0, inFlight = 0
		const work = async () => { peak = Math.max(peak, ++inFlight); await tick(); inFlight-- }
		await runPool([1, 2, 3], 1, work)
		expect(peak).toBe(1)
		peak = 0
		await runPool([1, 2], 10, work)
		expect(peak).toBe(2)
		await expect(runPool([], 3, work)).resolves.toBeUndefined()
	})

	it('stops starting new items after a failure, calls stop once, and rejects with the FIRST error', async () => {
		const stop = vi.fn()
		const started: number[] = []
		const quota = new Error('429 RESOURCE_EXHAUSTED quota')
		await expect(runPool([0, 1, 2, 3, 4, 5], 2, async (n) => {
			started.push(n)
			if (n === 1) { await tick(); throw quota }
			// The others only notice once stopped, and throw their own error.
			await tick(); await tick()
			throw new Error('Aborted')
		}, stop)).rejects.toBe(quota)
		expect(stop).toHaveBeenCalledTimes(1)
		expect(started).toEqual([0, 1])
	})

	it('waits for work already started before it rejects', async () => {
		let finished = false
		await expect(runPool([0, 1], 2, async (n) => {
			if (n === 0) throw new Error('boom')
			await tick(); await tick(); await tick()
			finished = true
		})).rejects.toThrow('boom')
		expect(finished).toBe(true)
	})
})
