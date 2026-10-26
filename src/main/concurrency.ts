/**
 * A pool of job slots shared by everything that wants one.
 *
 * `max` jobs run at once. A job may also belong to a group with its own,
 * smaller limit (proxies: two at most, so a third file's proxy never takes
 * the slot the next file's audio is waiting for), and a job that is urgent
 * can go to the front of the line. Slots are handed straight from a finished
 * job to the next waiting one, so a newcomer cannot slip in between and push
 * the pool over its limit.
 */
export interface SlotOptions {
	/** Jobs in the same group share `max` slots on top of the pool's own limit. */
	group?: { name: string; max: number }
	/** Wait at the front of the line instead of the back. */
	first?: boolean
}

interface Waiter {
	options: SlotOptions
	start: () => void
}

export function createSlotPool(max: number) {
	let running = 0
	const groupRunning = new Map<string, number>()
	const queue: Waiter[] = []

	const fits = (options: SlotOptions) =>
		running < max && (!options.group || (groupRunning.get(options.group.name) ?? 0) < options.group.max)

	const take = (options: SlotOptions) => {
		running++
		if (options.group) groupRunning.set(options.group.name, (groupRunning.get(options.group.name) ?? 0) + 1)
	}

	const release = (options: SlotOptions) => {
		running--
		if (options.group) groupRunning.set(options.group.name, (groupRunning.get(options.group.name) ?? 1) - 1)
		// The first waiter that fits goes now; one blocked by its group's limit does not hold up the rest.
		for (let i = 0; i < queue.length; i++) {
			if (!fits(queue[i].options)) continue
			const [next] = queue.splice(i, 1)
			take(next.options)
			next.start()
			i = -1 // a release can free more than one kind of waiter; start over
		}
	}

	return {
		async run<T>(fn: () => Promise<T>, options: SlotOptions = {}): Promise<T> {
			// Nothing queued can fit right now (a release starts every waiter that does), so one that fits may go.
			if (fits(options)) {
				take(options)
			} else {
				await new Promise<void>((resolve) => {
					const waiter: Waiter = { options, start: resolve }
					if (options.first) queue.unshift(waiter)
					else queue.push(waiter)
				})
			}
			try {
				return await fn()
			} finally {
				release(options)
			}
		},
		get active() { return running },
		get queued() { return queue.length }
	}
}
