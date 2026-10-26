import { app, shell, BrowserWindow, ipcMain, dialog, protocol } from 'electron'
import { net } from 'electron'
import * as fs from 'fs'
import { basename, dirname, extname, join } from 'path'
import { pathToFileURL } from 'url'
import { Pipeline } from './pipeline'
import { settingsManager } from './settings'
import { threadManager } from './threads'
import type { DeliveryFormat, EditorDocument, MulticamGroup, TimelineItem } from '@shared/types'
import { pruneOrphanItems } from '@shared/timeline'
import * as extraction from './pipeline/phases/extraction'
import * as supply from './pipeline/phases/supply'

import * as imageIntent from './pipeline/phases/image-intent'
import * as imageGeneration from './pipeline/phases/image-generation'
import { backgroundTaskManager } from './tasks'
import { GeminiAdapter } from './gemini/adapter'

import { buildCameraGroup } from './multicam/group'
import { diarizeGroup } from './multicam/diarize'
import { checkFFmpegAvailability, getVideoMetadata, detectSilence } from './ffmpeg'
import { checkYtDlpAvailability, downloadVideo, getVideoFormats } from './ytdlp'
import { dependencyManager } from './dependencies/manager'
import { checkYtDlpFreshness } from './dependencies/ytdlp-updater'
import * as editorAssets from './editor/assets'
import { importMediaFromFile, importMediaFromUrl } from './editor/importMedia'
import { getAudioAnalysis } from './editor/audioAnalysis'
import { ensureSoundAsset, previewSound } from './editor/synth'
import { isSoundKind } from '../shared/synth'
import { estimateUsd, generateForProject, providerStatuses, voicesFor } from './audio/runtime'
import { normalizeAudioSettings, isProviderId, type GenerateRequest } from '../shared/audioProviders'
import * as editorPreprocess from './editor/preprocess'
import * as editorHistory from './editor/history'
import * as editorPrompt from './editor/prompt'
import * as editorPreview from './editor/preview'
import * as editorRender from './editor/render'
import * as editorCaptions from './editor/captions'
import { listExportFiles, resolveExportPath } from './editor/exports'
import { loadPacks, packManifests } from './editor/packs'
import * as editorRevisions from './editor/revisions'
import { BUILTIN_PERSONAS } from './constants/personas'
import { v4 as uuidv4 } from 'uuid'
import { THREAD_DIRS } from './constants/paths'
import { GEMINI_MODEL_3_6_FLASH, MODEL_METADATA } from './constants/gemini'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerMediaProtocol } from './media-protocol'
import { initAgentAccess } from './mcp'
import { agentHolding } from './mcp/roundStore'
import { isCliEngine, type CliEngineId } from '@shared/engines'
import { checkProjectsFolder, nestProjectsFolder, suggestProjectsFolder } from './setup/folder'
import { testGeminiKey } from './setup/geminiKey'
import { buildChecks } from '../shared/setup'
import { normalizeEngineSettings } from '@shared/engines'
import { execFile } from 'child_process'
import { getFFmpegBinaryPath } from './ffmpeg'
import { initMotionIpc } from './motion/ipc'
import { abortEngineTurn, cliEngineSelected, initEngines, runCliEditorPrompt } from './engine'

const activePipelines = new Map<string, Pipeline>()

// Electron 43 made every dialog open in Downloads when `defaultPath` is absent,
// and stopped the OS remembering where the user was last. Importing a second
// clip from the same shoot used to land you back in that folder; without this
// it lands you in Downloads every time. Remembered for the session only.
let lastBrowsedDir: string | undefined

const rememberBrowsedDir = (filePath: string | undefined): void => {
	if (filePath) lastBrowsedDir = dirname(filePath)
}

protocol.registerSchemesAsPrivileged([
	{
		scheme: 'media',
		privileges: {
			secure: true,
			supportFetchAPI: true,
			bypassCSP: true,
			stream: true,
			standard: true,
			corsEnabled: true
		}
	}
])

function createWindow(): void {
	const mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		show: false,
		autoHideMenuBar: true,
		webPreferences: {
			preload: join(__dirname, '../preload/index.cjs'),
			sandbox: false
		}
	})

	mainWindow.on('ready-to-show', () => {
		mainWindow.show()
	})

	mainWindow.webContents.setWindowOpenHandler((details) => {
		shell.openExternal(details.url)
		return { action: 'deny' }
	})

	if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
		mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
	} else {
		mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
	}
}

app.whenReady().then(() => {
	// Set correct appId before any path resolution if possible, 
	// though getPath might already have been called/cached.
	electronApp.setAppUserModelId('com.frameflow.app')

	// Initialize managers that depend on app paths
	settingsManager.init()
	threadManager.init()

	backgroundTaskManager.init()

	// Effect packs, before any window can ask for the catalogue. Never fatal —
	// a broken pack on disk must not stop the app opening.
	try {
		loadPacks()
	} catch (error) {
		console.warn('[packs] load failed:', error)
	}

	app.on('browser-window-created', (_, window) => {
		optimizer.watchWindowShortcuts(window)
	})

	// Register custom protocol for local media
	registerMediaProtocol()

	// MCP agent access: off unless the user turned it on in Settings.
	initAgentAccess()
	initMotionIpc()
	initEngines()

	createWindow()

	// Proactive weekly yt-dlp freshness check (throttled to ~7 days inside via
	// a marker file). Fire-and-forget: must never block or crash startup.
	checkYtDlpFreshness().catch((error) => {
		console.warn('[main] yt-dlp freshness check failed:', error)
	})

	ipcMain.handle('select-video', async () => {
		const result = await dialog.showOpenDialog({
			defaultPath: lastBrowsedDir,
			properties: ['openFile'],
			filters: [
				{ name: 'Media', extensions: ['mp4', 'avi', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'] },
				{ name: 'Videos', extensions: ['mp4', 'avi', 'mov', 'webm'] },
				{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'] }
			]
		})

		if (result.canceled || result.filePaths.length === 0) {
			return null
		}

		rememberBrowsedDir(result.filePaths[0])
		return {
			path: result.filePaths[0],
			name: result.filePaths[0].split('/').pop() || ''
		}
	})

	ipcMain.handle('show-open-dialog', async (_event, options) => {
		const result = await dialog.showOpenDialog({ defaultPath: lastBrowsedDir, ...options })
		if (!result.canceled) rememberBrowsedDir(result.filePaths[0])
		return result
	})

	ipcMain.handle('check-system-requirements', async () => {
		const [ffmpegAvailable, ytDlpAvailable] = await Promise.all([
			checkFFmpegAvailability(),
			checkYtDlpAvailability()
		])
		return {
			ffmpegAvailable,
			ytDlpAvailable,
			ytDlpStatus: dependencyManager.getStatus('yt-dlp'),
			isTempDirUnsafe: settingsManager.isTempDirUnsafe()
		}
	})

	ipcMain.handle('install-dependency', async (_event, name: string) => {
		if (name === 'yt-dlp') {
			await dependencyManager.installYtDlp()
			return await checkYtDlpAvailability()
		}
		return false
	})

	ipcMain.handle('get-dependency-status', (_event, name: string) => {
		return dependencyManager.getStatus(name)
	})

	ipcMain.handle('get-video-metadata', async (_event, filePath: string) => {
		return await getVideoMetadata(filePath)
	})

	ipcMain.handle('fetch-video-formats', async (_event, url: string) => {
		return await getVideoFormats(url)
	})

	ipcMain.handle('download-video', async (event, url: string, resolution?: string) => {
		const tempDir = join(settingsManager.getTempDir(), `download-${Date.now()}`)
		if (!fs.existsSync(tempDir)) {
			fs.mkdirSync(tempDir, { recursive: true })
		}
		return await downloadVideo(url, tempDir, resolution, (percent) => {
			event.sender.send('download-progress', percent)
		})
	})

	ipcMain.handle('is-temp-dir-unsafe', () => {
		return settingsManager.isTempDirUnsafe()
	})

	ipcMain.handle('debug-log', (_event, ...args: any[]) => {
		console.log('[FRONTEND LOG]', ...args)
	})

	ipcMain.handle('start-pipeline', async (event, { threadId, newAiMessageId, isThinkingMode, autoUseImages }) => {
		console.log(`\n===============\n[DEBUG IPC] start-pipeline called: threadId=${threadId}, newAiMessageId=${newAiMessageId}, isThinkingMode=${isThinkingMode}, autoUseImages=${autoUseImages}`)
		const window = BrowserWindow.fromWebContents(event.sender)
		if (!window) {
			console.log(`[DEBUG IPC] FAILED: window not found`)
			return
		}

		const thread = threadManager.getThread(threadId)
		if (!thread) {
			console.log(`[DEBUG IPC] FAILED: thread not found`)
			return
		}

		// The newly created AI pending message links back to the user prompt via editRefId
		const aiMsg = thread.messages.find(m => m.id === newAiMessageId)
		const userMsgId = aiMsg?.editRefId
		console.log(`[DEBUG IPC] aiMsg found? ${!!aiMsg}, userMsgId=${userMsgId}`)

		// Traverse graph lineage backwards
		const { text: context, attachedImages } = threadManager.getBranchContext(threadId, userMsgId)

		// Prepare the base timeline
		const baseTimeline = userMsgId ? thread.messages.find(m => m.id === userMsgId)?.timeline : undefined;

		const pipeline = new Pipeline(window, newAiMessageId, threadId, context, baseTimeline, userMsgId, attachedImages, isThinkingMode, autoUseImages)

		// Ensure background processing is running (will resume/retry if tasks are missing/failed)
		backgroundTaskManager.startImageProcessing(threadId)

		// One chain now: the graph produces IMAGES (and thumbnails). Video output
		// lives in the timeline editor, which has its own AI path (editor/prompt.ts)
		// and produces an editable timeline rather than a rendered file.
		//
		// The inline waiter transitively covers reference-frame sampling too:
		// startImageProcessing awaits `referenceFrames` BEFORE `imageExtraction`,
		// sequentially, so a reference video's stills exist by the time this
		// resolves. Non-obvious and load-bearing.
		pipeline
			.register(async (data, ctx) => {
				await ctx.updateStatus('Waiting for image analysis...')
				await ctx.waitForTask('imageExtraction')
				ctx.next(data)
			})
			.register(imageIntent.determineImageIntent)
			// Both generation flavours run the same two phases; generateOutputImage
			// picks its model, system instruction and resultType from the intent.
			.register(supply.supplyController, { skipIf: ctx => ctx.intentResult?.type === 'text' })
			.register(imageGeneration.generateOutputImage, { skipIf: ctx => ctx.intentResult?.type === 'text' })

		console.log(`[DEBUG IPC] pipeline configured. Calling pipeline.start() in background...`)
		activePipelines.set(newAiMessageId, pipeline)

		pipeline.start({})
			.then(() => {
				console.log(`[DEBUG IPC] pipeline.start() completed successfully!`)
			})
			.catch((e) => {
				console.error(`[DEBUG IPC] pipeline.start() threw error:`, e)
			})
			.finally(() => {
				activePipelines.delete(newAiMessageId)
			})

		return true
	})

	ipcMain.handle('abort-pipeline', async (_event, messageId) => {
		console.log(`[DEBUG IPC] abort-pipeline called for messageId=${messageId}`)
		const pipeline = activePipelines.get(messageId)
		if (pipeline) {
			pipeline.abort()
			return true
		}
		return false
	})

	// ===== First-launch setup =====
	// Nothing below saves anything except setup-complete: the wizard collects
	// and checks, and Start commits it all at once.

	const ffmpegVersion = () => new Promise<string | undefined>((resolve) => {
		execFile(getFFmpegBinaryPath(), ['-version'], { timeout: 5000 }, (err, out) =>
			resolve(err ? undefined : /version\s+(\d[\d.]*)/.exec(String(out))?.[1]))
	})

	ipcMain.handle('setup-state', async () => ({
		complete: settingsManager.isSetupComplete(),
		suggestedFolder: suggestProjectsFolder(),
		home: app.getPath('home'),
		hasGeminiKey: !!settingsManager.getGeminiApiKey(),
		ffmpeg: { available: await checkFFmpegAvailability(), version: await ffmpegVersion() }
	}))

	ipcMain.handle('setup-check-folder', (_event, path: string) => checkProjectsFolder(String(path || '')))

	ipcMain.handle('setup-pick-folder', async () => {
		const result = await dialog.showOpenDialog({
			defaultPath: app.getPath('home'),
			properties: ['openDirectory', 'createDirectory']
		})
		if (result.canceled || !result.filePaths.length) return null
		const path = nestProjectsFolder(result.filePaths[0])
		return { path, check: checkProjectsFolder(path) }
	})

	ipcMain.handle('setup-test-gemini-key', (_event, key: string) => testGeminiKey(String(key || '')))

	ipcMain.handle('setup-complete', async (_event, payload: { folder: string; geminiKey: string; elevenLabsKey?: string; engine: unknown }) => {
		const folder = String(payload?.folder || '')
		const check = checkProjectsFolder(folder)
		if (!check.ok) return { ok: false, error: check.reason }
		const key = String(payload?.geminiKey || '').trim()
		if (!key) return { ok: false, error: 'A Gemini key is required.' }
		try {
			if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true })
		} catch (e: any) {
			return { ok: false, error: `Could not create the folder: ${e?.message || e}` }
		}
		if (!settingsManager.setTempDir(folder)) return { ok: false, error: 'Could not save the folder to settings.' }
		threadManager.syncWithArtifactDir()
		settingsManager.setGeminiApiKey(key)
		const eleven = String(payload?.elevenLabsKey || '').trim()
		if (eleven) settingsManager.setElevenLabsKey(eleven)
		settingsManager.updateEngineSettings(normalizeEngineSettings(payload?.engine as any))
		settingsManager.markSetupComplete()
		return { ok: true }
	})

	ipcMain.handle('is-setup-complete', () => settingsManager.isSetupComplete())

	ipcMain.handle('get-temp-dir', () => {
		return settingsManager.getTempDir()
	})

	ipcMain.handle('set-temp-dir', async () => {
		// Opening at the CURRENT store is what the nesting rule below assumes: the
		// user is expected to be able to pick the store itself. Since Electron 43
		// an absent defaultPath means Downloads, where that choice is impossible.
		const result = await dialog.showOpenDialog({
			defaultPath: settingsManager.getTempDir(),
			properties: ['openDirectory', 'createDirectory']
		})

		if (result.canceled || result.filePaths.length === 0) {
			return null
		}

		const selectedPath = result.filePaths[0]
		// Nest a "FrameFlow" folder inside the chosen directory — UNLESS the user
		// picked the store itself, which is the natural thing to do when changing
		// location (the picker opens there). Appending unconditionally produced
		// FrameFlow/FrameFlow and hid every existing project, because they live
		// under the old root.
		const newPath = basename(selectedPath) === 'FrameFlow'
			? selectedPath
			: join(selectedPath, 'FrameFlow')

		if (!fs.existsSync(newPath)) {
			fs.mkdirSync(newPath, { recursive: true })
		}

		// Report a failed write instead of leaving the app pointed at a location
		// it will forget on restart — projects created meanwhile would vanish.
		if (!settingsManager.setTempDir(newPath)) {
			throw new Error(`Could not save the storage location to settings. Projects would be lost on restart, so the change was not applied.`)
		}
		threadManager.syncWithArtifactDir()
		return newPath
	})

	ipcMain.handle('reset-temp-dir', () => {
		const path = settingsManager.resetTempDir()
		threadManager.syncWithArtifactDir()
		return path
	})

	ipcMain.handle('open-temp-dir', async () => {
		const dir = settingsManager.getTempDir()
		await shell.openPath(dir)
	})

	ipcMain.handle('get-gemini-api-key', () => {
		return settingsManager.getGeminiApiKey()
	})

	ipcMain.handle('set-gemini-api-key', (_event, key: string) => {
		settingsManager.setGeminiApiKey(key)
	})

	ipcMain.handle('get-model-settings', () => {
		return settingsManager.getModelSettings()
	})

	ipcMain.handle('set-model-settings', (_event, settings: any) => {
		settingsManager.setModelSettings(settings)
	})

	ipcMain.handle('reset-model-settings', () => {
		return settingsManager.resetModelSettings()
	})

	ipcMain.handle('get-model-metadata', () => {
		return MODEL_METADATA
	})

	// Editor personas: built-ins (code) merged with the user's global library
	ipcMain.handle('get-personas', () => {
		return [...BUILTIN_PERSONAS, ...settingsManager.getPersonas()]
	})

	ipcMain.handle('set-personas', (_event, personas: any[]) => {
		const saved = settingsManager.setPersonas(personas)
		return [...BUILTIN_PERSONAS, ...saved]
	})

	// Thread Management
	ipcMain.handle('create-thread', async (_event, { videoPath, videoName, imagePaths, type }) => {
		const newThread = await threadManager.createThread(videoPath, videoName, imagePaths, type)
		backgroundTaskManager.startImageProcessing(newThread.id)
		return newThread
	})

	// ===== Timeline Video Editor =====

	// Creates an editor project thread. Deliberately does NOT auto-start
	// preprocessing (media is imported per-asset inside the editor).
	ipcMain.handle('create-editor-project', async (_event, { title }: { title?: string }) => {
		return await threadManager.createEditorThread(title || 'Untitled Project')
	})

	ipcMain.handle('rename-editor-project', async (_event, { threadId, title }: {
		threadId: string, title: string
	}) => {
		const clean = (title || '').trim().slice(0, 120)
		if (!clean) return null
		return await threadManager.updateThread(threadId, { title: clean })
	})

	// Autosave of RENDERER-OWNED editor fields only. Main owns preprocessing-derived
	// asset state (preprocessing/proxyPath/metadata/preprocessState/clips content);
	// the renderer owns selection, clip-selected flags, tracks, timeline, meta, personas.
	// This ownership split is what prevents autosave/thread-updated echo clobbering.
	ipcMain.handle('save-editor-doc', async (_event, { threadId, patch }: {
		threadId: string
		patch: {
			tracks?: any[]
			timeline?: any[]
			timelineMeta?: any
			selection?: any
			activePersonaId?: string
			customPersonas?: any[]
			clipSelections?: Record<string, boolean>
			historyRef?: any
			markers?: any[]
			currentRevisionId?: string
			captionsEnabled?: boolean
			loudnessEnabled?: boolean
			motionKits?: any[]
			multicams?: any[]
		}
	}) => {
		return await threadManager.updateThreadWith(threadId, (thread) => {
			if (thread.type !== 'editor' || !thread.editor) return null

			const editor = { ...thread.editor }
			if (patch.tracks) editor.tracks = patch.tracks
			if (patch.timeline) {
				// A renderer that saved before it learned an asset was removed must
				// not put those clips back on disk. This closes a window the
				// renderer cannot: its 800ms autosave timer is not cancelled by a
				// removal, so a queued save can land after main has already purged.
				// Main always learns about an asset FIRST (createMediaAsset persists
				// inside the queued mutator and only then resolves the IPC), so an id
				// missing from editor.media is genuinely gone, never not-yet-known.
				const state = { tracks: editor.tracks, timeline: patch.timeline as TimelineItem[] }
				const dropped = pruneOrphanItems(state, new Set(editor.media.map((a) => a.id)))
				if (dropped.length) {
					console.warn(`[editor] save: dropped ${dropped.length} timeline item(s) with removed media`)
				}
				editor.timeline = state.timeline
			}
			if (patch.timelineMeta) editor.timelineMeta = patch.timelineMeta
			if (patch.selection) editor.selection = patch.selection
			if (patch.activePersonaId !== undefined) editor.activePersonaId = patch.activePersonaId
			if (patch.customPersonas) editor.customPersonas = patch.customPersonas
			// historyRef travels WITH the doc so the undo pointer and the timeline
			// state land in one atomic write (crash-consistent by construction).
			if (patch.historyRef) editor.historyRef = patch.historyRef
			if (patch.markers) editor.markers = patch.markers
			// Explicitly against undefined: turning captions OFF is a false, which
			// a truthiness check would silently refuse to save.
			if (patch.captionsEnabled !== undefined) editor.captionsEnabled = patch.captionsEnabled
			if (patch.loudnessEnabled !== undefined) editor.loudnessEnabled = patch.loudnessEnabled
			if (patch.currentRevisionId !== undefined) editor.currentRevisionId = patch.currentRevisionId
			if (patch.motionKits) editor.motionKits = patch.motionKits
			if (patch.multicams) editor.multicams = patch.multicams

			// Fold clip-selected flags into the matching clips (the one renderer-owned
			// field living inside main-owned MediaAsset records).
			if (patch.clipSelections) {
				editor.media = editor.media.map(asset => ({
					...asset,
					clips: asset.clips.map(clip =>
						patch.clipSelections![clip.id] !== undefined
							? { ...clip, selected: patch.clipSelections![clip.id] }
							: clip
					)
				}))
			}

			return { editor }
		})
	})

	// Import a local file as a MediaAsset and start per-asset preprocessing.
	ipcMain.handle('add-media-asset', async (_event, { threadId, filePath, name }: {
		threadId: string, filePath: string, name?: string
	}) => {
		// Reference the user's own file where it lives; move a file the app just
		// downloaded (see importMediaFromFile).
		return await importMediaFromFile(threadId, filePath, name)
	})

	// Import from URL/YouTube: download straight into the asset's source dir,
	// with per-asset progress (the legacy 'download-progress' event is keyless
	// and breaks under concurrent imports). `phase` marks self-heal detours
	// (yt-dlp auto-update + retry) so the import cards can say what is happening.
	ipcMain.handle('import-media-url', async (event, { threadId, url, resolution }: {
		threadId: string, url: string, resolution?: string
	}) => {
		return await importMediaFromUrl(threadId, url, {
			resolution,
			onProgress: (assetId, percent, phase) => {
				if (!event.sender.isDestroyed()) {
					event.sender.send('editor-import-progress', { threadId, assetId, url, percent, phase })
				}
			}
		})
	})

	ipcMain.handle('remove-media-asset', async (_event, { threadId, assetId }: {
		threadId: string, assetId: string
	}) => {
		return await editorAssets.removeAsset(threadId, assetId)
	})

	// Retry / re-run / opt-in steps (e.g. ['descriptions']) for one asset.
	// The editor asks as it opens a project: proxies made before the monitor-tagging existed
	// are tagged now, before the monitor plays them (a few seconds on the first open only).
	ipcMain.handle('ensure-proxy-tags', async (_event, threadId: string) => editorPreprocess.ensureProxyTags(String(threadId)))

	ipcMain.handle('preprocess-media', async (_event, { threadId, assetId, steps, sensitivity }: {
		threadId: string, assetId: string, steps?: string[], sensitivity?: number
	}) => {
		editorPreprocess.preprocessMediaAsset(threadId, assetId, {
			steps: steps as any,
			sensitivity
		}).catch((error) => {
			console.error(`[editor] preprocess retry failed for ${assetId}:`, error)
		})
		return true
	})

	// Remove derived Gemini data (transcript / scene descriptions) from an asset.
	ipcMain.handle('clear-asset-data', (_event, { threadId, assetId, kind }: {
		threadId: string, assetId: string, kind: 'transcript' | 'descriptions'
	}) => {
		return editorAssets.clearAssetData(threadId, assetId, kind)
	})

	// Scene-piece corrections (§5.2): merge adjacent pieces / split further.
	ipcMain.handle('merge-clips', (_event, { threadId, assetId, clipIds }: {
		threadId: string, assetId: string, clipIds: string[]
	}) => {
		return editorAssets.mergeClips(threadId, assetId, clipIds)
	})

	ipcMain.handle('split-clip', (_event, { threadId, assetId, clipId, atSec }: {
		threadId: string, assetId: string, clipId: string, atSec?: number
	}) => {
		return editorAssets.splitClip(threadId, assetId, clipId, atSec)
	})

	// Assistive silence/dead-air finder (§5.6). Read-only analysis over the
	// asset's proxy/original — returns candidate source-time ranges the user
	// reviews before applying as ripple-deletes. Never mutates media.
	// Sync recordings of one moment into a camera group, by their sound. The
	// group comes back unsaved: the renderer commits it as an undoable edit,
	// the same way an agent's make_multicam does.
	ipcMain.handle('multicam-build', async (event, { threadId, assetIds, existing, name }: {
		threadId: string, assetIds: string[], existing?: MulticamGroup, name?: string
	}) => {
		const media = threadManager.getThread(threadId)?.editor?.media
		if (!media) return { ok: false, error: 'That project is not open.' }
		try {
			const { group, ranking } = await buildCameraGroup(media, assetIds, {
				existing, name,
				onProgress: (fraction, label) => {
					if (!event.sender.isDestroyed()) event.sender.send('multicam-progress', { threadId, fraction, label })
				}
			})
			return { ok: true, group, ranking }
		} catch (e: any) {
			return { ok: false, error: e?.message || String(e) }
		}
	})

	// Find who speaks when in a camera group, by sound. The speakers come back unsaved: the renderer
	// commits them as an undoable edit, as an agent's find_speakers does.
	ipcMain.handle('multicam-speakers', async (event, { threadId, group, speakers }: {
		threadId: string, group: MulticamGroup, speakers?: number
	}) => {
		const media = threadManager.getThread(threadId)?.editor?.media
		if (!media) return { ok: false, error: 'That project is not open.' }
		try {
			const found = await diarizeGroup(group, media, {
				speakers, keepFrom: group.speakers,
				onProgress: (fraction, label) => {
					if (!event.sender.isDestroyed()) event.sender.send('multicam-progress', { threadId, fraction, label })
				}
			})
			return { ok: true, speakers: found }
		} catch (e: any) {
			return { ok: false, error: e?.message || String(e) }
		}
	})

	ipcMain.handle('find-silence', async (event, { threadId, assetId, noiseDb, minDurationSec }: {
		threadId: string, assetId: string, noiseDb?: number, minDurationSec?: number
	}) => {
		const asset = threadManager.getThread(threadId)?.editor?.media.find((a) => a.id === assetId)
		if (!asset) throw new Error('Asset not found')
		if (asset.metadata && asset.metadata.hasAudio === false) return []
		const source = asset.proxyPath || asset.originalPath
		let lastPercent = -1
		return await detectSilence(source, { noiseDb, minDurationSec }, undefined, (percent) => {
			if (percent - lastPercent < 2 && percent !== 100) return
			lastPercent = percent
			if (!event.sender.isDestroyed()) {
				event.sender.send('editor-silence-progress', { assetId, percent })
			}
		})
	})

	// A source's waveform and loudness, measured once and cached beside the
	// asset. Read-only: it never touches the media or the document.
	ipcMain.handle('editor-audio-analysis', async (_event, { threadId, assetId }: { threadId: string, assetId: string }) => {
		const thread = threadManager.getThread(threadId)
		const asset = thread?.editor?.media.find((a) => a.id === assetId)
		if (!thread || !asset) throw new Error('Asset not found')
		const source = fs.existsSync(asset.originalPath) ? asset.originalPath : (asset.proxyPath || asset.originalPath)
		return await getAudioAnalysis(editorAssets.getAssetDir(thread, assetId), source, { hasAudio: asset.metadata?.hasAudio })
	})

	// Synthesised sound: a recipe rendered to a file by ffmpeg, no network. Preview
	// renders (and caches) a recipe so the palette can audition it; the asset call
	// makes it part of the project. Both are keyed by the recipe, so a repeat is free.
	ipcMain.handle('editor-sound-preview', async (_event, { threadId, recipe }: { threadId: string, recipe: { kind: string } }) => {
		if (!isSoundKind(recipe?.kind)) throw new Error(`Unknown sound: ${String(recipe?.kind)}`)
		return await previewSound(threadId, recipe as never)
	})
	ipcMain.handle('editor-sound-asset', async (_event, { threadId, recipe }: { threadId: string, recipe: { kind: string } }) => {
		if (!isSoundKind(recipe?.kind)) throw new Error(`Unknown sound: ${String(recipe?.kind)}`)
		return await ensureSoundAsset(threadId, recipe as never)
	})

	// Audio providers (voices, sound from a prompt, music). Keys never leave the
	// main process: the renderer sees only whether one is saved. A generation here
	// is the person pressing Generate, so it is not held to an agent's spend cap.
	ipcMain.handle('audio-providers-status', () => ({ providers: providerStatuses(), settings: settingsManager.getAudioSettings() }))
	ipcMain.handle('audio-set-elevenlabs-key', (_event, key: string) => {
		settingsManager.setElevenLabsKey(typeof key === 'string' ? key : '')
		return { providers: providerStatuses(), settings: settingsManager.getAudioSettings() }
	})
	ipcMain.handle('audio-update-settings', (_event, patch: unknown) => {
		const current = settingsManager.getAudioSettings()
		const next = normalizeAudioSettings({ ...current, ...(patch as object), spend: { ...current.spend, ...((patch as any)?.spend ?? {}) } })
		settingsManager.updateAudioSettings(next)
		return { providers: providerStatuses(), settings: settingsManager.getAudioSettings() }
	})
	ipcMain.handle('audio-estimate', (_event, request: GenerateRequest) => estimateUsd(request))
	ipcMain.handle('audio-voices', async (_event, provider: string) => {
		if (!isProviderId(provider)) return []
		try { return await voicesFor(provider) } catch (error) { console.warn('[audio] listing voices failed:', (error as Error).message); return [] }
	})
	// A provider's own words (bad key, out of credits) come back as text the UI can show, not as a thrown IPC error.
	ipcMain.handle('audio-generate', async (_event, { threadId, request }: { threadId: string, request: GenerateRequest }) => {
		try {
			const { asset } = await generateForProject(threadId, request)
			return { ok: true as const, asset }
		} catch (error: any) {
			return { ok: false as const, error: error?.message || 'The sound could not be made.' }
		}
	})

	// AI prompt turns (M3): one structured call per turn, streamed via
	// editor-turn-update; the base doc is never mutated until user accept.
	ipcMain.handle('run-editor-prompt', (_event, options: {
		threadId: string, personaId: string, prompt: string, baseStepId: string,
		selectedItemIds: string[], playheadSec: number, widen?: 'chapter' | 'full', engine?: CliEngineId
	}) => {
		// One agent per project: an outside agent's open round holds it.
		const holder = agentHolding(options.threadId)
		if (holder) throw new Error(holder)
		// The engine picked in Settings or the chat's engine chip: a CLI runs
		// agentically through FrameFlow's MCP tools, Gemini API as before.
		// Retry names its engine, so a switch since the failure does not move it.
		return isCliEngine(options.engine) || cliEngineSelected() ? runCliEditorPrompt(options) : editorPrompt.runEditorPrompt(options)
	})

	ipcMain.handle('abort-editor-prompt', (_event, { turnId }: { threadId: string, turnId: string }) => {
		if (!abortEngineTurn(turnId)) editorPrompt.abortEditorPrompt(turnId)
		return true
	})

	// Renderer stamps the applied history step / revision back onto the turn.
	ipcMain.handle('update-editor-turn', async (_event, { threadId, turnId, patch }: {
		threadId: string, turnId: string, patch: { resultStepId?: string, revisionId?: string }
	}) => {
		return await threadManager.updateThreadWith(threadId, (thread) => {
			if (!thread.editor) return null
			const turns = thread.editor.turns.map((t) =>
				t.id === turnId
					? {
						...t,
						resultStepId: patch.resultStepId ?? t.resultStepId,
						revisionId: patch.revisionId ?? t.revisionId
					}
					: t
			)
			return { editor: { ...thread.editor, turns } }
		})
	})

	// Export / render (M4): fast path via assembleVideo, region path via
	// segment-then-concat; progress streams over editor-render-progress.
	ipcMain.handle('export-editor-timeline', (_event, { threadId, quality, doc, format }: {
		threadId: string, quality: 'original' | 'preview', doc?: EditorDocument, format?: DeliveryFormat
	}) => {
		// `doc` is the renderer's in-memory timeline snapshot at click time —
		// the render is detached from the live document and never persists it.
		return editorRender.startEditorRender({ threadId, quality, doc, format })
	})

	ipcMain.handle('render-exact-frame', (_event, data: {
		threadId: string
		doc: EditorDocument
		timeSec: number
	}) => editorPreview.renderExactFrame(data))

	ipcMain.handle('ensure-transition-preview', (_event, data: {
		threadId: string
		doc: EditorDocument
		outgoingId: string
		incomingId: string
	}) => editorPreview.ensureTransitionPreview(data))

	// Effect packs are pure data; the renderer parses the same manifests with the
	// same parser, because an EffectDef's `build` cannot cross IPC.
	ipcMain.handle('get-effect-packs', () => packManifests())

	// The monitor draws captions itself, from the same mapper the export burns
	// with — so it needs the transcripts, not a picture of them.
	ipcMain.handle('get-editor-transcripts', (_event, threadId: string) => {
		const thread = threadManager.getThread(threadId)
		if (!thread || thread.type !== 'editor' || !thread.editor) return {}
		return editorCaptions.transcriptsForAssets(thread.editor.media)
	})

	ipcMain.handle('abort-editor-render', (_event, { renderId }: { renderId: string }) => {
		editorRender.abortEditorRender(renderId)
		return true
	})

	// Undo/redo history sidecar (renderer-authoritative; main persists)
	ipcMain.handle('get-editor-history', (_event, threadId: string) => {
		return editorHistory.loadHistory(threadId)
	})

	ipcMain.handle('push-editor-step', async (_event, { threadId, step, keyframe }: {
		threadId: string, step: any, keyframe?: any
	}) => {
		return await editorHistory.pushStep(threadId, step, keyframe)
	})

	ipcMain.handle('set-editor-history-pointer', (_event, { threadId, currentStepId }: {
		threadId: string, currentStepId: string
	}) => {
		return editorHistory.setPointer(threadId, currentStepId)
	})

	ipcMain.handle('clear-editor-history', async (_event, { threadId }: { threadId: string }) => {
		await editorHistory.clearHistory(threadId)
		return true
	})

	// Revision tree sidecar (renderer owns tree logic; main persists)
	// Summaries only: snapshots are fetched one at a time below.
	ipcMain.handle('get-editor-revisions', (_event, threadId: string) => {
		return editorRevisions.loadRevisions(threadId)
	})

	ipcMain.handle('get-editor-revision-snapshot', (_event, { threadId, revisionId }: {
		threadId: string, revisionId: string
	}) => {
		return editorRevisions.getRevisionSnapshot(threadId, revisionId)
	})

	ipcMain.handle('push-editor-revision', (_event, { threadId, revision }: {
		threadId: string, revision: any
	}) => {
		return editorRevisions.pushRevision(threadId, revision)
	})

	ipcMain.handle('replace-editor-revision', (_event, { threadId, revision }: {
		threadId: string, revision: any
	}) => {
		return editorRevisions.replaceRevision(threadId, revision)
	})

	ipcMain.handle('delete-editor-revisions', (_event, { threadId, ids }: {
		threadId: string, ids: string[]
	}) => {
		return editorRevisions.deleteRevisions(threadId, ids)
	})

	ipcMain.handle('get-all-threads', () => {
		return threadManager.getAllThreads()
	})

	ipcMain.handle('get-thread', (_event, id) => {
		return threadManager.getThread(id)
	})

	ipcMain.handle('delete-thread', (_event, id) => {
		// Editor threads: abort any live per-asset preprocessing and renders,
		// and remove the history sidecar before deletion
		const thread = threadManager.getThread(id)
		if (thread?.type === 'editor' && thread.editor) {
			for (const asset of thread.editor.media) {
				editorPreprocess.abortAssetPreprocessing(id, asset.id)
			}
			editorRender.abortRendersForThread(id)
			void editorHistory.deleteHistory(id)
			void editorRevisions.deleteRevisionsFile(id)
		}
		return threadManager.deleteThread(id)
	})

	ipcMain.handle('delete-all-threads', () => {
		return threadManager.deleteAllThreads()
	})

	ipcMain.handle('open-thread-dir', async (_event, threadId) => {
		const thread = threadManager.getThread(threadId)
		if (thread && thread.tempDir && fs.existsSync(thread.tempDir)) {
			await shell.openPath(thread.tempDir)
			return true
		}
		return false
	})

	// Finished exports of a project. Reveal/open take a path from the renderer, so
	// each one is re-checked against the thread's exports folder before acting.
	ipcMain.handle('list-editor-exports', (_event, threadId: string) => {
		const thread = threadManager.getThread(threadId)
		return thread?.tempDir ? listExportFiles(thread.tempDir) : []
	})

	ipcMain.handle('reveal-editor-export', (_event, { threadId, filePath }: { threadId: string; filePath: string }) => {
		const thread = threadManager.getThread(threadId)
		const target = thread?.tempDir ? resolveExportPath(thread.tempDir, filePath) : null
		if (!target) return false
		shell.showItemInFolder(target)
		return true
	})

	ipcMain.handle('open-editor-export', async (_event, { threadId, filePath }: { threadId: string; filePath: string }) => {
		const thread = threadManager.getThread(threadId)
		const target = thread?.tempDir ? resolveExportPath(thread.tempDir, filePath) : null
		if (!target) return false
		// openPath resolves to an error string, or '' on success.
		return (await shell.openPath(target)) === ''
	})

	ipcMain.handle('add-message', async (_event, { threadId, message }) => {
		return await threadManager.addMessageToThread(threadId, message)
	})

	ipcMain.handle('remove-message', async (_event, { threadId, messageId }) => {
		return await threadManager.removeMessageBranchFromThread(threadId, messageId)
	})
	
	ipcMain.handle('remove-single-message', async (_event, { threadId, messageId }) => {
		return await threadManager.removeSingleMessage(threadId, messageId)
	})

	ipcMain.handle('update-message', async (_event, { threadId, messageId, updates }) => {
		return await threadManager.updateMessageInThread(threadId, messageId, updates)
	})

	ipcMain.handle('save-node-positions', async (_event, { threadId, positions }) => {
		return await threadManager.updateThreadNodePositions(threadId, positions)
	})

	ipcMain.handle('toggle-reference-frame', async (_event, { threadId, filePath }) => {
		return await threadManager.toggleThreadReferenceFrame(threadId, filePath)
	})

	ipcMain.handle('show-confirmation', async (_event, { title, message, detail, type = 'question', buttons = ['Cancel', 'Yes'], defaultId = 1, cancelId = 0, checkboxLabel }) => {
		const focusedWindow = BrowserWindow.getFocusedWindow()
		if (!focusedWindow) return { response: cancelId, checkboxChecked: false }

		const result = await dialog.showMessageBox(focusedWindow, {
			type: type as any,
			buttons,
			defaultId,
			cancelId,
			title,
			message,
			detail,
			checkboxLabel
		})

		return {
			response: result.response,
			checkboxChecked: result.checkboxChecked
		}
	})

	ipcMain.handle('save-video', async (_event, sourcePath: string) => {
		const extension = extname(sourcePath)
		const fileName = basename(sourcePath)

		// A bare filename resolves against whatever the dialog's directory is, so
		// state the directory rather than inheriting it: Downloads is the right
		// destination for an export, and now it is chosen instead of defaulted.
		const result = await dialog.showSaveDialog({
			defaultPath: join(app.getPath('downloads'), fileName),
			filters: [{ name: 'Videos', extensions: [extension.replace('.', '')] }]
		})

		if (result.canceled || !result.filePath) {
			return null
		}

		try {
			fs.copyFileSync(sourcePath, result.filePath)
			return result.filePath
		} catch (error) {
			console.error('Failed to save video:', error)
			throw error
		}
	})

	ipcMain.handle('upscale-image', async (_event, { threadId, messageId, imagePath, upscaleFactor }) => {
		console.log(`[DEBUG IPC] upscale-image called: threadId=${threadId}, messageId=${messageId}, upscaleFactor=${upscaleFactor}`)
		const adapter = GeminiAdapter.create()
		const thread = threadManager.getThread(threadId)
		if (!thread) throw new Error('Thread not found')

		const filename = basename(imagePath, extname(imagePath))
		const outputFilename = `${filename}_upscale_${upscaleFactor.replace('x', '')}x_${Date.now()}.png`
		const outputPath = join(thread.tempDir, THREAD_DIRS.GENERATED_IMAGES, outputFilename)

		const modelSettings = settingsManager.getModelSettings()
		const modelName = modelSettings.selection['image-upscale']

		const result = await adapter.upscaleImage(modelName, imagePath, upscaleFactor as any, outputPath)

		// Update message metadata for persistence
		const message = thread.messages.find((m) => m.id === messageId)
		if (message && message.files) {
			const actualFile = message.files.find((f) => f.type === 'actual')
			if (actualFile) {
				console.log(`[DEBUG] Updating message ${messageId} with upscale factor ${upscaleFactor}`)
				if (upscaleFactor === 'x2') actualFile.upscale2k = result.path
				if (upscaleFactor === 'x4') actualFile.upscale4k = result.path

				await threadManager.updateMessageInThread(threadId, messageId, {
					files: message.files
				})

				// Track usage and cost
				if (result.record) {
					console.log(`[DEBUG] Tracking upscale usage for ${messageId}, cost: ${result.record.cost}`)
					await threadManager.updateMessageUsage(threadId, messageId, result.record)
				}
			} else {
				console.warn(`[DEBUG] No actual file found for message ${messageId}`)
			}
		} else {
			console.warn(`[DEBUG] Message ${messageId} not found or has no files. Looking for ID: ${messageId}`)
		}

		return result.path
	})

	ipcMain.handle('improvise-message', async (_event, { threadId, messageId }) => {
		console.log(`[DEBUG IPC] improvise-message called: threadId=${threadId}, messageId=${messageId}`)
		
		// Get the history and images leading up to this message in a single call
		const { text: context, attachedImages } = threadManager.getBranchContext(threadId, messageId)
		if (!context && !attachedImages.length) throw new Error('Message context not found')
		
		const modelSettings = settingsManager.getModelSettings()
		const modelName = modelSettings.selection['intent'] || GEMINI_MODEL_3_6_FLASH
		const adapter = GeminiAdapter.create()

		const systemInstruction = `You are a high-level Prompt Engineer. Your task is to IMPROVISE and REWRITE a user's latest prompt to be much more descriptive, detailed, and effective for high-fidelity AI generation.
- The conversation history is provided ONLY for context. You MUST NOT improve the history, only the latest prompt.
- Use the attached images for visual context to make the prompt more vivid and accurate.
- Maintain the original intent exactly.
- USE natural, descriptive, and professional language.
- DO NOT return JSON, technical metadata, coordinates, bounding boxes, or "box_2d" tags.
- DO NOT return object detection results.
- DO NOT include any explanations, labels like "Improvised:", or surrounding quotes.
- Return ONLY the clean, improved prompt text itself.`

		const userPrompt = `[CONTEXT/HISTORY]:\n${context}\n\n[TASK]: Based on the context above and the attached images, rewrite the user's latest message to be a high-performance, descriptive generation prompt. Return only the improved text.`

		const result = await adapter.generateText(modelName, userPrompt, systemInstruction, undefined, attachedImages)
		
		// Track usage for the message that initiated it
		if (result.record) {
			await threadManager.updateMessageUsage(threadId, messageId, result.record)
		}

		return result.text
	})

	app.on('activate', function () {
		if (BrowserWindow.getAllWindows().length === 0) createWindow()
	})

	app.on('before-quit', () => {
		threadManager.resetPendingMessages()
	})
})

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit()
	}
})