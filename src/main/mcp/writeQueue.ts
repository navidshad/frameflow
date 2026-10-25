import { ToolError } from './tools'

/**
 * One write at a time per live project, across every MCP server in the process.
 *
 * The user's outside agents and FrameFlow's own engine run on separate servers
 * but edit the same live document, so each write must see the one before it. A
 * write that arrives while another is running waits its turn instead of
 * failing; only a wait longer than `maxWaitMs` gives up, and then before it
 * has changed anything.
 *
 * `busy()` is what the renderer bridge asks before it times out a read: while
 * this process is still working through its own writes, a slow editor is
 * expected, not hung.
 */

export interface QueueOptions {
	/** Longest a write may wait for the ones ahead of it. The write itself is not timed here. */
	maxWaitMs?: number
	/** Told every `progressEveryMs` while the write waits, so a client can show it and keep waiting. */
	onWaiting?: (message: string, waitedMs: number) => void
	progressEveryMs?: number
}

export const DEFAULT_MAX_WAIT_MS = 5 * 60_000

interface Lane {
	tail: Promise<unknown>
	/** Writes queued or running in this lane. */
	depth: number
}

export class WriteQueue {
	private lanes = new Map<string, Lane>()

	/** Writes queued or running, for one project or for all. */
	depth(key?: string): number {
		if (key !== undefined) return this.lanes.get(key)?.depth ?? 0
		let n = 0
		for (const lane of this.lanes.values()) n += lane.depth
		return n
	}

	busy(key?: string): boolean {
		return this.depth(key) > 0
	}

	run<T>(key: string, work: () => Promise<T>, options: QueueOptions = {}): Promise<T> {
		const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
		let lane = this.lanes.get(key)
		if (!lane) {
			lane = { tail: Promise.resolve(), depth: 0 }
			this.lanes.set(key, lane)
		}
		const ahead = lane.depth
		lane.depth++
		const current = lane

		const previous = current.tail
		const turn = new Promise<void>((resolve, reject) => {
			if (ahead === 0) return resolve()
			const startedAt = Date.now()
			const ticker = options.onWaiting && setInterval(() => {
				const waited = Date.now() - startedAt
				try {
					options.onWaiting!(`Waiting for ${ahead === 1 ? 'an earlier edit' : `${ahead} earlier edits`} to finish (${Math.round(waited / 1000)}s)…`, waited)
				} catch { /* a progress note is a nicety */ }
			}, options.progressEveryMs ?? 5_000)
			const stop = () => { clearTimeout(timer); if (ticker) clearInterval(ticker) }
			const timer = setTimeout(() => {
				stop()
				reject(new ToolError(
					`FrameFlow is still working through ${ahead === 1 ? 'an earlier edit' : `${ahead} earlier edits`} ` +
					`(checking and applying motion pages takes a while), so this one waited ${Math.round(maxWaitMs / 1000)}s ` +
					'and was not applied. Nothing was changed: send it again in a minute.'
				))
			}, maxWaitMs)
			previous.then(() => { stop(); resolve() })
		})

		const result = turn.then(() => work())
		// The next write starts when this one is done (or gave up waiting), never before.
		current.tail = Promise.all([previous, result.catch(() => undefined)]).then(() => undefined, () => undefined)
		const release = () => {
			current.depth--
			if (current.depth === 0 && this.lanes.get(key) === current) this.lanes.delete(key)
		}
		// A write that gave up still holds its place until the ones ahead finish,
		// so `depth` keeps counting it: the editor is just as busy.
		current.tail.then(release)
		return result
	}
}

/** The process-wide queue: every server shares it. */
export const writeQueue = new WriteQueue()

/**
 * All writes land on the project open in the editor, whichever it is, so they
 * share one lane. A key is still taken so a future bridge that can edit a
 * project in the background gets its own lane per project.
 */
export const LIVE_PROJECT = 'live'
