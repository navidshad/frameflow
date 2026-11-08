import { describe, expect, it } from 'vitest'
import type { EditorDocument, MediaAsset, Message, Thread, TimelineItem } from '@shared/types'
import type { GrayFrame } from '@shared/thumbnail'
import { createThumbnailProject, thumbnailTitle, type ThumbnailDeps } from './project'

// ---- fakes: no ffmpeg, no disk, no key ----
const gray = (f: (x: number, y: number) => number): GrayFrame => {
	const data = new Uint8Array(32 * 18)
	for (let y = 0; y < 18; y++) for (let x = 0; x < 32; x++) data[y * 32 + x] = f(x, y)
	return { width: 32, height: 18, data }
}
const BLACK = gray(() => 0)
const SHARP = gray((x, y) => ((x + y) % 2 ? 200 : 60))

const media = (id: string, duration = 120): MediaAsset => ({
	id, kind: 'video', name: id, originalPath: `/media/${id}.mp4`, preprocessing: {}, clips: [], createdAt: 0,
	metadata: { duration, width: 1920, height: 1080, size: 1, codec: 'h264', fps: 30, format: 'mp4', hasAudio: true }
})
const clip = (id: string, assetId: string, start: number, inn: number, out: number): TimelineItem => ({
	id, trackId: 'V1', sourceAssetId: assetId, timelineStart: start, in: inn, out, speed: 1, preservePitch: true, duration: out - inn
})
const editor = (over: Partial<EditorDocument> = {}): EditorDocument => ({
	schemaVersion: 2,
	media: [media('a')],
	tracks: [{ id: 'V1', kind: 'video', name: 'V1', order: 0, muted: false, locked: false, hidden: false, height: 64 }],
	timeline: [clip('i', 'a', 0, 0, 120)],
	timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 120 },
	turns: [], historyRef: { currentStepId: '', stepCount: 0 },
	...over
})
const videoThread = (title: string, doc: EditorDocument = editor()): Thread => ({
	id: 'vid', title, type: 'editor', preprocessing: {}, tempDir: '/tmp/vid', messages: [], editor: doc, createdAt: 0, updatedAt: 0
})

function harness(video: Thread | null, opts: {
	gray?: (sec: number) => GrayFrame | null
	stillFails?: (sec: number) => boolean
	key?: boolean
	transcripts?: Record<string, { start: number; end: number; text: string }[]>
} = {}) {
	const calls = { stills: [] as string[], created: [] as { title: string; images: string[] }[], messages: [] as string[], analysed: [] as string[] }
	const deps: ThumbnailDeps = {
		getThread: (id) => (video && id === video.id ? video : null),
		transcripts: () => opts.transcripts ?? {},
		grabGray: async (_src, sec) => (opts.gray ? opts.gray(sec) : SHARP),
		grabStill: async (_src, sec, out) => {
			if (opts.stillFails?.(sec)) throw new Error('boom')
			calls.stills.push(out)
		},
		stagingDir: () => '/tmp/vid/thumbnail',
		createImageProject: async (title, images) => {
			calls.created.push({ title, images })
			return { id: 'img', title, type: 'image', preprocessing: { sourceImages: images }, tempDir: '/tmp/img', messages: [], createdAt: 0, updatedAt: 0 }
		},
		addUserMessage: async (_id, text): Promise<Message> => {
			calls.messages.push(text)
			return { id: 'm1', role: 'user' as Message['role'], content: text, isPending: false, createdAt: 0 }
		},
		hasGeminiKey: () => opts.key ?? true,
		startAnalysis: (id) => { calls.analysed.push(id) }
	}
	return { deps, calls }
}

describe('createThumbnailProject', () => {
	it('names the project after the video and seeds it with the chosen frames and a brief', async () => {
		const { deps, calls } = harness(videoThread('I quit my job'))
		const r = await createThumbnailProject('vid', deps)
		expect(r.thread.id).toBe('img')
		expect(calls.created[0].title).toBe('I quit my job – Thumbnail')
		expect(calls.created[0].images).toHaveLength(3)
		expect(calls.created[0].images[0]).toMatch(/frame-1-/)
		expect(calls.messages[0]).toContain('"I quit my job"')
		expect(r.userMessageId).toBe('m1')
		expect(r.headline).toEqual({ text: 'I quit my job', source: 'title' })
		expect(calls.analysed).toEqual(['img'])
	})

	it('never seeds a black frame as the best one', async () => {
		// 12 midpoints of 0..120: 5, 15, 25 ... Black everywhere except 35, 65 and 95.
		const good = new Set([35, 65, 95])
		const { deps, calls } = harness(videoThread('Rome'), { gray: (sec) => (good.has(sec) ? SHARP : BLACK) })
		const r = await createThumbnailProject('vid', deps)
		expect(r.frames.map((f) => f.sourceSec).sort((a, b) => a - b)).toEqual([35, 65, 95])
		expect(calls.stills).toHaveLength(3)
	})

	it('spreads picks across the cut rather than taking neighbouring frames', async () => {
		const { deps } = harness(videoThread('Rome'))
		const r = await createThumbnailProject('vid', deps)
		const times = r.frames.map((f) => f.sourceSec).sort((a, b) => a - b)
		for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(12)
	})

	it('survives frames that cannot be read or saved', async () => {
		const { deps, calls } = harness(videoThread('Rome'), {
			gray: (sec) => (sec < 60 ? null : SHARP),
			stillFails: (sec) => sec === 65
		})
		const r = await createThumbnailProject('vid', deps)
		expect(r.frames.every((f) => f.sourceSec !== 65 && f.sourceSec >= 60)).toBe(true)
		expect(calls.created[0].images.length).toBe(r.frames.length)
		expect(r.frames.length).toBeGreaterThan(0)
	})

	it('draws the headline from the transcript when the title says nothing', async () => {
		const { deps, calls } = harness(videoThread('Untitled Project'), {
			transcripts: { a: [{ start: 1, end: 4, text: 'Hello. Why did nobody tell me this?' }] }
		})
		const r = await createThumbnailProject('vid', deps)
		expect(r.headline).toEqual({ text: 'Why did nobody tell me this?', source: 'transcript' })
		expect(calls.messages[0]).toContain('"Why did nobody tell me this?"')
	})

	it('ignores speech the edit cut away', async () => {
		const doc = editor({ timeline: [clip('i', 'a', 0, 50, 70)] })
		const { deps } = harness(videoThread('Untitled Project', doc), {
			transcripts: { a: [{ start: 1, end: 4, text: 'Why did the cut lose this?' }] }
		})
		const r = await createThumbnailProject('vid', deps)
		expect(r.headline.source).toBe('none')
	})

	it('reports whether a Gemini key is configured, and still builds the project without one', async () => {
		const { deps, calls } = harness(videoThread('Rome'), { key: false })
		const r = await createThumbnailProject('vid', deps)
		expect(r.hasGeminiKey).toBe(false)
		expect(calls.messages).toHaveLength(1) // the message waits in the project for Retry
	})

	it('refuses clearly when there is nothing to take a frame from', async () => {
		const empty = videoThread('Rome', editor({ media: [], timeline: [] }))
		await expect(createThumbnailProject('vid', harness(empty).deps)).rejects.toThrow(/Add a video/)
		await expect(createThumbnailProject('vid', harness(null).deps)).rejects.toThrow(/not a video project/)
		const image = { ...videoThread('x'), type: 'image' as const, editor: undefined }
		await expect(createThumbnailProject('vid', harness(image).deps)).rejects.toThrow(/not a video project/)
	})

	it('creates no project when no frame can be read', async () => {
		const { deps, calls } = harness(videoThread('Rome'), { gray: () => null })
		await expect(createThumbnailProject('vid', deps)).rejects.toThrow(/Could not read any frames/)
		expect(calls.created).toHaveLength(0)
	})

	it('creates no project when no frame can be saved', async () => {
		const { deps, calls } = harness(videoThread('Rome'), { stillFails: () => true })
		await expect(createThumbnailProject('vid', deps)).rejects.toThrow(/Could not save a frame/)
		expect(calls.created).toHaveLength(0)
	})

	it('titles an unnamed video sensibly', () => {
		expect(thumbnailTitle('  ')).toBe('Untitled Project – Thumbnail')
	})
})
