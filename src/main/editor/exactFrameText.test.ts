import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import type { EditorDocument, MediaAsset, TimelineItem, Track } from '@shared/types'
// Importing the module is what points fluent-ffmpeg at the bundled binary and
// teaches it that `lavfi` is a usable input — exactly what the app does at startup.
import { getFFmpegBinaryPath } from '../ffmpeg'

/**
 * `render_frame` (the MCP tool) must show an agent its own titles; the
 * monitor's exact-frame view must NOT burn them in, because it draws titles
 * itself above the picture and a burned copy would show every one twice.
 * Both go through renderExactFrame, so this drives the real function with the
 * real ffmpeg and measures the brightest pixel (not the mean: lettering covers
 * a small share of the frame and a 1x1 average rounds it to black).
 */

let tempDir = ''
vi.mock('../threads', () => ({
	threadManager: { getThread: () => ({ type: 'editor', tempDir }) }
}))

const execFileAsync = promisify(execFile)
const ffmpeg = getFFmpegBinaryPath()

const maxLuma = async (file: string): Promise<number> => {
	const { stdout } = await execFileAsync(ffmpeg,
		['-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-'],
		{ encoding: 'buffer', maxBuffer: 1 << 24 })
	return (stdout as unknown as Buffer).reduce((max, v) => (v > max ? v : max), 0)
}

const vtrack: Track = { id: 'v1', kind: 'video', name: 'V1', order: 0, muted: false, locked: false, hidden: false, height: 72 }
const ttrack: Track = { id: 't1', kind: 'video', name: 'T1', order: 1, muted: false, locked: false, hidden: false, height: 72 }

describe('renderExactFrame burnText', () => {
	let source = ''
	let doc: EditorDocument
	let renderExactFrame: typeof import('./preview').renderExactFrame

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(join(tmpdir(), 'ff-exact-'))
		source = join(tempDir, 'black.mp4')
		await execFileAsync(ffmpeg, [
			'-y', '-v', 'error',
			'-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=4:r=30',
			'-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
			'-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '4', source
		])
		const asset: MediaAsset = {
			id: 'sa', kind: 'video', name: 'sa', originalPath: source,
			metadata: { duration: 4, width: 320, height: 180, fps: 30, hasAudio: true } as MediaAsset['metadata'],
			preprocessing: {}, clips: [], createdAt: 0
		}
		const clip: TimelineItem = {
			id: 'c', trackId: 'v1', sourceAssetId: 'sa', timelineStart: 0, in: 0, out: 4, speed: 1, preservePitch: true, duration: 4
		}
		const title: TimelineItem = {
			id: 'ttl', trackId: 't1', sourceAssetId: '', timelineStart: 0, in: 0, out: 3, speed: 1, preservePitch: true,
			duration: 3, text: { content: 'GERMANY 2025', size: 0.2 }
		}
		doc = {
			schemaVersion: 1, media: [asset], tracks: [vtrack, ttrack], timeline: [clip, title],
			timelineMeta: { fps: 30, width: 320, height: 180, duration: 4 },
			activePersonaId: 'podcast-editor', turns: [], historyRef: { currentStepId: 's', stepCount: 0 }
		}
		;({ renderExactFrame } = await import('./preview'))
	}, 60_000)

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it('the monitor path (default) leaves the picture clean: the monitor draws the title itself', async () => {
		const { path } = await renderExactFrame({ threadId: 't', doc, timeSec: 1.5 })
		expect(await maxLuma(path)).toBeLessThan(24)
	}, 60_000)

	it('the MCP path (burnText) puts the title in the picture', async () => {
		const { path } = await renderExactFrame({ threadId: 't', doc, timeSec: 1.5, burnText: true })
		expect(await maxLuma(path)).toBeGreaterThan(200)
	}, 60_000)

	it('burnText leaves a frame with no title on screen untouched', async () => {
		const { path } = await renderExactFrame({ threadId: 't', doc, timeSec: 3.6, burnText: true })
		expect(await maxLuma(path)).toBeLessThan(24)
	}, 60_000)
})
