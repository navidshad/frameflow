import { describe, expect, it } from 'vitest'
import { abortable, mapPool } from './pool'

const never = () => new AbortController().signal
const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms))

describe('mapPool', () => {
	it('returns results in job order however they finish', async () => {
		const out = await mapPool(5, 3, async (i) => { await tick(5 - i); return i * 10 }, never())
		expect(out).toEqual([0, 10, 20, 30, 40])
	})

	it('never runs more than the limit at once, and uses all of it', async () => {
		let running = 0
		let peak = 0
		await mapPool(8, 2, async () => {
			running++
			peak = Math.max(peak, running)
			await tick(3)
			running--
		}, never())
		expect(peak).toBe(2)
	})

	it('handles no jobs and a limit larger than the jobs', async () => {
		expect(await mapPool(0, 2, async () => 1, never())).toEqual([])
		expect(await mapPool(2, 9, async (i) => i, never())).toEqual([0, 1])
	})

	it('a failure aborts the others, starts no more, and throws the real error', async () => {
		const started: number[] = []
		const aborted: number[] = []
		const failure = mapPool(6, 2, async (i, signal) => {
			started.push(i)
			if (i === 0) { await tick(2); throw new Error('region 0 broke') }
			await new Promise<void>((resolve, reject) => {
				signal.addEventListener('abort', () => { aborted.push(i); reject(new Error('aborted')) })
				void resolve
			})
		}, never())
		await expect(failure).rejects.toThrow('region 0 broke')
		expect(started).toEqual([0, 1])
		expect(aborted).toEqual([1])
	})

	it('waits for running jobs to stop before it throws', async () => {
		let stopped = false
		const failure = mapPool(2, 2, async (i, signal) => {
			if (i === 0) throw new Error('boom')
			await new Promise<void>((resolve) => signal.addEventListener('abort', () => setTimeout(() => { stopped = true; resolve() }, 10)))
		}, never())
		await expect(failure).rejects.toThrow('boom')
		expect(stopped).toBe(true)
	})

	it('an outer abort reaches every job', async () => {
		const controller = new AbortController()
		const run = mapPool(4, 2, (_, signal) => new Promise<void>((_resolve, reject) => {
			signal.addEventListener('abort', () => reject(new Error('aborted')))
		}), controller.signal)
		controller.abort()
		await expect(run).rejects.toThrow('aborted')
	})
})

describe('abortable', () => {
	it('gives the result when nothing aborts', async () => {
		expect(await abortable(Promise.resolve(7), new AbortController().signal)).toBe(7)
		expect(await abortable(Promise.resolve(8))).toBe(8)
	})

	it('stops waiting at once on abort, though the work goes on', async () => {
		const controller = new AbortController()
		let finished = false
		const work = new Promise<void>((resolve) => setTimeout(() => { finished = true; resolve() }, 30))
		const waiting = abortable(work, controller.signal)
		controller.abort()
		await expect(waiting).rejects.toThrow('aborted')
		expect(finished).toBe(false) // it was not stopped, only no longer waited for
		await work
		expect(finished).toBe(true)
	})

	it('rejects straight away if already aborted', async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(abortable(new Promise(() => {}), controller.signal)).rejects.toThrow('aborted')
	})
})
