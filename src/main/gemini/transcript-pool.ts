/**
 * Runs `worker` over `items` with at most `limit` in flight, starting them in
 * order. The first failure stops the rest cleanly: nothing new is started,
 * `stop` is called once so calls already in flight can be aborted, and the
 * returned promise rejects with that first error — not with the "Aborted"
 * the cancelled workers throw afterwards. It resolves only after every started
 * worker has settled, so the caller can clean up shared files safely.
 */
export async function runPool<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>,
	stop: () => void = () => {}
): Promise<void> {
	let next = 0
	let failed = false
	let firstError: unknown

	const lane = async (): Promise<void> => {
		while (!failed && next < items.length) {
			const item = items[next++]
			try {
				await worker(item)
			} catch (error) {
				if (!failed) {
					failed = true
					firstError = error
					stop()
				}
				return
			}
		}
	}

	const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
	await Promise.all(Array.from({ length: lanes }, lane))
	if (failed) throw firstError
}
