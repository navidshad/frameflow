import { describe, expect, it } from 'vitest'
import { createSlotPool } from './concurrency'

/** A job that stays inside its slot until `finish` is called. */
function job(log: string[], name: string) {
	let finish!: () => void
	const done = new Promise<void>((resolve) => { finish = resolve })
	return { finish, run: async () => { log.push(`start ${name}`); await done; log.push(`end ${name}`) } }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('createSlotPool', () => {
	it('never runs more than max at once, and hands a freed slot to the next waiter', async () => {
		const pool = createSlotPool(2)
		const log: string[] = []
		const [a, b, c] = ['a', 'b', 'c'].map((n) => job(log, n))
		const runs = [pool.run(a.run), pool.run(b.run), pool.run(c.run)]
		await tick()
		expect(log).toEqual(['start a', 'start b'])
		expect(pool.active).toBe(2)
		a.finish()
		await tick()
		expect(log).toContain('start c')
		expect(pool.active).toBe(2) // handed over, never briefly 1 with a newcomer slipping in
		b.finish(); c.finish()
		await Promise.all(runs)
		expect(pool.active).toBe(0)
	})

	it('lets a job that is first in line go ahead of the queue', async () => {
		const pool = createSlotPool(1)
		const log: string[] = []
		const [hold, slow, urgent] = ['hold', 'slow', 'urgent'].map((n) => job(log, n))
		const runs = [pool.run(hold.run), pool.run(slow.run), pool.run(urgent.run, { first: true })]
		await tick()
		hold.finish()
		await tick()
		expect(log.filter((l) => l.startsWith('start'))).toEqual(['start hold', 'start urgent'])
		urgent.finish(); await tick(); slow.finish()
		await Promise.all(runs)
	})

	it('caps a group below the pool, leaving a slot for quick jobs (proxies must not starve the audio)', async () => {
		const pool = createSlotPool(3)
		const proxy = { name: 'proxy', max: 2 }
		const log: string[] = []
		const p = ['p1', 'p2', 'p3'].map((n) => job(log, n))
		const audio = job(log, 'audio')
		const runs = p.map((j) => pool.run(j.run, { group: proxy }))
		await tick()
		// Two proxies run; the third waits although a slot is free.
		expect(log).toEqual(['start p1', 'start p2'])
		runs.push(pool.run(audio.run, { first: true }))
		await tick()
		expect(log).toContain('start audio')
		// A finished proxy lets the waiting one in.
		p[0].finish()
		await tick()
		expect(log).toContain('start p3')
		audio.finish(); p[1].finish(); p[2].finish()
		await Promise.all(runs)
	})

	it('frees the slot when a job throws', async () => {
		const pool = createSlotPool(1)
		await expect(pool.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
		expect(pool.active).toBe(0)
		await expect(pool.run(async () => 'ok')).resolves.toBe('ok')
	})
})
