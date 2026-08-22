import { describe, expect, it } from 'vitest'
import {
	MIN_RETRY_BATCH,
	SCENE_BATCH_SIZE,
	batchCoverage,
	halveBatch,
	mapBatchResponse,
	planBatches,
	type SceneFrame
} from './scene-descriptions'

/** Frames with the given scene indices. */
const frames = (indices: number[]): SceneFrame[] =>
	indices.map((index) => ({
		index, startTime: index * 4, framePath: `/frames/f_${index}.jpg`
	}))

describe('planBatches', () => {
	it('splits into exact batches', () => {
		expect(planBatches([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
	})

	it('keeps the short remainder as a final batch', () => {
		expect(planBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
	})

	it('returns nothing for no frames', () => {
		expect(planBatches([], 20)).toEqual([])
	})

	it('leaves a batch shorter than the size as one call', () => {
		expect(planBatches([1, 2, 3], 20)).toEqual([[1, 2, 3]])
	})

	it('covers every frame exactly once, in order', () => {
		const all = Array.from({ length: 57 }, (_, i) => i)
		expect(planBatches(all, SCENE_BATCH_SIZE).flat()).toEqual(all)
	})
})

describe('halveBatch', () => {
	it('splits an even batch down the middle', () => {
		expect(halveBatch([1, 2, 3, 4])).toEqual([[1, 2], [3, 4]])
	})

	it('covers everything on an odd split', () => {
		const [a, b] = halveBatch([1, 2, 3, 4, 5])
		expect([...a, ...b]).toEqual([1, 2, 3, 4, 5])
		expect(a.length).toBeGreaterThan(0)
		expect(b.length).toBeGreaterThan(0)
	})

	it('is never reached for a batch too small to halve usefully', () => {
		// Callers gate on MIN_RETRY_BATCH, which is what stops halveBatch ever
		// being asked for the degenerate [[x], []] split.
		expect(MIN_RETRY_BATCH).toBeGreaterThan(1)
		expect(halveBatch([1])).toEqual([[1], []])
	})
})

describe('batchCoverage', () => {
	it('treats an empty ask as complete', () => {
		expect(batchCoverage(0, 0)).toBe(1)
	})

	it('reports the answered share', () => {
		expect(batchCoverage(9, 10)).toBeCloseTo(0.9)
	})

	it('clamps when the model over-returns', () => {
		expect(batchCoverage(25, 20)).toBe(1)
	})

	it('reports zero when nothing came back', () => {
		expect(batchCoverage(0, 20)).toBe(0)
	})
})

describe('mapBatchResponse', () => {
	it('joins a complete response', () => {
		const batch = frames([10, 11, 12])
		const result = mapBatchResponse(batch, [
			{ index: 10, description: 'a dock at dawn' },
			{ index: 11, description: 'a boat pulls away' },
			{ index: 12, description: 'open water' }
		])
		expect(result.described.map((d) => [d.index, d.description])).toEqual([
			[10, 'a dock at dawn'], [11, 'a boat pulls away'], [12, 'open water']
		])
		expect(result.missing).toEqual([])
		expect(result.unknown).toEqual([])
	})

	it('does NOT shift later descriptions onto the wrong frame when one is omitted', () => {
		// REGRESSION. The positional zip took descriptions[1] — frame 12's text —
		// and stored it against frame 11's startTime and framePath, producing a
		// record that looks right and is wrong.
		const batch = frames([10, 11, 12])
		const result = mapBatchResponse(batch, [
			{ index: 10, description: 'a dock at dawn' },
			{ index: 12, description: 'open water' }
		])
		expect(result.described).toHaveLength(2)
		expect(result.described.map((d) => d.index)).toEqual([10, 12])
		expect(result.described.find((d) => d.index === 12)!.framePath).toBe('/frames/f_12.jpg')
		expect(result.described.find((d) => d.index === 12)!.startTime).toBe(48)
		// Nothing at all was attributed to the frame that went unanswered.
		expect(result.described.some((d) => d.description === 'open water' && d.index === 11)).toBe(false)
		expect(result.missing.map((f) => f.index)).toEqual([11])
	})

	it('joins an out-of-order response correctly', () => {
		const result = mapBatchResponse(frames([10, 11, 12]), [
			{ index: 12, description: 'third' },
			{ index: 10, description: 'first' },
			{ index: 11, description: 'second' }
		])
		expect(result.described.map((d) => [d.index, d.description])).toEqual([
			[12, 'third'], [10, 'first'], [11, 'second']
		])
		expect(result.missing).toEqual([])
	})

	it('is loud when the model renumbers the batch 1..N', () => {
		// The failure mode a batch-local index would have hidden: every id looks
		// plausible, none of them is real.
		const batch = frames([137, 138, 139])
		const result = mapBatchResponse(batch, [
			{ index: 1, description: 'one' },
			{ index: 2, description: 'two' },
			{ index: 3, description: 'three' }
		])
		expect(result.described).toEqual([])
		expect(result.unknown).toEqual([1, 2, 3])
		expect(result.missing.map((f) => f.index)).toEqual([137, 138, 139])
	})

	it('records an id that was never asked for as unknown', () => {
		const result = mapBatchResponse(frames([10, 11]), [
			{ index: 10, description: 'ok' },
			{ index: 99, description: 'from nowhere' }
		])
		expect(result.unknown).toEqual([99])
		expect(result.described.map((d) => d.index)).toEqual([10])
	})

	it('keeps the first of a duplicated id', () => {
		const result = mapBatchResponse(frames([10, 11]), [
			{ index: 10, description: 'first answer' },
			{ index: 10, description: 'second answer' },
			{ index: 11, description: 'ok' }
		])
		expect(result.duplicates).toEqual([10])
		expect(result.described.find((d) => d.index === 10)!.description).toBe('first answer')
		expect(result.described).toHaveLength(2)
	})

	it('treats a blank description as no answer', () => {
		const result = mapBatchResponse(frames([10, 11]), [
			{ index: 10, description: '   ' },
			{ index: 11, description: 'ok' }
		])
		expect(result.described.map((d) => d.index)).toEqual([11])
		expect(result.missing.map((f) => f.index)).toEqual([10])
	})

	it('ignores non-integer ids', () => {
		const result = mapBatchResponse(frames([10, 11]), [
			{ index: '10' as unknown as number, description: 'string id' },
			{ index: 10.5, description: 'fractional id' },
			{ index: NaN, description: 'not a number' },
			{ index: 11, description: 'ok' }
		])
		expect(result.described.map((d) => d.index)).toEqual([11])
		expect(result.missing.map((f) => f.index)).toEqual([10])
	})

	it('survives an empty, missing or null response', () => {
		for (const items of [undefined, null, []]) {
			const result = mapBatchResponse(frames([10, 11]), items)
			expect(result.described).toEqual([])
			expect(result.missing).toHaveLength(2)
		}
	})

	it('never returns more descriptions than frames asked about', () => {
		const result = mapBatchResponse(frames([10]), [
			{ index: 10, description: 'ok' },
			{ index: 11, description: 'extra' },
			{ index: 12, description: 'extra' }
		])
		expect(result.described).toHaveLength(1)
		expect(result.unknown).toEqual([11, 12])
	})

	it('trims whitespace off descriptions', () => {
		const result = mapBatchResponse(frames([10]), [{ index: 10, description: '  padded\n' }])
		expect(result.described[0].description).toBe('padded')
	})
})
