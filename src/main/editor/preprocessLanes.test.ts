import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaAsset, Thread } from '@shared/types'

/**
 * The two import lanes, with the real orchestrator and everything it calls
 * replaced by something this test can hold still: the proxy and the
 * transcript each wait on a gate, so the order things happen in is the thing
 * under test (words never wait for the proxy; thumbnails wait for BOTH; a
 * lane that fails leaves the other running, and resumes alone).
 */

const h = vi.hoisted(() => {
	const state = {
		thread: null as any,
		tasks: new Map<string, any>(),
		calls: [] as string[],
		gates: {} as Record<string, { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void }>
	}
	return state
})

function gate(name: string) {
	let resolve!: () => void, reject!: (e: Error) => void
	const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
	promise.catch(() => {}) // a gate may be rejected before the step reaches it
	h.gates[name] = { promise, resolve, reject }
}

vi.mock('../threads', () => ({ threadManager: { getThread: () => h.thread } }))
vi.mock('../tasks', () => ({
	backgroundTaskManager: { updateTask: async (_t: string, id: string, u: any) => { h.tasks.set(id, { ...(h.tasks.get(id) || {}), ...u }) } }
}))
vi.mock('../settings', () => ({ settingsManager: { getModelSettings: () => ({ selection: {} }) } }))
vi.mock('../gemini/transcript-errors', () => ({ explainTranscriptError: (m: string) => `explained: ${m}` }))
vi.mock('../gemini/scene-descriptions', () => ({ MIN_DESCRIBABLE_DURATION: 1 }))
vi.mock('../ffmpeg/proxyTags', () => ({ tagProxyForMonitor: async () => false }))
vi.mock('./assets', () => ({
	getAssetDir: (thread: any, id: string) => path.join(thread.tempDir, 'media', id),
	patchAsset: async (_t: string, id: string, patch: any) => {
		const i = h.thread.editor.media.findIndex((a: any) => a.id === id)
		const current = h.thread.editor.media[i]
		h.thread.editor.media[i] = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
	},
	patchAssetPreprocessing: async (_t: string, id: string, patch: any) => {
		const a = h.thread.editor.media.find((m: any) => m.id === id)
		a.preprocessing = { ...a.preprocessing, ...patch }
	}
}))
vi.mock('../ffmpeg', () => ({
	isVideoLowResolution: async () => false,
	toLowResolution: async (file: string, dir: string) => {
		h.calls.push('proxy')
		await h.gates.proxy.promise
		const out = path.join(dir, 'proxy_480p.mov'); fs.writeFileSync(out, 'p'); return out
	},
	toLeanAudio: async (file: string, dir: string) => {
		h.calls.push(`audio from ${file}`)
		const out = path.join(dir, 'a.mp3'); fs.writeFileSync(out, 'a'); return out
	},
	generateFilmstrip: async () => { h.calls.push('filmstrip'); return [] },
	extractFrame: async (_v: string, t: number, dir: string) => {
		h.calls.push('thumbnail')
		const out = path.join(dir, `f_${t}.jpg`); fs.writeFileSync(out, 'j'); return out
	}
}))
vi.mock('../scenedetect', () => ({
	SceneDetector: class {
		async detectScenes() {
			h.calls.push('scenes')
			return [{ startTime: 0, endTime: 5, duration: 5 }, { startTime: 5, endTime: 10, duration: 5 }]
		}
	}
}))
vi.mock('../pipeline/phases/extraction', () => ({
	timingSidecarPath: (p: string) => p + '.timing.json',
	extractRawTranscript: async (_d: any, context: any) => {
		h.calls.push('transcript')
		await h.gates.transcript.promise
		const dir = path.join(context.tempDir, 'transcripts'); fs.mkdirSync(dir, { recursive: true })
		const file = path.join(dir, 'raw.json')
		fs.writeFileSync(file, JSON.stringify([
			{ start: '00:00:00,000', end: '00:00:04,000', text: 'hello there' },
			{ start: '00:00:04,000', end: '00:00:09,000', text: 'general kenobi' }
		]))
		await context.savePreprocessing({ rawTranscriptPath: file, transcriptPath: file })
	}
}))

import { abortAssetPreprocessing, preparingLanes, preprocessMediaAsset } from './preprocess'

let tmp = ''
const flush = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)) }
const asset = (): MediaAsset => h.thread.editor.media[0]
const spoken = () => asset().clips.map((c) => c.text).filter((t) => t !== '[Silence]')
const settle = async (p: Promise<void>) => { await p; await flush() }

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-lanes-'))
	const original = path.join(tmp, 'IMG_1.MOV'); fs.writeFileSync(original, 'v')
	h.tasks.clear(); h.calls.length = 0
	for (const name of ['proxy', 'transcript']) gate(name)
	h.thread = {
		id: 't', type: 'editor', tempDir: tmp,
		editor: { media: [{
			id: 'a', kind: 'video', name: 'IMG_1.MOV', originalPath: original, preprocessing: {}, clips: [], createdAt: 0,
			metadata: { duration: 10, width: 3840, height: 2160, size: 1, codec: 'hevc', fps: 30, format: 'mov', hasAudio: true },
			preprocessState: 'pending'
		}] }
	} as unknown as Thread
})
afterEach(() => {
	abortAssetPreprocessing('t', 'a') // a failed test must not leave a live run for the next one
	fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the two import lanes', () => {
	it('starts the audio and the transcript at once, from the ORIGINAL, while the proxy is still running', async () => {
		const run = preprocessMediaAsset('t', 'a')
		await flush()
		expect(h.calls).toContain(`audio from ${asset().originalPath}`)
		expect(h.calls).toContain('transcript')
		expect(h.calls).toContain('proxy')
		// Nothing of the picture lane that needs the proxy has started.
		expect(h.calls).not.toContain('filmstrip')
		expect(preparingLanes('t', 'a').sort()).toEqual(['picture', 'words'])
		expect(asset().preprocessState).toBe('running')

		h.gates.transcript.resolve()
		await flush()
		// The words lane is done and the pieces exist while the proxy is still being made.
		expect(asset().prepLanes).toMatchObject({ words: { state: 'completed' }, picture: { state: 'running' } })
		expect(spoken()).toEqual(['hello there', 'general kenobi'])
		expect(asset().preprocessState).toBe('running')
		expect(preparingLanes('t', 'a')).toEqual(['picture'])

		h.gates.proxy.resolve()
		await settle(run)
		expect(asset().preprocessState).toBe('completed')
		expect(asset().proxyPath).toMatch(/proxy_480p/)
		expect(h.calls.filter((c) => c === 'thumbnail')).toHaveLength(3) // two statements and the silence after them
		expect(preparingLanes('t', 'a')).toEqual([])
	})

	it('holds the thumbnails until the pieces exist, even though the proxy and scenes are done', async () => {
		const run = preprocessMediaAsset('t', 'a')
		h.gates.proxy.resolve()
		await flush()
		// The picture lane got as far as it can: proxy, filmstrip, scene detection.
		expect(h.calls).toEqual(expect.arrayContaining(['proxy', 'filmstrip', 'scenes']))
		expect(h.calls).not.toContain('thumbnail')
		expect(asset().clips).toHaveLength(0) // and scenes did NOT make pieces ahead of the transcript

		h.gates.transcript.resolve()
		await settle(run)
		expect(h.calls.filter((c) => c === 'thumbnail')).toHaveLength(3) // two statements and the silence after them
		// Pieces came from the speech, not the scenes.
		expect(spoken()).toEqual(['hello there', 'general kenobi'])
		expect(asset().preprocessState).toBe('completed')
	})

	it('falls back to scene pieces when the transcript fails, without failing the import', async () => {
		const run = preprocessMediaAsset('t', 'a')
		h.gates.proxy.resolve()
		await flush()
		h.gates.transcript.reject(new Error('quota exceeded'))
		await settle(run)
		expect(asset().prepLanes).toMatchObject({ words: { state: 'completed' }, picture: { state: 'completed' } })
		expect(asset().transcriptError).toMatch(/quota exceeded/)
		expect(asset().clips.map((c) => [c.in, c.out])).toEqual([[0, 5], [5, 10]])
		expect(asset().preprocessState).toBe('completed')
	})

	it('a failed proxy leaves the transcript running, and the summary only says error once both have ended', async () => {
		const run = preprocessMediaAsset('t', 'a')
		await flush()
		h.gates.proxy.reject(new Error('VideoToolbox said no'))
		await flush()
		// The picture lane failed; the words lane is still working and must not be hidden.
		expect(asset().prepLanes).toMatchObject({ words: { state: 'running' }, picture: { state: 'error', error: expect.stringMatching(/VideoToolbox/) } })
		expect(asset().preprocessState).toBe('running')
		expect(preparingLanes('t', 'a')).toEqual(['words'])

		h.gates.transcript.resolve()
		await settle(run)
		expect(asset().prepLanes).toMatchObject({ words: { state: 'completed' }, picture: { state: 'error' } })
		expect(spoken()).toEqual(['hello there', 'general kenobi'])
		expect(asset().preprocessState).toBe('error')
		expect(asset().preprocessError).toMatch(/VideoToolbox/)
		expect(h.calls).not.toContain('thumbnail') // no frames to cut from
	})

	it('resumes the failed lane alone: the transcript is not asked for again', async () => {
		const run = preprocessMediaAsset('t', 'a')
		await flush()
		h.gates.proxy.reject(new Error('VideoToolbox said no'))
		h.gates.transcript.resolve()
		await settle(run)
		expect(asset().preprocessState).toBe('error')
		const before = h.calls.filter((c) => c === 'transcript' || c.startsWith('audio')).length

		gate('proxy'); h.gates.proxy.resolve()
		await settle(preprocessMediaAsset('t', 'a')) // the Retry button: not-done lanes only
		expect(h.calls.filter((c) => c === 'transcript' || c.startsWith('audio')).length).toBe(before)
		expect(asset().prepLanes).toMatchObject({ words: { state: 'completed' }, picture: { state: 'completed' } })
		expect(asset().preprocessState).toBe('completed')
		expect(h.calls.filter((c) => c === 'thumbnail')).toHaveLength(3) // two statements and the silence after them
	})

	it('resumes one interrupted lane while the other is left as it is', async () => {
		// The app quit mid-run: both lanes stored as running, nothing live; the words lane had finished its work.
		Object.assign(asset(), {
			preprocessState: 'running', prepLanes: { words: { state: 'running' }, picture: { state: 'running' } }
		})
		h.gates.proxy.resolve(); h.gates.transcript.resolve()
		await settle(preprocessMediaAsset('t', 'a', { lane: 'picture' }))
		expect(h.calls).not.toContain('transcript')
		expect(asset().prepLanes).toMatchObject({ words: { state: 'running' }, picture: { state: 'completed' } })
		expect(asset().preprocessState).toBe('running') // the transcript lane is still not done

		await settle(preprocessMediaAsset('t', 'a', { lane: 'words' }))
		expect(asset().prepLanes).toMatchObject({ words: { state: 'completed' }, picture: { state: 'completed' } })
		expect(asset().preprocessState).toBe('completed')
	})

	it('does not start a lane that is already running', async () => {
		const run = preprocessMediaAsset('t', 'a')
		await flush()
		await preprocessMediaAsset('t', 'a') // a second click
		expect(h.calls.filter((c) => c === 'proxy')).toHaveLength(1)
		expect(h.calls.filter((c) => c === 'transcript')).toHaveLength(1)
		h.gates.proxy.resolve(); h.gates.transcript.resolve()
		await settle(run)
	})

	it('Transcribe again while the proxy runs takes only the words lane', async () => {
		const run = preprocessMediaAsset('t', 'a')
		h.gates.transcript.resolve()
		await flush()
		expect(preparingLanes('t', 'a')).toEqual(['picture'])
		gate('transcript'); h.gates.transcript.resolve()
		await settle(preprocessMediaAsset('t', 'a', { steps: ['audio', 'transcript'] }))
		expect(h.calls.filter((c) => c === 'transcript')).toHaveLength(2)
		expect(preparingLanes('t', 'a')).toEqual(['picture']) // the proxy was never disturbed
		h.gates.proxy.resolve()
		await settle(run)
		expect(asset().preprocessState).toBe('completed')
	})

	it('skips both words steps for a video with no sound, and still finishes', async () => {
		asset().metadata!.hasAudio = false
		const run = preprocessMediaAsset('t', 'a')
		h.gates.proxy.resolve()
		await settle(run)
		expect(h.calls.some((c) => c.startsWith('audio') || c === 'transcript')).toBe(false)
		expect(h.tasks.get('a:transcript')).toMatchObject({ state: 'completed', status: 'No audio track' })
		expect(asset().clips.length).toBeGreaterThan(0) // pieces from scenes
		expect(asset().preprocessState).toBe('completed')
	})

	it('keeps sound on its one chain, without lanes', async () => {
		Object.assign(asset(), { kind: 'audio', metadata: { duration: 10, width: 0, height: 0, size: 1, codec: 'mp3', fps: 0, format: 'mp3', hasAudio: true } })
		// segment step needs ffmpeg silence detection: not mocked, so it fails softly into the interval fallback
		await settle(preprocessMediaAsset('t', 'a')).catch(() => {})
		expect(asset().prepLanes).toBeUndefined()
	})
})
