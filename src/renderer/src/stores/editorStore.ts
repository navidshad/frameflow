import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { BackgroundTask, Clip, EditorDocument, MediaAsset, Thread } from '@shared/types'

/**
 * Store for the timeline video editor (/editor/:id).
 *
 * Ownership split (prevents autosave <-> thread-updated echo clobbering):
 * - MAIN owns preprocessing-derived asset fields: preprocessing, proxyPath,
 *   metadata, preprocessState, preprocessError, clips content.
 * - RENDERER owns: selection, clip.selected flags, tracks, timeline,
 *   timelineMeta, activePersonaId, customPersonas.
 * persistDoc() sends only renderer-owned fields; the thread-updated handler
 * merges only main-owned fields.
 */
export const useEditorStore = defineStore('editor', () => {
	const api = (window as any).api

	// ===== State =====
	const threadId = ref<string | null>(null)
	const thread = ref<Thread | null>(null)
	const doc = ref<EditorDocument | null>(null)
	const backgroundTasks = ref<Record<string, BackgroundTask>>({})
	const selectedAssetId = ref<string | null>(null)
	const selectedClipId = ref<string | null>(null)
	const urlImports = ref<Record<string, { url: string; percent: number }>>({})
	const interruptedAssets = ref<Set<string>>(new Set())
	const dirty = ref(false)
	const saveInFlight = ref(false)
	const deps = ref<{ ffmpeg: boolean; scenedetect: boolean; ytDlp: boolean }>({
		ffmpeg: true,
		scenedetect: true,
		ytDlp: true
	})
	const loading = ref(false)

	let autosaveTimer: ReturnType<typeof setTimeout> | null = null

	// ===== Computeds =====
	const assets = computed<MediaAsset[]>(() => doc.value?.media ?? [])
	const isEmpty = computed(() => assets.value.length === 0)

	const selectedAsset = computed(() =>
		assets.value.find((a) => a.id === selectedAssetId.value) || null
	)

	const selectedClip = computed<Clip | null>(() => {
		if (!selectedClipId.value) return null
		for (const asset of assets.value) {
			const clip = asset.clips.find((c) => c.id === selectedClipId.value)
			if (clip) return clip
		}
		return null
	})

	const STEP_ORDER = ['proxy', 'scenes', 'thumbnails', 'descriptions']

	const assetTasks = (assetId: string): BackgroundTask[] => {
		const prefix = `${assetId}:`
		return Object.entries(backgroundTasks.value)
			.filter(([id]) => id.startsWith(prefix))
			.map(([, task]) => task)
			.sort((a, b) => {
				const stepOf = (t: BackgroundTask) => STEP_ORDER.indexOf(t.id.split(':')[1] || '')
				return stepOf(a) - stepOf(b)
			})
	}

	const assetProgress = (assetId: string): { step: string; percent: number } | null => {
		const running = assetTasks(assetId).find((t) => t.state === 'running')
		if (!running) return null
		return { step: running.id.split(':')[1] || running.name, percent: running.progress ?? 0 }
	}

	// ===== Persistence =====
	const markDirty = () => {
		dirty.value = true
		scheduleAutosave()
	}

	const scheduleAutosave = () => {
		if (autosaveTimer) clearTimeout(autosaveTimer)
		autosaveTimer = setTimeout(() => persistDoc(), 800)
	}

	const persistDoc = async () => {
		if (!threadId.value || !doc.value || !dirty.value) return
		saveInFlight.value = true
		try {
			const clipSelections: Record<string, boolean> = {}
			for (const asset of doc.value.media) {
				for (const clip of asset.clips) {
					clipSelections[clip.id] = clip.selected
				}
			}
			const patch = JSON.parse(JSON.stringify({
				tracks: doc.value.tracks,
				timeline: doc.value.timeline,
				timelineMeta: doc.value.timelineMeta,
				selection: doc.value.selection,
				activePersonaId: doc.value.activePersonaId,
				customPersonas: doc.value.customPersonas,
				clipSelections
			}))
			await api.saveEditorDoc({ threadId: threadId.value, patch })
			dirty.value = false
		} catch (error) {
			console.error('[editorStore] Failed to persist editor doc:', error)
		} finally {
			saveInFlight.value = false
		}
	}

	// ===== Loading =====
	const loadProject = async (id: string): Promise<boolean> => {
		loading.value = true
		try {
			const loaded: Thread | null = await api.getThread(id)
			if (!loaded || loaded.type !== 'editor' || !loaded.editor) {
				return false
			}
			threadId.value = id
			thread.value = loaded
			doc.value = JSON.parse(JSON.stringify(loaded.editor))
			dirty.value = false

			backgroundTasks.value = (await api.getBackgroundTasks(id)) || {}

			// Detect assets interrupted by an app quit mid-preprocess: persisted as
			// 'running' but with no live task process. Any incoming task update for
			// the asset clears the flag.
			interruptedAssets.value = new Set(
				(doc.value?.media || [])
					.filter((a) => a.preprocessState === 'running')
					.map((a) => a.id)
			)

			// Fire-and-forget: the scenedetect/yt-dlp binary checks spawn processes
			// and can take seconds — never block first paint on them.
			api.checkSystemRequirements()
				.then((reqs: any) => {
					deps.value = {
						ffmpeg: reqs?.ffmpegAvailable !== false,
						scenedetect: reqs?.scenedetectAvailable !== false,
						ytDlp: reqs?.ytDlpAvailable !== false
					}
				})
				.catch(() => { /* non-blocking */ })

			if (!selectedAssetId.value && assets.value.length > 0) {
				selectedAssetId.value = assets.value[0].id
			}
			return true
		} finally {
			loading.value = false
		}
	}

	// ===== Media actions (M1) =====
	const upsertAsset = (incoming: MediaAsset) => {
		if (!doc.value) return
		const index = doc.value.media.findIndex((a) => a.id === incoming.id)
		if (index === -1) {
			doc.value.media.push(incoming)
		} else {
			doc.value.media[index] = mergeMainOwnedAsset(doc.value.media[index], incoming)
		}
	}

	const addLocalMedia = async () => {
		if (!threadId.value) return
		const result = await api.selectVideo()
		if (!result?.path) return
		const asset: MediaAsset | null = await api.addMediaAsset({
			threadId: threadId.value,
			filePath: result.path,
			name: result.name
		})
		if (asset) {
			upsertAsset(asset)
			selectedAssetId.value = asset.id
		}
	}

	const importUrl = async (url: string, resolution?: string) => {
		if (!threadId.value) return
		try {
			const asset: MediaAsset | null = await api.importMediaUrl({
				threadId: threadId.value,
				url,
				resolution
			})
			if (asset) {
				delete urlImports.value[asset.id]
				upsertAsset(asset)
				selectedAssetId.value = asset.id
			}
			return asset
		} catch (error) {
			console.error('[editorStore] URL import failed:', error)
			throw error
		}
	}

	const removeAsset = async (assetId: string) => {
		if (!threadId.value || !doc.value) return
		const confirmed = await api.showConfirmation({
			title: 'Remove media',
			message: 'Remove this media and all its clips from the project?',
			detail: 'The imported copy and generated thumbnails will be deleted. The original file on disk is not affected.',
			buttons: ['Cancel', 'Remove']
		})
		if (!confirmed || confirmed.response !== 1) return
		const success = await api.removeMediaAsset({ threadId: threadId.value, assetId })
		if (success) {
			doc.value.media = doc.value.media.filter((a) => a.id !== assetId)
			if (selectedAssetId.value === assetId) selectedAssetId.value = doc.value.media[0]?.id || null
			if (selectedClip.value?.sourceAssetId === assetId) selectedClipId.value = null
		}
	}

	const retryAsset = async (assetId: string, steps?: string[]) => {
		if (!threadId.value) return
		interruptedAssets.value.delete(assetId)
		await api.preprocessMedia({ threadId: threadId.value, assetId, steps })
	}

	const describeAsset = async (assetId: string) => {
		if (!threadId.value) return
		await api.preprocessMedia({ threadId: threadId.value, assetId, steps: ['descriptions'] })
	}

	// ===== Selection =====
	const selectAsset = (assetId: string | null) => {
		selectedAssetId.value = assetId
		selectedClipId.value = null
	}

	const selectClip = (clipId: string | null) => {
		selectedClipId.value = clipId
	}

	const toggleClipSelected = (clipId: string) => {
		if (!doc.value) return
		for (const asset of doc.value.media) {
			const clip = asset.clips.find((c) => c.id === clipId)
			if (clip) {
				clip.selected = !clip.selected
				markDirty()
				return
			}
		}
	}

	// ===== Ownership-split merge for thread-updated echoes =====
	const mergeMainOwnedAsset = (local: MediaAsset, remote: MediaAsset): MediaAsset => {
		// Take main-owned fields from remote; preserve renderer-owned clip.selected
		// while an autosave is pending (remote may be a pre-save echo).
		const preserveSelected = dirty.value || saveInFlight.value
		const localSelected = new Map(local.clips.map((c) => [c.id, c.selected]))
		return {
			...remote,
			clips: remote.clips.map((clip) => ({
				...clip,
				selected: preserveSelected && localSelected.has(clip.id)
					? (localSelected.get(clip.id) as boolean)
					: clip.selected
			}))
		}
	}

	const onThreadUpdatedMerge = (updated: Thread) => {
		if (!threadId.value || updated.id !== threadId.value) return
		thread.value = updated
		if (!updated.editor || !doc.value) return

		const remoteMedia = updated.editor.media || []
		const remoteIds = new Set(remoteMedia.map((a) => a.id))

		// Merge main-owned media state
		const merged: MediaAsset[] = remoteMedia.map((remote) => {
			const local = doc.value!.media.find((a) => a.id === remote.id)
			if (remote.preprocessState !== 'running') interruptedAssets.value.delete(remote.id)
			return local ? mergeMainOwnedAsset(local, remote) : remote
		})
		// Keep local-only assets (mid-creation, not yet broadcast)
		for (const local of doc.value.media) {
			if (!remoteIds.has(local.id)) {
				const stillImporting = urlImports.value[local.id] !== undefined
				if (stillImporting) merged.push(local)
			}
		}
		doc.value.media = merged

		// Renderer-owned doc fields: only accept remote when no local edit is pending
		if (!dirty.value && !saveInFlight.value) {
			doc.value.tracks = updated.editor.tracks
			doc.value.timeline = updated.editor.timeline
			doc.value.timelineMeta = updated.editor.timelineMeta
			doc.value.selection = updated.editor.selection
			doc.value.activePersonaId = updated.editor.activePersonaId
			doc.value.customPersonas = updated.editor.customPersonas
		}

		if (selectedAssetId.value && !doc.value.media.some((a) => a.id === selectedAssetId.value)) {
			selectedAssetId.value = doc.value.media[0]?.id || null
		}
	}

	// ===== Singleton IPC listeners (registered once, like videoStore) =====
	if (typeof window !== 'undefined' && api) {
		api.onBackgroundTaskUpdate((data: { threadId: string; taskId: string; task: BackgroundTask }) => {
			if (data.threadId !== threadId.value) return
			backgroundTasks.value = { ...backgroundTasks.value, [data.taskId]: data.task }
			const assetId = data.taskId.split(':')[0]
			if (assetId) interruptedAssets.value.delete(assetId)
		})

		api.onThreadUpdated((updated: Thread) => {
			try {
				onThreadUpdatedMerge(updated)
			} catch (error) {
				console.error('[editorStore] thread-updated merge failed:', error)
			}
		})

		if (api.onEditorImportProgress) {
			api.onEditorImportProgress((data: { threadId: string; assetId: string; url?: string; percent: number }) => {
				if (data.threadId !== threadId.value) return
				urlImports.value = {
					...urlImports.value,
					[data.assetId]: { url: data.url || '', percent: data.percent }
				}
			})
		}
	}

	return {
		// state
		threadId,
		thread,
		doc,
		backgroundTasks,
		selectedAssetId,
		selectedClipId,
		urlImports,
		interruptedAssets,
		dirty,
		saveInFlight,
		deps,
		loading,
		// computeds
		assets,
		isEmpty,
		selectedAsset,
		selectedClip,
		// helpers
		assetTasks,
		assetProgress,
		// actions
		loadProject,
		addLocalMedia,
		importUrl,
		removeAsset,
		retryAsset,
		describeAsset,
		selectAsset,
		selectClip,
		toggleClipSelected,
		markDirty,
		persistDoc
	}
})
