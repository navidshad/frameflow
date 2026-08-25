import { describe, expect, it } from 'vitest'
import type { Clip, EditorDocument, MediaAsset, Track } from '@shared/types'
import {
	buildPromptContext, CONTEXT_CHAR_BUDGET, DETAIL_MAX_PIECES, EXPAND_MAX_REGIONS,
	REGION_PAD_PIECES, SILENCE_TEXT
} from './context'

/** A speech-segment asset shaped like deriveClipsFromTranscript's output. */
function transcriptAsset(id: string, count: number): MediaAsset {
	const clips: Clip[] = []
	let cursor = 0
	for (let i = 1; i <= count; i++) {
		const duration = i % 7 === 0 ? 0.9 : 1.8
		clips.push({
			id: `${id}-c${i}`,
			sourceAssetId: id,
			index: i,
			in: cursor,
			out: cursor + duration,
			duration,
			text: i % 7 === 0 ? SILENCE_TEXT : `so the thing about piece ${i} is that it keeps going for a while`,
			selected: false
		})
		cursor += duration
	}
	return {
		id, kind: 'video', name: `${id}.mp4`, originalPath: `/tmp/${id}.mp4`,
		metadata: { duration: cursor } as MediaAsset['metadata'],
		preprocessing: {}, clips, createdAt: 0
	}
}

function makeDoc(assets: MediaAsset[]): EditorDocument {
	const track: Track = {
		id: 'v1', kind: 'video', name: 'V1', order: 0,
		muted: false, locked: false, hidden: false, height: 72
	}
	return {
		schemaVersion: 1, media: assets, tracks: [track], timeline: [],
		timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 0 },
		activePersonaId: 'podcast-editor', turns: [],
		historyRef: { currentStepId: 'step-0', stepCount: 0 }
	}
}

const sceneRows = (text: string) =>
	text.split('\n').filter((line) => /^\d+(-\d+)?\|/.test(line))

/**
 * Rows per asset section as index ranges. `a-b|` rows span, `n|` rows are
 * single — the invariant the survey must uphold is that these ranges TILE each
 * asset's piece numbers: no piece silently disappears, none is shown twice.
 */
const rowRangesByAsset = (text: string) => {
	const byAsset = new Map<string, { from: number; to: number }[]>()
	let current = ''
	for (const line of text.split('\n')) {
		const header = line.match(/^Asset (\S+) "/)
		if (header) {
			current = header[1]
			if (!byAsset.has(current)) byAsset.set(current, [])
			continue
		}
		const row = line.match(/^(\d+)(?:-(\d+))?\|/)
		if (row && current) {
			byAsset.get(current)!.push({ from: +row[1], to: +(row[2] ?? row[1]) })
		}
	}
	return byAsset
}

const expectTiling = (ranges: { from: number; to: number }[], count: number) => {
	let next = 1
	for (const range of ranges) {
		expect(range.from).toBe(next)
		expect(range.to).toBeGreaterThanOrEqual(range.from)
		next = range.to + 1
	}
	expect(next).toBe(count + 1)
}

describe('buildPromptContext', () => {
	// The reported project shape: 1899 pieces across ~92 minutes.
	const doc = makeDoc([transcriptAsset('a', 377), transcriptAsset('b', 1449), transcriptAsset('c', 73)])
	const opts = { selectedItemIds: [], playheadSec: 0 }

	// The row-count inversion of the old tests moved UP a level: intent still
	// never sizes the context, but the SOURCE does. Above DETAIL_MAX_PIECES the
	// table is a condensed survey — bounded rows — while every piece number
	// stays derivable (tiling) and every silent piece stays individually
	// nameable for excludeScenes.
	it('condenses a large source into a bounded survey with every piece still addressable', () => {
		const result = buildPromptContext(doc, 'make a long podcast', { ...opts })

		expect(result.band).toBe('survey')
		expect(result.pieceCount).toBe(1899)
		const rows = sceneRows(result.contextText)
		expect(rows.length).toBeGreaterThan(100)
		expect(rows.length).toBeLessThan(700)
		expect(result.contextText.length).toBeLessThan(CONTEXT_CHAR_BUDGET)
		expect(result.truncated).toBe(false)
		expect(result.thinContext).toBe(false)

		// Tiling: the row ranges of each asset cover 1..N with no gaps or overlaps.
		const ranges = rowRangesByAsset(result.contextText)
		expectTiling(ranges.get('a')!, 377)
		expectTiling(ranges.get('b')!, 1449)
		expectTiling(ranges.get('c')!, 73)
	})

	it('keeps every silent piece individually nameable in the survey', () => {
		const result = buildPromptContext(doc, 'clean it up', { ...opts })

		// Fixture silences are isolated singles, so each must appear either as a
		// "#idx(secs)" entry in some group row's [sil ...] tail, or (at an asset
		// tail) as its own [Silence] row.
		const text = result.contextText
		const assetSections = text.split(/^Asset /m).slice(1)
		for (const section of assetSections) {
			const count = section.match(/^\S+ "[^"]+" \(\S+s, (\d+) pieces\)/)?.[1]
			if (!count) continue
			const silenceIdx = new Set<number>()
			for (const match of section.matchAll(/#(\d+)\(/g)) silenceIdx.add(+match[1])
			for (const line of section.split('\n')) {
				const single = line.match(/^(\d+)\|.*\[Silence\]/)
				if (single) silenceIdx.add(+single[1])
				const run = line.match(/^(\d+)-(\d+)\|.*\[Silence x\d+\]/)
				if (run) for (let i = +run[1]; i <= +run[2]; i++) silenceIdx.add(i)
			}
			for (let i = 7; i <= +count; i += 7) {
				expect(silenceIdx.has(i), `silence piece #${i} nameable`).toBe(true)
			}
		}
	})

	it('collapses a long silence run into one range row', () => {
		const silentStretch = transcriptAsset('a', 700)
		silentStretch.clips = silentStretch.clips.map((c, i) =>
			i >= 100 && i < 160 ? { ...c, text: SILENCE_TEXT } : c
		)
		const result = buildPromptContext(makeDoc([silentStretch]), 'build it', { ...opts })

		expect(result.band).toBe('survey')
		// Pieces 101-160 were silenced above; fixture piece 161 (a multiple of 7)
		// is silent anyway, so the run the emitter sees is 101-161.
		const row = result.contextText.split('\n').find((l) => /^101-161\|/.test(l))
		expect(row).toBeDefined()
		expect(row).toContain('[Silence x61]')
		expectTiling(rowRangesByAsset(result.contextText).get('a')!, 700)
	})

	it('builds the same context whatever the request asks for', () => {
		const strip = (text: string) => text.slice(0, text.indexOf('USER REQUEST'))
		const long = buildPromptContext(doc, 'make a long podcast', { ...opts })
		const short = buildPromptContext(doc, 'cut me a 30 second teaser', { ...opts })

		// Byte-equal up to the USER REQUEST tail — nothing about the material is
		// hidden or condensed based on how long the output is meant to be.
		expect(strip(short.contextText)).toBe(strip(long.contextText))

		const small = makeDoc([transcriptAsset('a', 80)])
		const smallLong = buildPromptContext(small, 'make a long podcast', { ...opts })
		const smallShort = buildPromptContext(small, 'cut me a 30 second teaser', { ...opts })
		expect(strip(smallShort.contextText)).toBe(strip(smallLong.contextText))
	})

	it('shows every piece in full at the band boundary, and condenses one past it', () => {
		const atLimit = buildPromptContext(
			makeDoc([transcriptAsset('a', DETAIL_MAX_PIECES)]), 'edit', { ...opts })
		expect(atLimit.band).toBe('full')
		expect(sceneRows(atLimit.contextText)).toHaveLength(DETAIL_MAX_PIECES)
		// Full band means full transcript rows, not gists.
		expect(atLimit.contextText).toContain('so the thing about piece 599 is that it keeps going')

		const past = buildPromptContext(
			makeDoc([transcriptAsset('a', DETAIL_MAX_PIECES + 1)]), 'edit', { ...opts })
		expect(past.band).toBe('survey')
		expect(sceneRows(past.contextText).length).toBeLessThan(DETAIL_MAX_PIECES)
	})

	// The band metric is IN-SCOPE pieces, so what the scope chip promises is
	// what the model gets: a chapter over one small asset of a huge project
	// still reads that asset in full.
	it('keeps full detail when the scope narrows to a small asset of a big project', () => {
		const big = transcriptAsset('big', 1400)
		const smallAsset = transcriptAsset('small', 90)
		const docWithItems = makeDoc([big, smallAsset])
		docWithItems.timeline = [{
			id: 'item-1', trackId: 'v1', sourceAssetId: 'small', sourceClipId: 'small-c1',
			timelineStart: 0, in: 0, out: 1.8, duration: 1.8, speed: 1, preservePitch: true, label: ''
		}]
		docWithItems.timelineMeta.duration = 1.8
		const result = buildPromptContext(docWithItems, 'tighten this', {
			selectedItemIds: ['item-1'], playheadSec: 0
		})

		expect(result.scope.kind).toBe('selection')
		expect(result.pieceCount).toBe(90)
		expect(result.band).toBe('full')
	})

	it('degrades content before piece numbers on a very long project', () => {
		const huge = makeDoc([transcriptAsset('a', 4000)])
		const result = buildPromptContext(huge, 'build the full thing', { ...opts })

		expect(result.band).toBe('survey')
		const rows = sceneRows(result.contextText)
		// Bounded rows regardless of source size — this is the point of the band.
		expect(rows.length).toBeLessThan(400)
		expect(result.contextText.length).toBeLessThan(CONTEXT_CHAR_BUDGET)
		expect(result.truncated).toBe(false)
		expectTiling(rowRangesByAsset(result.contextText).get('a')!, 4000)
		// Survey rows still carry signal (the old ladder ended in empty cells).
		expect(result.contextText).toContain('so the thing about piece')
	})

	describe('expandRegions (detail pass)', () => {
		const single = makeDoc([transcriptAsset('a', 1000)])

		it('expands a requested span to one row per piece, padded, survey elsewhere', () => {
			const result = buildPromptContext(single, 'make a highlight', {
				...opts, expandRegions: [{ assetId: 'a', fromPiece: 100, toPiece: 150 }]
			})

			expect(result.expandedRegions).toBe(1)
			expect(result.expandedPieces).toBe(51 + 2 * REGION_PAD_PIECES)
			const lines = result.contextText.split('\n')
			// Padded bounds are per-piece rows with their transcript…
			expect(lines.some((l) => l.startsWith(`${100 - REGION_PAD_PIECES}|`))).toBe(true)
			expect(lines.some((l) => l.startsWith('100|'))).toBe(true)
			expect(result.contextText).toContain('so the thing about piece 100 is')
			// …the piece before the pad is not.
			expect(lines.some((l) => l.startsWith(`${99 - REGION_PAD_PIECES}|`))).toBe(false)
			expect(result.contextText).toContain('DETAIL VIEW')
			expectTiling(rowRangesByAsset(result.contextText).get('a')!, 1000)
		})

		it('clamps an over-eager span and trims to the detail budget, never silently', () => {
			const result = buildPromptContext(single, 'make a highlight', {
				...opts, expandRegions: [{ assetId: 'a', fromPiece: 0, toPiece: 99999 }]
			})

			expect(result.expandedPieces).toBe(DETAIL_MAX_PIECES)
			expect(result.contextText).toContain('detail budget ran out')
			expectTiling(rowRangesByAsset(result.contextText).get('a')!, 1000)
		})

		it('merges overlapping spans instead of double-spending the budget', () => {
			const result = buildPromptContext(single, 'make a highlight', {
				...opts,
				expandRegions: [
					{ assetId: 'a', fromPiece: 100, toPiece: 200 },
					{ assetId: 'a', fromPiece: 150, toPiece: 250 }
				]
			})

			// One merged 100..250 span (padded), not 101+101 pieces.
			expect(result.expandedPieces).toBe(151 + 2 * REGION_PAD_PIECES)
			const seen = new Set<number>()
			for (const range of rowRangesByAsset(result.contextText).get('a')!) {
				for (let i = range.from; i <= range.to; i++) {
					expect(seen.has(i), `piece ${i} listed once`).toBe(false)
					seen.add(i)
				}
			}
		})

		it('ignores an unknown asset with a note and keeps the survey working', () => {
			const result = buildPromptContext(single, 'make a highlight', {
				...opts, expandRegions: [{ assetId: 'nope', fromPiece: 1, toPiece: 50 }]
			})

			expect(result.expandedPieces).toBe(0)
			expect(result.expandedRegions).toBe(0)
			expect(result.contextText).toContain('unknown asset')
			expectTiling(rowRangesByAsset(result.contextText).get('a')!, 1000)
		})

		it('refuses non-numeric bounds with a note instead of a #NaN span', () => {
			const result = buildPromptContext(single, 'make a highlight', {
				...opts, expandRegions: [{ assetId: 'a', fromPiece: 100 } as any]
			})

			expect(result.expandedRegions).toBe(0)
			expect(result.expandedPieces).toBe(0)
			expect(result.contextText).toContain('non-numeric bounds')
			expect(result.contextText).not.toContain('NaN')
		})

		it('honors at most EXPAND_MAX_REGIONS spans', () => {
			const regions = Array.from({ length: EXPAND_MAX_REGIONS + 4 }, (_, i) => ({
				assetId: 'a', fromPiece: i * 60 + 1, toPiece: i * 60 + 10
			}))
			const result = buildPromptContext(single, 'make a highlight', { ...opts, expandRegions: regions })

			expect(result.expandedRegions).toBe(EXPAND_MAX_REGIONS)
			expect(result.contextText).toContain(`first ${EXPAND_MAX_REGIONS}`)
		})
	})

	it('flags thin context when nothing but silence markers exist', () => {
		const silent = transcriptAsset('a', 20)
		silent.clips = silent.clips.map((c) => ({ ...c, text: SILENCE_TEXT }))
		const result = buildPromptContext(makeDoc([silent]), 'clean this up', { ...opts })

		expect(result.thinContext).toBe(true)
	})

	it('shows the recording window when the container carried a creation time', () => {
		const a = transcriptAsset('a', 5)
		const b = transcriptAsset('b', 5)
		// Two consecutive segments of one recording, imported in reverse order.
		b.metadata = { ...b.metadata, duration: 600, recordedAt: Date.UTC(2026, 6, 17, 17, 55, 20) } as any
		a.metadata = { ...a.metadata, duration: 600, recordedAt: Date.UTC(2026, 6, 17, 17, 45, 20) } as any
		const result = buildPromptContext(makeDoc([b, a]), 'build it', { ...opts })

		expect(result.contextText).toContain('recorded 2026-07-17T17:55:20Z–2026-07-17T18:05:20Z')
		expect(result.contextText).toContain('recorded 2026-07-17T17:45:20Z–2026-07-17T17:55:20Z')
		expect(result.contextText).toContain('listed in IMPORT order')
		expect(result.contextText).toContain('parallel camera angles')
	})

	it('says nothing about recording order when no asset carries a timestamp', () => {
		const result = buildPromptContext(doc, 'build it', { ...opts })
		expect(result.contextText).not.toContain('recorded ')
		expect(result.contextText).not.toContain('listed in IMPORT order')
	})

	it('collapses a speech-to-text repetition loop into one honest row (full band)', () => {
		// The real failure this fixes: hundreds of pieces carrying one
		// hallucinated line, which the model reads as "nothing happens here".
		const looped = transcriptAsset('a', 300)
		looped.clips = looped.clips.map((c, i) =>
			i >= 100 ? { ...c, text: 'the same hallucinated sentence' } : c
		)
		const result = buildPromptContext(makeDoc([looped]), 'build it', { ...opts })

		// 100 individual rows + one group row for the 200-piece run.
		expect(sceneRows(result.contextText)).toHaveLength(101)
		const group = result.contextText.split('\n').find((l) => l.startsWith('101-300|'))
		expect(group).toBeDefined()
		expect(group).toContain('200 consecutive pieces carry the SAME transcript line')
		expect(group).toContain('the footage and timings are real')
		// Far cheaper than listing them, which is the other half of the win.
		expect(result.contextText).not.toContain('150|')
	})

	it('keeps the repetition-loop row honest in the survey band too', () => {
		const looped = transcriptAsset('a', 700)
		looped.clips = looped.clips.map((c, i) =>
			i >= 100 ? { ...c, text: 'the same hallucinated sentence' } : c
		)
		const result = buildPromptContext(makeDoc([looped]), 'build it', { ...opts })

		expect(result.band).toBe('survey')
		const row = result.contextText.split('\n').find((l) => l.startsWith('101-700|'))
		expect(row).toBeDefined()
		expect(row).toContain('600 consecutive pieces carry the SAME transcript line')
		// No survey group swallows any part of the run.
		expectTiling(rowRangesByAsset(result.contextText).get('a')!, 700)
	})

	it('never lets a transcript line break the pipe table', () => {
		const nasty = transcriptAsset('a', 3)
		nasty.clips[0] = { ...nasty.clips[0], text: 'pipe | inside\nand a newline' }
		const result = buildPromptContext(makeDoc([nasty]), 'edit', { ...opts })

		const row = sceneRows(result.contextText)[0]
		// Exactly idx|start|dur|content — the pipe and newline are neutralized.
		expect(row.split('|')).toHaveLength(4)
		expect(row).toContain('pipe inside and a newline')
	})
})
