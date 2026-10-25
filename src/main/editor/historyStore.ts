import fs from 'fs'
import path from 'path'
import type { EditorHistoryLoad, EditorHistoryStep, TimelineSnapshot } from '@shared/types'
import { applyStepCap } from '@shared/editor-history'
import { collectRefs, dehydrate, hydrate } from './blobRefs'
import { streamTopLevelArrays } from './jsonStream'

/**
 * Undo/redo sidecar storage, schema 2: userData/editor-history/<threadId>.json.
 *
 * Steps carry the changed items before and after (a motion page edit carries
 * both versions of the page), and every 10th step stores a full keyframe. In
 * schema 1 that meant the same page text dozens of times: 48 MB for 50 steps
 * over 5 MB of distinct text. Schema 2 keeps the steps and keyframes with big
 * strings as references, and a `blobs` table holding each distinct string once.
 * The table is rebuilt on every write, so text no step uses any more is dropped.
 *
 * `schemaVersion` is written first so the version can be told from the first
 * bytes; anything else is schema 1, streamed and converted on first open.
 * A history that cannot be read is set aside and starts empty — undo is lost,
 * the project still opens.
 */

export const MAX_STEPS = 50
/** A schema 2 file is bounded by distinct text; past this something is wrong. */
const MAX_V2_BYTES = 512 * 1024 * 1024

const V2_PREFIX = '{"schemaVersion":2'

interface StoredHistory {
	schemaVersion: 2
	threadId: string
	currentStepId: string
	steps: EditorHistoryStep[]       // big strings as references
	keyframes: TimelineSnapshot[]    // big strings as references
	blobs: Record<string, string>
}

export class HistoryStore {
	private queues = new Map<string, Promise<unknown>>()
	private problems = new Map<string, string>()

	constructor(private readonly root: string, private readonly nextSeq: (threadId: string) => number | Promise<number>) {}

	private filePath(threadId: string) { return path.join(this.root, `${threadId}.json`) }

	private serial<T>(threadId: string, run: () => Promise<T> | T): Promise<T> {
		const previous = this.queues.get(threadId) || Promise.resolve()
		const next = previous.catch(() => undefined).then(run)
		this.queues.set(threadId, next)
		const clear = () => { if (this.queues.get(threadId) === next) this.queues.delete(threadId) }
		next.then(clear, clear)
		return next
	}

	private empty(threadId: string): StoredHistory {
		return { schemaVersion: 2, threadId, currentStepId: '', steps: [], keyframes: [], blobs: {} }
	}

	private write(file: StoredHistory) {
		// Keep only the text something still points at.
		const refs = collectRefs([file.steps, file.keyframes])
		const blobs: Record<string, string> = {}
		for (const hash of refs) {
			const text = file.blobs[hash]
			if (text !== undefined) blobs[hash] = text
		}
		const stored: StoredHistory = {
			schemaVersion: 2,
			threadId: file.threadId,
			currentStepId: file.currentStepId,
			steps: file.steps,
			keyframes: file.keyframes,
			blobs
		}
		fs.mkdirSync(this.root, { recursive: true })
		const target = this.filePath(file.threadId)
		const temp = `${target}.tmp`
		fs.writeFileSync(temp, JSON.stringify(stored))
		fs.renameSync(temp, target)
		file.blobs = blobs
	}

	private noteProblem(threadId: string, message: string) {
		console.error(`[editor-history] ${threadId}: ${message}`)
		this.problems.set(threadId, message)
	}

	private setAside(threadId: string, reason: string): StoredHistory {
		const source = this.filePath(threadId)
		const aside = `${source}.unreadable-${Date.now()}`
		try { fs.renameSync(source, aside) } catch { /* nothing to move */ }
		this.noteProblem(threadId, `Undo history could not be read (${reason}) and starts fresh. The old file was kept at ${aside}.`)
		return this.empty(threadId)
	}

	private readPrefix(file: string): string {
		const fd = fs.openSync(file, 'r')
		try {
			const buf = Buffer.alloc(V2_PREFIX.length)
			const n = fs.readSync(fd, buf, 0, buf.length, 0)
			return buf.subarray(0, n).toString('utf8')
		} finally {
			fs.closeSync(fd)
		}
	}

	/** The stored (dehydrated) history, converting schema 1 on the way. Never throws. */
	private async open(threadId: string): Promise<StoredHistory> {
		const file = this.filePath(threadId)
		if (!fs.existsSync(file)) return this.empty(threadId)
		try {
			if (this.readPrefix(file) === V2_PREFIX) {
				if (fs.statSync(file).size > MAX_V2_BYTES) return this.setAside(threadId, 'the file is too large')
				const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as StoredHistory
				if (!Array.isArray(parsed.steps) || !Array.isArray(parsed.keyframes) || !parsed.blobs) throw new Error('unexpected shape')
				return { ...parsed, threadId }
			}
			return await this.migrate(threadId)
		} catch (error) {
			return this.setAside(threadId, error instanceof Error ? error.message : String(error))
		}
	}

	/** Schema 1 → 2, one step / keyframe at a time. Throws (→ set aside) if any of it is unreadable. */
	private async migrate(threadId: string): Promise<StoredHistory> {
		const out = this.empty(threadId)
		const put = (hash: string, text: string) => { out.blobs[hash] = text }
		const rest = await streamTopLevelArrays(this.filePath(threadId), ['steps', 'keyframes'], (key, json) => {
			const value = JSON.parse(json)
			if (key === 'steps') out.steps.push(dehydrate(value as EditorHistoryStep, put))
			else out.keyframes.push(dehydrate(value as TimelineSnapshot, put))
		})
		out.currentStepId = typeof rest.currentStepId === 'string' ? rest.currentStepId : ''
		this.write(out)
		console.log(`[editor-history] Migrated ${out.steps.length} step(s) for ${threadId}`)
		return out
	}

	/** Steps for the renderer (keyframes stay in main), plus any problem found while opening. */
	load(threadId: string): Promise<EditorHistoryLoad> {
		return this.serial(threadId, async () => {
			const file = await this.open(threadId)
			let steps: EditorHistoryStep[] = []
			try {
				steps = hydrate(file.steps, (hash) => file.blobs[hash])
			} catch (error) {
				this.write(this.setAside(threadId, error instanceof Error ? error.message : String(error)))
				file.currentStepId = ''
			}
			const problem = this.problems.get(threadId)
			this.problems.delete(threadId)
			return { threadId, steps, currentStepId: file.currentStepId, ...(problem ? { problem } : {}) }
		})
	}

	/**
	 * Appends a step: truncates any redo branch after the current pointer,
	 * assigns a monotonic seq, enforces the ring cap, stores an optional
	 * keyframe, and moves the pointer to the new step.
	 * Only the new step is hashed; stored steps stay as references.
	 */
	pushStep(
		threadId: string,
		step: EditorHistoryStep,
		keyframe?: TimelineSnapshot
	): Promise<{ seq: number; stepCount: number; prunedIds: string[] }> {
		return this.serial(threadId, async () => {
			const file = await this.open(threadId)
			const put = (hash: string, text: string) => { file.blobs[hash] = text }

			// Kill the redo branch beyond the current pointer
			const pointerIndex = file.steps.findIndex((s) => s.id === file.currentStepId)
			if (pointerIndex !== -1 && pointerIndex < file.steps.length - 1) {
				const removed = new Set(file.steps.slice(pointerIndex + 1).map((s) => s.id))
				file.steps = file.steps.slice(0, pointerIndex + 1)
				file.keyframes = file.keyframes.filter((k) => !removed.has(k.stepId))
			} else if (pointerIndex === -1 && file.currentStepId === '' && file.steps.length > 0) {
				// Pointer at pre-history root: everything is a redo branch — drop it
				file.steps = []
				file.keyframes = []
			}

			const seq = await this.nextSeq(threadId)
			const stored = dehydrate({ ...step, seq }, put)
			file.steps.push(stored)
			if (keyframe) file.keyframes.push(dehydrate({ ...keyframe, stepId: stored.id }, put))

			// Main owns the cap and REPORTS the evicted ids; the renderer applies them.
			const capped = applyStepCap(file.steps, file.keyframes, MAX_STEPS)
			file.steps = capped.steps
			file.keyframes = capped.keyframes

			file.currentStepId = stored.id
			this.write(file)
			return { seq, stepCount: file.steps.length, prunedIds: capped.prunedIds }
		})
	}

	setPointer(threadId: string, currentStepId: string): Promise<boolean> {
		return this.serial(threadId, async () => {
			const file = await this.open(threadId)
			file.currentStepId = currentStepId
			this.write(file)
			return true
		})
	}

	/** Wipes the ring (revision switches: old diffs no longer apply). */
	clear(threadId: string): Promise<void> {
		return this.serial(threadId, () => { this.write(this.empty(threadId)) })
	}

	delete(threadId: string): Promise<void> {
		return this.serial(threadId, () => {
			try { fs.rmSync(this.filePath(threadId), { force: true }) } catch (error) {
				console.error(`[editor-history] Failed to delete history for ${threadId}:`, error)
			}
			this.problems.delete(threadId)
		})
	}
}
