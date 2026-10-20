import { BrowserWindow, ipcMain, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { emitTurnUpdate, persistTurn } from '../editor/prompt'
import { renderExactFrame } from '../editor/preview'
import { transcriptsForAssets } from '../editor/captions'
import type { ApplyOutcome, EditorBridge, LiveProject } from './bridge'
import { ToolError } from './tools'
import { threadManager } from '../threads'
import { analyzeAudioFile, getAudioAnalysis, spectrogramBase64 } from '../editor/audioAnalysis'
import { ensureSoundAsset, ensureSoundFile, soundDirFor } from '../editor/synth'
import { getAssetDir } from '../editor/assets'
import { normaliseRecipe } from '../../shared/synth'

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

function editorWindow(): BrowserWindow {
	const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
	if (!win) throw new ToolError('FrameFlow has no window open. Ask the user to open FrameFlow.')
	return win
}

function waitFor<T>(id: string, timeoutMs: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id)
			reject(new ToolError(`The editor did not answer (${what}) within ${Math.round(timeoutMs / 1000)}s. It may be busy or reloading — try again.`))
		}, timeoutMs)
		pending.set(id, { resolve, reject, timer })
	})
}

function request<T>(kind: string, payload: unknown, timeoutMs = 10_000): Promise<T> {
	const win = editorWindow()
	const id = randomUUID()
	const answer = waitFor<T>(id, timeoutMs, kind)
	win.webContents.send('mcp-request', { id, kind, payload })
	return answer
}

/**
 * `engineTurnId` is set when FrameFlow's own CLI engine asks: the editor lets
 * the turn that is running switch revisions, which it refuses anyone else.
 */
export function switchRevisionFor(revisionId: string, engineTurnId?: string): Promise<{ ok: true } | { ok: false; error: string }> {
	return request('switch-revision', { revisionId, engineTurnId }, 20_000)
}

/** Agent-sized: big enough to read a lower third, small enough to send every few steps. */
const AGENT_FRAME_WIDTH = 1280
const THUMB_WIDTH = 224

export const rendererBridge: EditorBridge = {
	async getLiveProject() {
		const project = await request<LiveProject | null>('get-project', {})
		if (project) lastProjectTitle = project.title
		return project
	},

	async commitTurn(commit) {
		editorWindow()
		await persistTurn(commit.threadId, commit.turn)
		const replyId = randomUUID()
		// An auto-checkpoint, a revision push and a sidecar write: generous.
		const answer = waitFor<ApplyOutcome>(replyId, 30_000, 'apply_ops')
		emitTurnUpdate({ ...commit, replyId })
		return answer
	},

	async readTranscripts(project, assetIds) {
		const wanted = new Set(assetIds)
		return transcriptsForAssets(project.doc.media.filter((a) => wanted.has(a.id)))
	},

	async renderFrame(project, timeSec) {
		// burnText: an agent has no monitor overlay, so titles and captions must be in the picture.
		const { path } = await renderExactFrame({ threadId: project.threadId, doc: project.doc, timeSec, burnText: true })
		const image = nativeImage.createFromPath(path)
		if (image.isEmpty()) throw new ToolError('The frame rendered but could not be read back. Try again.')
		const { width } = image.getSize()
		const large = width > AGENT_FRAME_WIDTH ? image.resize({ width: AGENT_FRAME_WIDTH, quality: 'good' }) : image
		const thumb = image.resize({ width: THUMB_WIDTH, quality: 'good' })
		return {
			data: large.toJPEG(85).toString('base64'),
			mimeType: 'image/jpeg',
			thumbnail: `data:image/jpeg;base64,${thumb.toJPEG(75).toString('base64')}`
		}
	},

	switchRevision(revisionId) {
		return switchRevisionFor(revisionId)
	},

	startExport() {
		return request('export', {}, 20_000)
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
}
