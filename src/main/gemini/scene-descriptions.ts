/**
 * Batching and response-joining for scene descriptions.
 *
 * One call describes many frames, and the ONLY thing tying a returned sentence
 * back to a frame used to be its position in the array. A model that omits one
 * description silently shifts every later sentence onto the next frame — while
 * each stored record keeps the correct-looking startTime and framePath of the
 * frame it was supposed to describe. The result is self-consistent and
 * unrecoverable: nothing downstream can tell it apart from a good run.
 *
 * So identity travels IN the payload. Every frame is labelled with its scene
 * index in the prompt, the model echoes that index back, and the join is by id.
 * The label matters: a batch-local "1..N" is a number the model can produce by
 * reflex from position — the exact operation that fails — whereas a global
 * "137..156" has to be copied from what it was shown.
 *
 * Position is never used as a fallback. A confidently wrong pairing is worse
 * than a missing description, which the caller can simply re-ask for.
 *
 * Pure and dependency-free — no ffmpeg, no Gemini, no Electron.
 */

export interface SceneFrame {
	/** Scene index in scenes.json — the id the model is asked to echo. */
	index: number
	/** Seconds into the source. */
	startTime: number
	framePath: string
}

export interface DescribedScene extends SceneFrame {
	description: string
}

/** One entry as it comes back from the model — nothing is trusted. */
export interface ModelDescription {
	index?: number
	description?: string
}

/** Frames per call. 50 diluted attention badly; the repo already uses 15 for detailed per-image work. */
export const SCENE_BATCH_SIZE = 20
/** Below this share of a batch answered, re-ask. */
export const MIN_BATCH_COVERAGE = 0.9
/** Don't bisect below this — a failure this small is the model, not the size. */
export const MIN_RETRY_BATCH = 4
/** Shorter than this and it is a scenedetect artifact, not a shot. */
export const MIN_DESCRIBABLE_DURATION = 0.25

export interface BatchMapping {
	/** Frames joined to their own description. */
	described: DescribedScene[]
	/** Asked for, never came back. */
	missing: SceneFrame[]
	/** Ids returned that were never in this batch — the model renumbered. */
	unknown: number[]
	/** Ids returned more than once; the first wins. */
	duplicates: number[]
}

/** Split frames into per-call batches, order preserved. */
export function planBatches<T>(frames: T[], size = SCENE_BATCH_SIZE): T[][] {
	const step = Math.max(1, Math.floor(size))
	const batches: T[][] = []
	for (let i = 0; i < frames.length; i += step) {
		batches.push(frames.slice(i, i + step))
	}
	return batches
}

/** Split a batch down the middle, for retrying one that threw. */
export function halveBatch<T>(batch: T[]): [T[], T[]] {
	const mid = Math.ceil(batch.length / 2)
	return [batch.slice(0, mid), batch.slice(mid)]
}

/** Share of a batch that came back joined, 0..1. An empty ask is complete. */
export function batchCoverage(matched: number, requested: number): number {
	if (!(requested > 0)) return 1
	return Math.min(1, Math.max(0, matched) / requested)
}

/**
 * Joins a model response to the frames it was asked about, BY ID.
 *
 * Everything the response claims is checked against the batch: an id that was
 * never asked for is `unknown` (the tell-tale of a model that renumbered
 * 1..N), a repeat is `duplicates`, and anything not answered is `missing` so
 * the caller can re-ask for exactly those frames.
 */
export function mapBatchResponse(
	batch: SceneFrame[],
	items: ModelDescription[] | undefined | null
): BatchMapping {
	const byIndex = new Map(batch.map((f) => [f.index, f]))
	const described: DescribedScene[] = []
	const unknown: number[] = []
	const duplicates: number[] = []
	const seen = new Set<number>()

	for (const item of items || []) {
		const index = item?.index
		if (typeof index !== 'number' || !Number.isInteger(index)) continue
		const description = typeof item.description === 'string' ? item.description.trim() : ''
		if (!description) continue
		const frame = byIndex.get(index)
		if (!frame) {
			unknown.push(index)
			continue
		}
		if (seen.has(index)) {
			duplicates.push(index)
			continue
		}
		seen.add(index)
		described.push({ ...frame, description })
	}

	return {
		described,
		missing: batch.filter((f) => !seen.has(f.index)),
		unknown,
		duplicates
	}
}
