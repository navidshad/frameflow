import { BrowserWindow, ipcMain, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { emitTurnUpdate, persistTurn } from '../editor/prompt'
import { renderExactFrame } from '../editor/preview'
import { describeMotionReport } from '../editor/exactMotion'
import { transcriptsForAssets } from '../editor/captions'
import type { ApplyOutcome, EditorBridge, LiveProject } from './bridge'
import { ToolError } from './tools'
import { writeQueue } from './writeQueue'
import { isCaptureWindow } from '../motion/capture'
import { threadManager } from '../threads'
import { analyzeAudioFile, getAudioAnalysis, spectrogramBase64 } from '../editor/audioAnalysis'
import { ensureSoundAsset, ensureSoundFile, soundDirFor } from '../editor/synth'
import { getAssetDir } from '../editor/assets'
import { normaliseRecipe } from '../../shared/synth'
import { connectedProviders, estimateUsd, generateForProject } from '../audio/runtime'
import { settingsManager } from '../settings'
import { ProviderError } from '../audio/provider'
import { renderProgress, startEditorRender } from '../editor/render'
import { contactSheet, measureExportLoudness, probeExport, sheetClock, sheetTimes, tileImages } from '../editor/exportInspect'
import fs from 'node:fs'
import { detectSilence } from '../ffmpeg'
import { importMediaFromFile, importMediaFromUrl } from '../editor/importMedia'
import { computeContentEnd } from '../../shared/timeline'

/**
 * The bridge to the renderer, whose Pinia store owns the live timeline.
 *
 * Requests go down `mcp-request` with a correlation id and come back on
 * `mcp-response`; a renderer that never answers (reloading, hung) times out
 * rather than leaving an agent waiting forever. Writes do NOT get their own
 * channel: the turn goes down the existing `editor-turn-update` — the one the
 * built-in AI uses — carrying a `replyId`, and the store answers once
 * commitStep + createRevision have made it a revision.
 */

interface Waiter {
	resolve: (value: any) => void
	reject: (error: Error) => void
	timer: NodeJS.Timeout
}

const pending = new Map<string, Waiter>()

/** The title of the project agents last read, for "Recent agent sessions". */
export let lastProjectTitle = ''
/** Its id: where a call that reads no project of its own is recorded. */
export let lastProjectId: string | null = null

export function installRendererBridge(): void {
	ipcMain.on('mcp-response', (_event, message: { id: string; ok: boolean; result?: unknown; error?: string }) => {
		const waiter = pending.get(message?.id)
		if (!waiter) return // timed out already
		pending.delete(message.id)
		clearTimeout(waiter.timer)
		if (message.ok) waiter.resolve(message.result)
		else waiter.reject(new ToolError(message.error || 'The editor could not do that.'))
	})
}

/**
 * The window the editor runs in. Not simply the first window: while a motion
 * page is probed or rendered a hidden capture window is open too, and a request
 * sent there is never answered (the "did not answer (get-project)" timeouts
 * agents saw on back-to-back page edits).
 */
function editorWindow(): BrowserWindow {
	const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !isCaptureWindow(w))
	if (!win) throw new ToolError('FrameFlow has no window open. Ask the user to open FrameFlow.')
	return win
}

/** A read normally answers in well under a second; ten means the editor is reloading or hung. */
export const READ_TIMEOUT_MS = 10_000
/**
 * While the editor works on this process's own edits (a write queued or
 * running, or the minute after one landed, while it saves the revision and
 * re-checks new motion pages), a slow answer is expected: wait this long.
 */
export const BUSY_READ_TIMEOUT_MS = 120_000
const SETTLE_MS = 60_000

let settleUntil = 0

/** The editor is busy with work this process gave it, so it may be slow to answer. */
export function editorBusy(now = Date.now()): boolean {
	return writeQueue.busy() || now < settleUntil
}

/** Marks the editor busy for a while after a write: it is still saving and probing. */
export function noteEditorSettling(now = Date.now()): void {
	settleUntil = Math.max(settleUntil, now + SETTLE_MS)
}

/** For tests. */
export function resetEditorBusy(): void {
	settleUntil = 0
}

export function readTimeoutMs(now = Date.now()): number {
	return editorBusy(now) ? BUSY_READ_TIMEOUT_MS : READ_TIMEOUT_MS
}

function waitFor<T>(id: string, timeoutMs: number, what: string, busy = false): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id)
			const secs = Math.round(timeoutMs / 1000)
			reject(new ToolError(busy
				? `The editor did not answer (${what}) within ${secs}s. It is still busy with earlier edits (saving revisions and checking motion pages): wait a minute, then try again.`
				: `The editor did not answer (${what}) within ${secs}s. It may be busy or reloading — try again.`))
		}, timeoutMs)
		pending.set(id, { resolve, reject, timer })
	})
}

function request<T>(kind: string, payload: unknown, timeoutMs?: number): Promise<T> {
	const win = editorWindow()
	const id = randomUUID()
	const busy = editorBusy()
	const answer = waitFor<T>(id, timeoutMs ?? readTimeoutMs(), kind, busy)
	win.webContents.send('mcp-request', { id, kind, payload })
	return answer
}

/**
 * `engineTurnId` is set when FrameFlow's own CLI engine asks: the editor lets
 * the turn that is running switch revisions, which it refuses anyone else.
 */
export function switchRevisionFor(revisionId: string, engineTurnId?: string): Promise<{ ok: true } | { ok: false; error: string }> {
	return request('switch-revision', { revisionId, engineTurnId }, Math.max(20_000, readTimeoutMs()))
}

/** Agent-sized: big enough to read a lower third, small enough to send every few steps. */
const AGENT_FRAME_WIDTH = 1280
const THUMB_WIDTH = 224

export const rendererBridge: EditorBridge = {
	async getLiveProject() {
		const project = await request<LiveProject | null>('get-project', {})
		if (project) {
			lastProjectTitle = project.title
			lastProjectId = project.threadId
		}
		return project
	},

	async commitTurn(commit) {
		editorWindow()
		await persistTurn(commit.threadId, commit.turn)
		const replyId = randomUUID()
		// An auto-checkpoint, a revision push and a sidecar write — slow on a
		// project full of custom pages, and a turn that times out may still land.
		const answer = waitFor<ApplyOutcome>(replyId, BUSY_READ_TIMEOUT_MS, 'apply_ops', true)
		emitTurnUpdate({ ...commit, replyId })
		try {
			return await answer
		} finally {
			noteEditorSettling()
		}
	},

	async readTranscripts(project, assetIds) {
		const wanted = new Set(assetIds)
		return transcriptsForAssets(project.doc.media.filter((a) => wanted.has(a.id)))
	},

	async renderFrame(project, timeSec) {
		// burnText: an agent has no monitor overlay, so titles and captions must be in the picture.
		const { path, motion } = await renderExactFrame({ threadId: project.threadId, doc: project.doc, timeSec, burnText: true })
		const image = nativeImage.createFromPath(path)
		if (image.isEmpty()) throw new ToolError('The frame rendered but could not be read back. Try again.')
		const { width } = image.getSize()
		const large = width > AGENT_FRAME_WIDTH ? image.resize({ width: AGENT_FRAME_WIDTH, quality: 'good' }) : image
		const thumb = image.resize({ width: THUMB_WIDTH, quality: 'good' })
		return {
			data: large.toJPEG(85).toString('base64'),
			mimeType: 'image/jpeg',
			thumbnail: `data:image/jpeg;base64,${thumb.toJPEG(75).toString('base64')}`,
			motionNote: describeMotionReport(motion) ?? undefined
		}
	},

	switchRevision(revisionId) {
		return switchRevisionFor(revisionId)
	},

	async startExport(project, options) {
		const running = renderProgress({ threadId: project.threadId })
		if (running && (running.phase === 'rendering' || running.phase === 'stitching')) {
			return { ok: false, error: `An export of this project is already running (${running.percent}%). wait {for: "export"} follows it.` }
		}
		try {
			// The live document, as the Export button passes its snapshot: the render
			// detaches from the editor and never writes the document back.
			const { renderId } = startEditorRender({ threadId: project.threadId, quality: options.quality, doc: project.doc })
			return { ok: true, renderId }
		} catch (error: any) {
			return { ok: false, error: `The export could not start: ${error?.message || error}` }
		}
	},

	exportStatus(query) {
		const status = renderProgress(query)
		if (!status) return null
		return {
			renderId: status.renderId, phase: status.phase, percent: status.percent,
			outputPath: status.outputPath, error: status.error, startedAt: status.startedAt, updatedAt: status.updatedAt
		}
	},

	async inspectExport(file, options) {
		const facts = await probeExport(file)
		let sheet
		if (!(options.times && options.times.length === 0)) {
			const times = sheetTimes(facts.durationSec, options)
			const made = await contactSheet(file, times, { columns: options.columns, tileWidth: options.tileWidth })
			sheet = { data: made.jpeg.toString('base64'), mimeType: 'image/jpeg', times, columns: made.columns, rows: made.rows }
		}
		const loudness = options.loudness ? await measureExportLoudness(file) : undefined
		return { facts, sheet, loudness }
	},

	async mediaSheet(project, assetId, options) {
		const asset = project.doc.media.find((a) => a.id === assetId)
		if (!asset) throw new ToolError(`No media ${assetId} in this project.`)
		// The proxy is small and quick to seek; its frames are the source's frames.
		const file = asset.proxyPath && fs.existsSync(asset.proxyPath) ? asset.proxyPath : asset.originalPath
		const durationSec = asset.metadata?.duration ?? (await probeExport(file)).durationSec
		const times = sheetTimes(durationSec, options)
		const made = await contactSheet(file, times, { columns: options.columns, tileWidth: options.tileWidth })
		return { sheet: { data: made.jpeg.toString('base64'), mimeType: 'image/jpeg', times, columns: made.columns, rows: made.rows }, durationSec }
	},

	async findSilences(project, assetId, options) {
		const asset = project.doc.media.find((a) => a.id === assetId)
		if (!asset) throw new ToolError(`No media ${assetId} in this project.`)
		if (asset.metadata && asset.metadata.hasAudio === false) return []
		const regions = await detectSilence(asset.proxyPath || asset.originalPath, options)
		return regions.map((r) => ({ start: r.start, end: r.end }))
	},

	async timelineSheet(project, times, options) {
		const files: string[] = []
		const notes: (string | null)[] = []
		for (const timeSec of times) {
			const { path, motion } = await renderExactFrame({ threadId: project.threadId, doc: project.doc, timeSec, burnText: true })
			files.push(path)
			notes.push(describeMotionReport(motion) ?? null)
		}
		const made = await tileImages(files, times.map(sheetClock), options)
		return { sheet: { data: made.jpeg.toString('base64'), mimeType: 'image/jpeg', times, columns: made.columns, rows: made.rows }, notes }
	},

	async listProjects() {
		const live = await rendererBridge.getLiveProject().catch(() => null)
		return threadManager.getAllThreads()
			.filter((t) => t.type === 'editor' && t.editor && !t.missing)
			.map((t) => ({
				id: t.id, title: t.title || 'Untitled Project', createdAt: t.createdAt, updatedAt: t.updatedAt,
				mediaCount: t.editor!.media.filter((a) => !a.synth && !a.generated).length,
				durationSec: computeContentEnd(t.editor!.timeline),
				open: live?.threadId === t.id
			}))
	},

	async createProject(title) {
		const thread = await threadManager.createEditorThread(title)
		return { id: thread.id, title: thread.title }
	},

	openProject(threadId) {
		return request('open-project', { threadId }, 60_000)
	},

	async importMedia(project, source, onProgress) {
		let asset
		if ('url' in source) {
			const win = editorWindow()
			asset = await importMediaFromUrl(project.threadId, source.url, {
				onProgress: (assetId, percent, phase) => {
					// The Media panel shows the same download card it shows for the user's own import.
					if (!win.isDestroyed()) win.webContents.send('editor-import-progress', { threadId: project.threadId, assetId, url: source.url, percent, phase })
					onProgress?.(percent, phase)
				}
			})
		} else {
			asset = await importMediaFromFile(project.threadId, source.path, source.name)
		}
		if (!asset) throw new ToolError('The project is not open any more.')
		if (asset.preprocessState === 'error') throw new ToolError(`FrameFlow could not read that media: ${asset.preprocessError || 'unsupported file'}.`)
		// The renderer owns the live document; it hears of the asset before anything can place it.
		await request('upsert-assets', { assets: [asset] })
		return asset
	},

	async prepareSounds(project, recipes) {
		// Rendered one after another: each is a few tenths of a second, and the
		// asset records are written into the project one at a time.
		const assets = []
		for (const recipe of recipes) assets.push(await ensureSoundAsset(project.threadId, recipe))
		return assets
	},

	async inspectSound(project, target) {
		const thread = threadManager.getThread(project.threadId)
		if (!thread) throw new ToolError('That project is not open any more.')
		let file: string
		let renderMs: number | undefined
		if ('recipe' in target) {
			const made = await ensureSoundFile(soundDirFor(thread.tempDir), normaliseRecipe(target.recipe))
			file = made.path
			renderMs = made.cached ? undefined : made.ms
		} else {
			const asset = thread.editor?.media.find((a) => a.id === target.assetId)
			if (!asset) throw new ToolError(`No sound ${target.assetId} in this project.`)
			file = asset.originalPath
		}
		const analysis = await analyzeAudioFile(file)
		return {
			lengthSec: analysis.durationSec, truePeakDb: analysis.truePeakDb, lufs: analysis.lufs, renderMs,
			spectrogram: await spectrogramBase64(file).catch(() => undefined)
		}
	},

	async audioAnalyses(project, assetIds) {
		const thread = threadManager.getThread(project.threadId)
		const out: Record<string, import('../../shared/audio').AudioAnalysis> = {}
		for (const id of assetIds) {
			const asset = thread?.editor?.media.find((a) => a.id === id)
			if (!thread || !asset) continue
			try {
				const source = asset.originalPath
				out[id] = await getAudioAnalysis(getAssetDir(thread, id), source, { hasAudio: asset.metadata?.hasAudio })
			} catch { /* an unreadable source simply has no analysis */ }
		}
		return out
	}
	,

	audioStatus() {
		return { connected: connectedProviders(), spend: settingsManager.getAudioSettings().spend }
	},

	estimateAudio: estimateUsd,

	async generateAudio(project, req) {
		let made
		try {
			made = await generateForProject(project.threadId, req)
		} catch (error: any) {
			// A provider's own words (bad key, out of credits) are the ones to show.
			if (error instanceof ProviderError) throw new ToolError(error.message)
			throw error
		}
		// The renderer owns the live document and its autosave would drop an asset
		// it never heard of, so it is told before anything can place it.
		await request('upsert-assets', { assets: [made.asset] })
		return made
	}
}
