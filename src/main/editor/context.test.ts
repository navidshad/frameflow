import { describe, expect, it } from 'vitest'
import type { Clip, EditorDocument, MediaAsset, Track } from '@shared/types'
import { buildPromptContext, CONTEXT_CHAR_BUDGET, CONTEXT_CHAR_BUDGET_LONGFORM, SILENCE_TEXT } from './context'

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
	text.split('\n').filter((line) => /^\d+\|/.test(line))

describe('buildPromptContext', () => {
	// The reported project: 1899 pieces across ~92 minutes.
	const doc = makeDoc([transcriptAsset('a', 377), transcriptAsset('b', 1449), transcriptAsset('c', 73)])
	const opts = { selectedItemIds: [], playheadSec: 0 }

	it('shows a longform persona every piece, with the transcript, inside budget', () => {
		const result = buildPromptContext(doc, 'make a long podcast', { ...opts, mode: 'longform' })

		expect(sceneRows(result.contextText)).toHaveLength(1899)
		expect(result.contextText).toContain('so the thing about piece 1 is')
		expect(result.contextText).toContain(SILENCE_TEXT)
		expect(result.contextText.length).toBeLessThan(CONTEXT_CHAR_BUDGET_LONGFORM)
		expect(result.truncated).toBe(false)
		// Transcript counts as real signal — the "describe scenes" nudge must not fire.
		expect(result.thinContext).toBe(false)
	})

	it('keeps the summarize persona on the original per-asset cap and budget', () => {
		const result = buildPromptContext(doc, 'cut me a teaser', { ...opts, mode: 'summarize' })

		// 60 per asset at rung 0; the ladder may tighten further, never loosen.
		expect(sceneRows(result.contextText).length).toBeLessThanOrEqual(180)
		expect(result.contextText.length).toBeLessThan(CONTEXT_CHAR_BUDGET)
	})

	it('degrades content before piece numbers on a very long project', () => {
		const huge = makeDoc([transcriptAsset('a', 4000)])
		const result = buildPromptContext(huge, 'build the full thing', { ...opts, mode: 'longform' })

		// Every piece stays addressable even though descriptions had to shrink.
		expect(sceneRows(result.contextText)).toHaveLength(4000)
		expect(result.contextText.length).toBeLessThan(CONTEXT_CHAR_BUDGET_LONGFORM)
	})

	it('flags thin context when nothing but silence markers exist', () => {
		const silent = transcriptAsset('a', 20)
		silent.clips = silent.clips.map((c) => ({ ...c, text: SILENCE_TEXT }))
		const result = buildPromptContext(makeDoc([silent]), 'clean this up', { ...opts, mode: 'longform' })

		expect(result.thinContext).toBe(true)
	})

	it('shows the recording window when the container carried a creation time', () => {
		const a = transcriptAsset('a', 5)
		const b = transcriptAsset('b', 5)
		// Two consecutive segments of one recording, imported in reverse order.
		b.metadata = { ...b.metadata, duration: 600, recordedAt: Date.UTC(2026, 6, 17, 17, 55, 20) } as any
		a.metadata = { ...a.metadata, duration: 600, recordedAt: Date.UTC(2026, 6, 17, 17, 45, 20) } as any
		const result = buildPromptContext(makeDoc([b, a]), 'build it', { ...opts, mode: 'longform' })

		expect(result.contextText).toContain('recorded 2026-07-17T17:55:20Z–2026-07-17T18:05:20Z')
		expect(result.contextText).toContain('recorded 2026-07-17T17:45:20Z–2026-07-17T17:55:20Z')
		expect(result.contextText).toContain('listed in IMPORT order')
		expect(result.contextText).toContain('parallel camera angles')
	})

	it('says nothing about recording order when no asset carries a timestamp', () => {
		const result = buildPromptContext(doc, 'build it', { ...opts, mode: 'longform' })
		expect(result.contextText).not.toContain('recorded ')
		expect(result.contextText).not.toContain('listed in IMPORT order')
	})

	it('collapses a speech-to-text repetition loop into one honest row', () => {
		// The real failure this fixes: 1169 of 1449 pieces carrying one hallucinated
		// line, which the model reads as "nothing happens here" and deletes.
		const looped = transcriptAsset('a', 300)
		looped.clips = looped.clips.map((c, i) =>
			i >= 100 ? { ...c, text: 'the same hallucinated sentence' } : c
		)
		const result = buildPromptContext(makeDoc([looped]), 'build it', { ...opts, mode: 'longform' })

		// 100 individual rows + one group row for the 200-piece run.
		expect(sceneRows(result.contextText)).toHaveLength(100)
		const group = result.contextText.split('\n').find((l) => l.startsWith('101-300|'))
		expect(group).toBeDefined()
		expect(group).toContain('200 consecutive pieces carry the SAME transcript line')
		expect(group).toContain('the footage and timings are real')
		// Far cheaper than listing them, which is the other half of the win.
		expect(result.contextText).not.toContain('150|')
	})

	it('never lets a transcript line break the pipe table', () => {
		const nasty = transcriptAsset('a', 3)
		nasty.clips[0] = { ...nasty.clips[0], text: 'pipe | inside\nand a newline' }
		const result = buildPromptContext(makeDoc([nasty]), 'edit', { ...opts, mode: 'longform' })

		const row = sceneRows(result.contextText)[0]
		// Exactly idx|start|dur|content — the pipe and newline are neutralized.
		expect(row.split('|')).toHaveLength(4)
		expect(row).toContain('pipe inside and a newline')
	})
})
