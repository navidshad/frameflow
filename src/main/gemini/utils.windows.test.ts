import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'

const mocks = vi.hoisted(() => ({
	uploadFile: vi.fn(),
	transcribeWords: vi.fn()
}))

vi.mock('../settings', () => ({
	settingsManager: {
		getModelSettings: () => ({ selection: { 'raw-transcript': 'gemini-3.5-transcribe', 'corrected-transcript': 'gemini-3.5-transcribe' } }),
		getGeminiApiKey: () => 'test-key'
	}
}))
vi.mock('../ffmpeg', () => ({
	measureLoudness: async () => [],
	extractAudioSegment: async (_src: string, _start: number, _len: number, out: string) => { fs.writeFileSync(out, 'x') }
}))
vi.mock('./adapter', () => ({
	GeminiAdapter: { create: () => ({ uploadFile: mocks.uploadFile, transcribeWords: mocks.transcribeWords }) }
}))

import { extractTranscript, WORD_WINDOW_CONCURRENCY } from './utils'
import type { TranscriptProgress } from './transcript-progress'

/** 100 minutes of audio: four word windows with no pauses to cut at (25 min each). */
const DURATION = 6000
const record = { usage: { promptTokens: 1, candidatesTokens: 1, thinkingTokens: 0, totalTokens: 2 }, cost: 0.01 }
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

/** The window a call is for, read back from the uri it was given. */
const windowOf = (uri: string) => Number(uri.replace('uri-', ''))

beforeEach(() => {
	mocks.uploadFile.mockReset()
	mocks.transcribeWords.mockReset()
	let n = 0
	mocks.uploadFile.mockImplementation(async () => `uri-${n++}`)
})

describe('extractTranscript, word windows', () => {
	it('runs windows at the same time, up to the named limit', async () => {
		let inFlight = 0
		let peak = 0
		mocks.transcribeWords.mockImplementation(async () => {
			peak = Math.max(peak, ++inFlight)
			await tick(); await tick()
			inFlight--
			return { words: [{ start: 1, end: 2, text: 'hi' }], text: 'hi', record }
		})
		await extractTranscript('/audio.mp3', DURATION)
		expect(peak).toBe(WORD_WINDOW_CONCURRENCY)
		expect(mocks.transcribeWords).toHaveBeenCalledTimes(4)
	})

	it('keeps the windows in order on the source clock even when a later one finishes first', async () => {
		mocks.transcribeWords.mockImplementation(async (_model: string, uri: string) => {
			const w = windowOf(uri)
			// The first window is the slowest to answer.
			for (let i = 0; i < (w === 0 ? 8 : 1); i++) await tick()
			return { words: [{ start: 10, end: 11, text: `w${w}` }], text: `text-${w}`, record }
		})
		const out = await extractTranscript('/audio.mp3', DURATION)
		expect(out.items.map((i) => i.text)).toEqual(['w0', 'w1', 'w2', 'w3'])
		// Window starts are 0, 1500, 3000, 4500: each word sits 10 s into its window.
		expect(out.items.map((i) => i.start)).toEqual(['00:00:10,000', '00:25:10,000', '00:50:10,000', '01:15:10,000'])
		const texts = [...out.rawResponseText.matchAll(/text-(\d)/g)].map((m) => m[1])
		expect(texts).toEqual(['0', '1', '2', '3'])
		expect(out.record.cost).toBeCloseTo(0.04)
	})

	it('reports done/total and what each window is doing, ending finished', async () => {
		mocks.transcribeWords.mockImplementation(async () => {
			await tick()
			return { words: [{ start: 1, end: 2, text: 'hi' }], text: 'hi', record }
		})
		const reports: TranscriptProgress[] = []
		await extractTranscript('/audio.mp3', DURATION, undefined, undefined, (p) => reports.push({ ...p, active: [...p.active] }))

		expect(reports[0]).toMatchObject({ done: 0, total: 4, active: [] })
		expect(reports.some((r) => r.active.includes('uploading'))).toBe(true)
		expect(reports.some((r) => r.active.length === WORD_WINDOW_CONCURRENCY && r.active.every((a) => a === 'transcribing'))).toBe(true)
		const done = reports.map((r) => r.done)
		expect(done).toEqual([...done].sort((a, b) => a - b))
		expect(reports[reports.length - 1]).toMatchObject({ done: 4, total: 4, active: [], finishing: true })
	})

	it('stops the other windows when one hits the quota, and throws that error', async () => {
		const quota = Object.assign(new Error('429 RESOURCE_EXHAUSTED: quota exceeded'), { status: 429 })
		const signals: AbortSignal[] = []
		mocks.transcribeWords.mockImplementation(async (_model: string, uri: string, _d: number, signal: AbortSignal) => {
			signals.push(signal)
			if (windowOf(uri) === 1) { await tick(); throw quota }
			// The healthy windows are still "on the phone" when the failure lands.
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
			})
			throw new Error('unreachable')
		})
		await expect(extractTranscript('/audio.mp3', DURATION)).rejects.toMatchObject({
			message: quota.message, model: 'gemini-3.5-transcribe'
		})
		// Three started (the limit), none after the failure.
		expect(mocks.transcribeWords).toHaveBeenCalledTimes(3)
		expect(signals.every((s) => s.aborted)).toBe(true)
	})

	it('stops the other windows when the caller cancels', async () => {
		const outer = new AbortController()
		mocks.transcribeWords.mockImplementation(async (_m: string, _u: string, _d: number, signal: AbortSignal) => {
			outer.abort()
			await tick()
			if (signal.aborted) throw new Error('Aborted')
			return { words: [], text: '', record }
		})
		await expect(extractTranscript('/audio.mp3', DURATION, undefined, outer.signal)).rejects.toThrow('Aborted')
		expect(mocks.transcribeWords.mock.calls.length).toBeLessThanOrEqual(WORD_WINDOW_CONCURRENCY)
	})

	it('sends a short file as one window and says so', async () => {
		mocks.transcribeWords.mockResolvedValue({ words: [{ start: 1, end: 2, text: 'hello' }], text: 'hello', record })
		const reports: TranscriptProgress[] = []
		const out = await extractTranscript('/audio.mp3', 300, undefined, undefined, (p) => reports.push({ ...p }))
		expect(out.items).toHaveLength(1)
		expect(reports.every((r) => r.total === 1)).toBe(true)
		expect(mocks.uploadFile).toHaveBeenCalledWith('/audio.mp3', 'audio/mpeg')
	})
})
