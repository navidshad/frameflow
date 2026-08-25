import { contextBridge, ipcRenderer } from 'electron'
import type { ThreadType } from '@shared/types'

const api = {
	selectVideo: () => ipcRenderer.invoke('select-video'),
	fetchVideoFormats: (url: string) => ipcRenderer.invoke('fetch-video-formats', url),
	downloadVideo: (url: string, resolution?: string) => ipcRenderer.invoke('download-video', url, resolution),
	onDownloadProgress: (callback: (percent: number) => void) => {
		const listener = (_event: any, percent: number) => callback(percent)
		ipcRenderer.on('download-progress', listener)
		return () => ipcRenderer.removeListener('download-progress', listener)
	},
	checkSystemRequirements: () => ipcRenderer.invoke('check-system-requirements'),
	startPipeline: (data: { threadId: string; userPromptMessageId: string; newAiMessageId: string; editReferenceMessageId?: string }) =>
		ipcRenderer.invoke('start-pipeline', data),
	abortPipeline: (messageId: string) => ipcRenderer.invoke('abort-pipeline', messageId),
	onPipelineUpdate: (callback: (data: any) => void) => {
		const listener = (_event: any, data: any) => callback(data)
		ipcRenderer.on('pipeline-update', listener)
		return () => ipcRenderer.removeListener('pipeline-update', listener)
	},
	getBackgroundTasks: (threadId: string) => ipcRenderer.invoke('get-background-tasks', threadId),
	retryPreprocessing: (threadId: string) => ipcRenderer.invoke('retry-preprocessing', threadId),
	debugLog: (...args: any[]) => ipcRenderer.invoke('debug-log', ...args),
	onBackgroundTaskUpdate: (callback: (data: any) => void) => {
		const listener = (_event: any, data: any) => callback(data)
		ipcRenderer.on('background-task-update', listener)
		return () => ipcRenderer.removeListener('background-task-update', listener)
	},
	installDependency: (name: string) => ipcRenderer.invoke('install-dependency', name),
	getDependencyStatus: (name: string) => ipcRenderer.invoke('get-dependency-status', name),
	onDependencyUpdate: (callback: (data: any) => void) => {
		const listener = (_event: any, data: any) => callback(data)
		ipcRenderer.on('dependency-update', listener)
		return () => ipcRenderer.removeListener('dependency-update', listener)
	},
	onThreadUpdated: (callback: (thread: any) => void) => {
		const listener = (_event: any, thread: any) => callback(thread)
		ipcRenderer.on('thread-updated', listener)
		return () => ipcRenderer.removeListener('thread-updated', listener)
	},
	getTempDir: () => ipcRenderer.invoke('get-temp-dir'),
	setTempDir: () => ipcRenderer.invoke('set-temp-dir'),
	resetTempDir: () => ipcRenderer.invoke('reset-temp-dir'),
	openTempDir: () => ipcRenderer.invoke('open-temp-dir'),
	getGeminiApiKey: () => ipcRenderer.invoke('get-gemini-api-key'),
	isTempDirUnsafe: () => ipcRenderer.invoke('is-temp-dir-unsafe'),
	setGeminiApiKey: (key: string) => ipcRenderer.invoke('set-gemini-api-key', key),
	getModelSettings: () => ipcRenderer.invoke('get-model-settings'),
	setModelSettings: (settings: any) => ipcRenderer.invoke('set-model-settings', settings),
	resetModelSettings: () => ipcRenderer.invoke('reset-model-settings'),
	// Timeline Video Editor
	createEditorProject: (title?: string) => ipcRenderer.invoke('create-editor-project', { title }),
	renameEditorProject: (data: { threadId: string, title: string }) =>
		ipcRenderer.invoke('rename-editor-project', data),
	saveEditorDoc: (data: { threadId: string, patch: any }) =>
		ipcRenderer.invoke('save-editor-doc', data),
	addMediaAsset: (data: { threadId: string, filePath: string, name?: string }) =>
		ipcRenderer.invoke('add-media-asset', data),
	importMediaUrl: (data: { threadId: string, url: string, resolution?: string }) =>
		ipcRenderer.invoke('import-media-url', data),
	removeMediaAsset: (data: { threadId: string, assetId: string }) =>
		ipcRenderer.invoke('remove-media-asset', data),
	/** Fork a graph node ('root-media' or a Message.id) into a timeline project. */
	promoteToEditor: (data: { threadId: string, nodeId: string }) =>
		ipcRenderer.invoke('promote-to-editor', data),
	preprocessMedia: (data: { threadId: string, assetId: string, steps?: string[], threshold?: number }) =>
		ipcRenderer.invoke('preprocess-media', data),
	findSilence: (data: { threadId: string, assetId: string, noiseDb?: number, minDurationSec?: number }) =>
		ipcRenderer.invoke('find-silence', data),
	clearAssetData: (data: { threadId: string, assetId: string, kind: 'transcript' | 'descriptions' }) =>
		ipcRenderer.invoke('clear-asset-data', data),
	mergeClips: (data: { threadId: string, assetId: string, clipIds: string[] }) =>
		ipcRenderer.invoke('merge-clips', data),
	splitClip: (data: { threadId: string, assetId: string, clipId: string, atSec?: number }) =>
		ipcRenderer.invoke('split-clip', data),
	onEditorImportProgress: (callback: (data: { threadId: string, assetId: string, url?: string, percent: number }) => void) => {
		const listener = (_event: any, data: any) => callback(data)
		ipcRenderer.on('editor-import-progress', listener)
		return () => ipcRenderer.removeListener('editor-import-progress', listener)
	},
	onEditorSilenceProgress: (callback: (data: { assetId: string, percent: number }) => void) => {
		const listener = (_event: any, data: any) => callback(data)
		ipcRenderer.on('editor-silence-progress', listener)
		return () => ipcRenderer.removeListener('editor-silence-progress', listener)
	},
	getPersonas: () => ipcRenderer.invoke('get-personas'),
	setPersonas: (personas: any[]) => ipcRenderer.invoke('set-personas', personas),
	// `doc` = in-memory timeline snapshot at click time (render detaches from the live doc)
	exportEditorTimeline: (data: { threadId: string, quality: 'original' | 'preview', doc?: unknown }) =>
		ipcRenderer.invoke('export-editor-timeline', data),
	abortEditorRender: (data: { renderId: string }) =>
		ipcRenderer.invoke('abort-editor-render', data),
	onEditorRenderProgress: (callback: (data: any) => void) => {
		const listener = (_event: any, data: any) => callback(data)
		ipcRenderer.on('editor-render-progress', listener)
		return () => ipcRenderer.removeListener('editor-render-progress', listener)
	},
	runEditorPrompt: (data: { threadId: string, personaId: string, prompt: string, baseStepId: string, selectedItemIds: string[], playheadSec: number, widen?: string }) =>
		ipcRenderer.invoke('run-editor-prompt', data),
	abortEditorPrompt: (data: { threadId: string, turnId: string }) =>
		ipcRenderer.invoke('abort-editor-prompt', data),
	updateEditorTurn: (data: { threadId: string, turnId: string, patch: { resultStepId?: string, revisionId?: string } }) =>
		ipcRenderer.invoke('update-editor-turn', data),
	onEditorTurnUpdate: (callback: (data: any) => void) => {
		const listener = (_event: any, data: any) => callback(data)
		ipcRenderer.on('editor-turn-update', listener)
		return () => ipcRenderer.removeListener('editor-turn-update', listener)
	},
	getEditorHistory: (threadId: string) => ipcRenderer.invoke('get-editor-history', threadId),
	pushEditorStep: (data: { threadId: string, step: any, keyframe?: any }) =>
		ipcRenderer.invoke('push-editor-step', data),
	setEditorHistoryPointer: (data: { threadId: string, currentStepId: string }) =>
		ipcRenderer.invoke('set-editor-history-pointer', data),
	clearEditorHistory: (data: { threadId: string }) =>
		ipcRenderer.invoke('clear-editor-history', data),
	getEditorRevisions: (threadId: string) => ipcRenderer.invoke('get-editor-revisions', threadId),
	pushEditorRevision: (data: { threadId: string, revision: any }) =>
		ipcRenderer.invoke('push-editor-revision', data),
	deleteEditorRevisions: (data: { threadId: string, ids: string[] }) =>
		ipcRenderer.invoke('delete-editor-revisions', data),
	// Thread Management
	createThread: (data: { videoPath?: string, videoName: string, imagePaths?: string[], type?: ThreadType }) =>
		ipcRenderer.invoke('create-thread', data),
	getAllThreads: () => ipcRenderer.invoke('get-all-threads'),
	getThread: (id: string) => ipcRenderer.invoke('get-thread', id),
	deleteThread: (id: string) => ipcRenderer.invoke('delete-thread', id),
	deleteAllThreads: () => ipcRenderer.invoke('delete-all-threads'),
	addMessage: (threadId: string, message: any) =>
		ipcRenderer.invoke('add-message', { threadId, message }),
	saveNodePositions: (threadId: string, positions: Record<string, { x: number; y: number }>) =>
		ipcRenderer.invoke('save-node-positions', { threadId, positions }),
	removeMessage: (threadId: string, messageId: string) =>
		ipcRenderer.invoke('remove-message', { threadId, messageId }),
	removeSingleMessage: (threadId: string, messageId: string) =>
		ipcRenderer.invoke('remove-single-message', { threadId, messageId }),
	updateMessage: (threadId: string, messageId: string, updates: any) =>
		ipcRenderer.invoke('update-message', { threadId, messageId, updates }),
	toggleReferenceFrame: (threadId: string, filePath: string) =>
		ipcRenderer.invoke('toggle-reference-frame', { threadId, filePath }),
	showConfirmation: (options: { title: string, message: string, detail?: string, type?: string, buttons?: string[], defaultId?: number, cancelId?: number }) =>
		ipcRenderer.invoke('show-confirmation', options),
	saveVideo: (sourcePath: string) => ipcRenderer.invoke('save-video', sourcePath),
	openThreadDir: (threadId: string) => ipcRenderer.invoke('open-thread-dir', threadId),
	getVideoMetadata: (filePath: string) => ipcRenderer.invoke('get-video-metadata', filePath),
	showOpenDialog: (options: any) => ipcRenderer.invoke('show-open-dialog', options),
	upscaleImage: (data: { threadId: string, messageId: string, imagePath: string, upscaleFactor: string }) => 
		ipcRenderer.invoke('upscale-image', data),
	improviseMessage: (threadId: string, messageId: string) =>
		ipcRenderer.invoke('improvise-message', { threadId, messageId }),
	getModelMetadata: () => ipcRenderer.invoke('get-model-metadata')
}

if (process.contextIsolated) {
	try {
		contextBridge.exposeInMainWorld('api', api)
	} catch (error) {
		console.error('[Preload] Failed to expose API:', error)
	}
} else {
	// @ts-ignore
	window.api = api
}