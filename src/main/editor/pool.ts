/**
 * Runs `count` jobs, at most `limit` at once, and returns their results in job
 * order. The export renders its regions through this: they are independent
 * files, and the hardware encoder has room for more than one.
 *
 * A job that fails aborts the signal the others were given and stops new ones
 * from starting. The call waits for the running ones to finish before it throws,
 * so nothing is still writing into the work directory when the caller removes
 * it, and the error thrown is the first real one, not the "aborted" it caused.
 */
export async function mapPool<T>(
	count: number,
	limit: number,
	run: (index: number, signal: AbortSignal) => Promise<T>,
	signal: AbortSignal
): Promise<T[]> {
	const inner = new AbortController()
	const onOuterAbort = () => inner.abort()
	if (signal.aborted) inner.abort()
	else signal.addEventListener('abort', onOuterAbort, { once: true })

	const results: T[] = new Array(count)
	let next = 0
	let failure: { error: unknown } | null = null

	const worker = async () => {
		while (!failure && !inner.signal.aborted && next < count) {
			const index = next++
			try {
				results[index] = await run(index, inner.signal)
			} catch (error) {
				if (!failure) failure = { error }
				inner.abort()
			}
		}
	}

	try {
		const workers = Array.from({ length: Math.max(1, Math.min(limit, count)) }, worker)
		await Promise.all(workers)
	} finally {
		signal.removeEventListener('abort', onOuterAbort)
	}
	if (failure) throw (failure as { error: unknown }).error
	if (signal.aborted) throw new Error('aborted')
	return results
}
