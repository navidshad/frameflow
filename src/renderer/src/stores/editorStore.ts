import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type {
	BackgroundTask, Clip, EditorDocument, EditorHistoryStep, EditorMarker,
	EditorPersona, MediaAsset, PromptTurn, Thread, TimelineDiff, TimelineItem, TimelineSnapshot, Track
} from '@shared/types'
import {
	applyTimelineDiff, clampSpeed, clipToItem, computeContentEnd,
	diffTimelines, itemDuration, itemEnd,
	type TimelineState
} from '@shared/timeline'
import { computeScope } from '@shared/ai-scope'

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

	// ===== Timeline view state (M2) =====
	const playheadSec = ref(0)
	const isPlaying = ref(false)
	const pxPerSecond = ref(40)
	const timelineView = ref<'filmstrip' | 'context'>('filmstrip')
	const snapEnabled = ref(true)
	// Incremented on every external seek; the playback engine watches it.
	const seekRequest = ref<{ n: number; time: number }>({ n: 0, time: 0 })
	const selectedItemIds = ref<string[]>([])

	// ===== History state (M2) =====
	const historySteps = ref<EditorHistoryStep[]>([])
	let pushCounter = 0

	// ===== Personas (M3) =====
	const personas = ref<EditorPersona[]>([]) // built-ins + global user library (from main)
	const DEFAULT_PERSONA_ID = 'podcast-editor'

	// ===== AI prompt turns / proposals (M3) =====
	interface PendingProposal {
		turnId: string
		diff: TimelineDiff
		rationale?: string
		droppedOps: string[]
		addMarkers: { time: number; label: string }[]
		scopeLabel?: string
		thinContext: boolean
		truncated: boolean
	}
	const pendingProposal = ref<PendingProposal | null>(null)
	const activeTurnId = ref<string | null>(null)
	const lastAnswer = ref<{ turnId: string; text: string } | null>(null)
	const promptError = ref<string | null>(null)
	const scopeWiden = ref<'auto' | 'chapter' | 'full'>('auto')

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

	// ===== Timeline computeds (M2) =====
	const sortedTracks = computed<Track[]>(() =>
		[...(doc.value?.tracks || [])].sort((a, b) => a.order - b.order)
	)

	const itemsByTrack = computed<Record<string, TimelineItem[]>>(() => {
		const map: Record<string, TimelineItem[]> = {}
		for (const track of sortedTracks.value) map[track.id] = []
		for (const item of doc.value?.timeline || []) {
			(map[item.trackId] ||= []).push(item)
		}
		for (const id of Object.keys(map)) {
			map[id].sort((a, b) => a.timelineStart - b.timelineStart)
		}
		return map
	})

	const contentEnd = computed(() => computeContentEnd(doc.value?.timeline || []))
	const timelineTail = computed(() => Math.max(60, 0.25 * contentEnd.value))

	const markers = computed<EditorMarker[]>(() => doc.value?.markers || [])

	const selectedItems = computed<TimelineItem[]>(() =>
		(doc.value?.timeline || []).filter((i) => selectedItemIds.value.includes(i.id))
	)

	/** Ordered playable segments for EDL preview (unhidden video tracks). */
	const videoSegments = computed(() => {
		if (!doc.value) return []
		const hiddenOrVideoless = new Set(
			doc.value.tracks.filter((t) => t.kind !== 'video' || t.hidden).map((t) => t.id)
		)
		const trackMuted = new Map(doc.value.tracks.map((t) => [t.id, t.muted]))
		const assetById = new Map(doc.value.media.map((a) => [a.id, a]))

		return doc.value.timeline
			.filter((item) => !hiddenOrVideoless.has(item.trackId))
			.sort((a, b) => a.timelineStart - b.timelineStart)
			.flatMap((item) => {
				const asset = assetById.get(item.sourceAssetId)
				const src = asset ? (asset.proxyPath || asset.originalPath) : null
				if (!src) return []
				return [{
					itemId: item.id,
					tStart: item.timelineStart,
					tEnd: itemEnd(item),
					src: `media://${src}`,
					sourceIn: item.in,
					speed: item.speed || 1,
					muted: !!item.muted || !!trackMuted.get(item.trackId)
				}]
			})
	})

	const pointerIndex = computed(() => {
		const id = doc.value?.historyRef?.currentStepId || ''
		if (id === '') return -1
		return historySteps.value.findIndex((s) => s.id === id)
	})

	const canUndo = computed(() => pointerIndex.value >= 0)
	const canRedo = computed(() => pointerIndex.value < historySteps.value.length - 1)

	// ===== Persona computeds (M3) =====
	// Resolution: project-local customPersonas -> global library (incl. builtins) -> default
	const findPersona = (id: string | undefined | null): EditorPersona | null => {
		if (!id) return null
		return (
			doc.value?.customPersonas?.find((p) => p.id === id) ||
			personas.value.find((p) => p.id === id) ||
			null
		)
	}

	const activePersona = computed<EditorPersona | null>(() =>
		findPersona(doc.value?.activePersonaId) ||
		personas.value.find((p) => p.id === DEFAULT_PERSONA_ID) ||
		personas.value[0] ||
		null
	)

	const personasByMode = computed(() => ({
		longform: personas.value.filter((p) => p.builtin && p.mode === 'longform'),
		summarize: personas.value.filter((p) => p.builtin && p.mode === 'summarize'),
		custom: [
			...personas.value.filter((p) => !p.builtin),
			...(doc.value?.customPersonas || [])
		]
	}))

	// ===== Proposal computeds (M3) =====
	const promptRunning = computed(() => activeTurnId.value !== null)

	/** Live preview of what scope the NEXT prompt would use (drives the chip). */
	const scopePreview = computed(() => {
		if (!doc.value) return null
		return computeScope({
			timeline: doc.value.timeline,
			markers: doc.value.markers || [],
			selectedItemIds: selectedItemIds.value,
			playheadSec: playheadSec.value,
			mediaIds: doc.value.media.map((a) => a.id),
			widen: scopeWiden.value === 'auto' ? undefined : scopeWiden.value
		})
	})

	const proposalRemovedIds = computed<Set<string>>(() =>
		new Set(pendingProposal.value?.diff.removeItemIds || [])
	)

	const proposalUpdatedById = computed<Map<string, Partial<TimelineItem>>>(() => {
		const map = new Map<string, Partial<TimelineItem>>()
		for (const update of pendingProposal.value?.diff.updateItems || []) {
			map.set(update.id, update)
		}
		return map
	})

	/** Ghost items per track: proposed adds + updated items at their NEW position. */
	const ghostItemsByTrack = computed<Record<string, TimelineItem[]>>(() => {
		const map: Record<string, TimelineItem[]> = {}
		if (!pendingProposal.value || !doc.value) return map
		const push = (item: TimelineItem) => {
			(map[item.trackId] ||= []).push(item)
		}
		for (const added of pendingProposal.value.diff.addItems || []) {
			push({ ...added })
		}
		for (const update of pendingProposal.value.diff.updateItems || []) {
			const original = doc.value.timeline.find((i) => i.id === update.id)
			if (!original) continue
			const merged = { ...original, ...update }
			merged.speed = clampSpeed(merged.speed || 1)
			merged.duration = (merged.out - merged.in) / merged.speed
			push(merged)
		}
		return map
	})

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
				clipSelections,
				// Undo pointer rides with the doc: state + pointer land atomically
				historyRef: doc.value.historyRef,
				markers: doc.value.markers
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
			selectedItemIds.value = doc.value?.selection?.itemIds || []
			playheadSec.value = 0
			isPlaying.value = false

			backgroundTasks.value = (await api.getBackgroundTasks(id)) || {}

			// ---- Personas (global library incl. builtins) ----
			try {
				personas.value = (await api.getPersonas()) || []
			} catch (error) {
				console.error('[editorStore] Failed to load personas:', error)
			}

			// ---- History rehydration + pointer recovery (crash windows) ----
			try {
				const hist = await api.getEditorHistory(id)
				historySteps.value = hist?.steps || []
				const docPointer = doc.value!.historyRef?.currentStepId || ''
				const inSteps = (p: string) => p === '' || historySteps.value.some((s) => s.id === p)
				if (!inSteps(docPointer)) {
					// Doc references a step missing from the sidecar (crash between
					// autosave and sidecar push): fall back to the sidecar pointer,
					// else reset history entirely. The doc itself is never touched.
					const sidecarPointer = hist?.currentStepId || ''
					if (inSteps(sidecarPointer)) {
						doc.value!.historyRef = { currentStepId: sidecarPointer, stepCount: historySteps.value.length }
					} else {
						historySteps.value = []
						doc.value!.historyRef = { currentStepId: '', stepCount: 0 }
					}
					markDirty()
				}
			} catch (error) {
				console.error('[editorStore] Failed to load history:', error)
				historySteps.value = []
			}

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

	// ===== Timeline item selection (M2) =====
	const syncSelectionIntoDoc = () => {
		if (!doc.value) return
		doc.value.selection = { ...(doc.value.selection || {}), itemIds: [...selectedItemIds.value] }
		markDirty()
	}

	const selectItems = (ids: string[]) => {
		selectedItemIds.value = [...ids]
		syncSelectionIntoDoc()
	}

	const toggleItemSelected = (id: string) => {
		selectedItemIds.value = selectedItemIds.value.includes(id)
			? selectedItemIds.value.filter((x) => x !== id)
			: [...selectedItemIds.value, id]
		syncSelectionIntoDoc()
	}

	const clearItemSelection = () => selectItems([])

	// Drop selection entries for items that no longer exist (after undo/delete)
	const pruneSelection = () => {
		const existing = new Set((doc.value?.timeline || []).map((i) => i.id))
		const pruned = selectedItemIds.value.filter((id) => existing.has(id))
		if (pruned.length !== selectedItemIds.value.length) {
			selectedItemIds.value = pruned
			syncSelectionIntoDoc()
		}
	}

	// ===== Playback control =====
	const seekTo = (t: number) => {
		const clamped = Math.min(Math.max(0, t), contentEnd.value + timelineTail.value)
		playheadSec.value = clamped
		seekRequest.value = { n: seekRequest.value.n + 1, time: clamped }
	}

	// ===== History engine (M2) =====
	const currentState = (): TimelineState => ({
		tracks: doc.value!.tracks,
		timeline: doc.value!.timeline
	})

	const snapshotState = (): TimelineState =>
		JSON.parse(JSON.stringify(currentState()))

	const refreshMetaDuration = () => {
		if (!doc.value) return
		doc.value.timelineMeta = { ...doc.value.timelineMeta, duration: contentEnd.value }
	}

	/**
	 * Commits ONE history step. Either diffs `before` against the current doc
	 * (manual gestures) or takes a prebuilt forward/inverse pair (M3 AI accept).
	 * Returns false when nothing changed.
	 */
	const commitStep = (
		options: {
			before?: TimelineState
			prebuilt?: { forward: TimelineDiff; inverse: TimelineDiff }
			label?: string
			origin?: 'manual' | 'ai'
			turnId?: string
		}
	): boolean => {
		if (!doc.value || !threadId.value) return false

		let forward: TimelineDiff, inverse: TimelineDiff
		if (options.prebuilt) {
			({ forward, inverse } = options.prebuilt)
		} else if (options.before) {
			const diffed = diffTimelines(options.before, currentState())
			if (!diffed) return false
			;({ forward, inverse } = diffed)
		} else {
			return false
		}

		const step: EditorHistoryStep = {
			id: (crypto as any).randomUUID ? crypto.randomUUID() : `step-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			seq: 0, // assigned by main (getNextVersion); mirrored back below
			origin: options.origin || 'manual',
			label: options.label,
			forward,
			inverse,
			turnId: options.turnId,
			createdAt: Date.now()
		}

		// Truncate any redo branch beyond the pointer, then append
		const idx = pointerIndex.value
		historySteps.value = [...historySteps.value.slice(0, idx + 1), step]
		// Mirror the main-side ring cap (50)
		if (historySteps.value.length > 50) {
			historySteps.value = historySteps.value.slice(historySteps.value.length - 50)
		}

		doc.value.historyRef = { currentStepId: step.id, stepCount: historySteps.value.length }
		refreshMetaDuration()
		pruneSelection()
		markDirty()

		// Persist to the sidecar fire-and-forget; keyframe every 10th push
		pushCounter++
		const keyframe: TimelineSnapshot | undefined = pushCounter % 10 === 0
			? { stepId: step.id, ...snapshotState(), timelineMeta: { ...doc.value.timelineMeta } }
			: undefined
		api.pushEditorStep({
			threadId: threadId.value,
			step: JSON.parse(JSON.stringify(step)),
			keyframe: keyframe ? JSON.parse(JSON.stringify(keyframe)) : undefined
		}).then((res: { seq: number } | null) => {
			if (res?.seq) step.seq = res.seq
		}).catch((error: unknown) => {
			console.error('[editorStore] pushEditorStep failed:', error)
		})

		return true
	}

	const applyDiffToDoc = (diff: TimelineDiff): boolean => {
		if (!doc.value) return false
		// applyTimelineDiff reassigns arrays on its state argument, so work on a
		// wrapper of shallow copies and write the results back to the doc.
		const state: TimelineState = {
			tracks: [...doc.value.tracks],
			timeline: [...doc.value.timeline]
		}
		const result = applyTimelineDiff(state, diff, doc.value.media)
		if (result.errors.length) {
			console.warn('[editorStore] applyTimelineDiff reported:', result.errors)
		}
		doc.value.tracks = state.tracks
		doc.value.timeline = state.timeline
		return result.ok || result.errors.length < (diff.updateItems?.length || 0) + (diff.addItems?.length || 0) + 1
	}

	const movePointer = (stepId: string) => {
		if (!doc.value || !threadId.value) return
		doc.value.historyRef = { currentStepId: stepId, stepCount: historySteps.value.length }
		refreshMetaDuration()
		pruneSelection()
		markDirty()
		api.setEditorHistoryPointer({ threadId: threadId.value, currentStepId: stepId })
			.catch((error: unknown) => console.error('[editorStore] setEditorHistoryPointer failed:', error))
	}

	const undo = () => {
		const idx = pointerIndex.value
		if (idx < 0) return
		const step = historySteps.value[idx]
		applyDiffToDoc(step.inverse)
		movePointer(idx > 0 ? historySteps.value[idx - 1].id : '')
	}

	const redo = () => {
		const idx = pointerIndex.value
		if (idx >= historySteps.value.length - 1) return
		const step = historySteps.value[idx + 1]
		applyDiffToDoc(step.forward)
		movePointer(step.id)
	}

	// ===== Timeline actions (each commits ONE history step) =====

	const firstVideoTrackId = computed(() =>
		sortedTracks.value.find((t) => t.kind === 'video' && !t.locked && !t.hidden)?.id || null
	)

	const findClip = (clipId: string): Clip | null => {
		for (const asset of doc.value?.media || []) {
			const clip = asset.clips.find((c) => c.id === clipId)
			if (clip) return clip
		}
		return null
	}

	/** Nudge a candidate start right until [start, start+dur) is overlap-free on the track. */
	const resolveFreePosition = (trackId: string, start: number, duration: number, ignoreId?: string): number => {
		const items = (itemsByTrack.value[trackId] || []).filter((i) => i.id !== ignoreId)
		let candidate = Math.max(0, start)
		for (let guard = 0; guard < items.length + 1; guard++) {
			const collision = items.find(
				(i) => candidate < itemEnd(i) && candidate + duration > i.timelineStart
			)
			if (!collision) break
			candidate = itemEnd(collision)
		}
		return candidate
	}

	const addItemFromClip = (clipId: string, trackId?: string | null, atSec?: number): TimelineItem | null => {
		if (!doc.value) return null
		const clip = findClip(clipId)
		const targetTrackId = trackId || firstVideoTrackId.value
		if (!clip || !targetTrackId) return null
		const track = doc.value.tracks.find((t) => t.id === targetTrackId)
		if (!track || track.locked || track.hidden) return null
		const asset = doc.value.media.find((a) => a.id === clip.sourceAssetId)
		if (track.kind !== 'video' && track.kind !== (asset?.kind || 'video')) return null

		const before = snapshotState()
		const start = resolveFreePosition(targetTrackId, atSec ?? playheadSec.value, clip.duration)
		const item = clipToItem(clip, targetTrackId, start)
		doc.value.timeline.push(item)
		commitStep({ before, label: `Add ${item.label || 'clip'}` })
		selectItems([item.id])
		return item
	}

	const splitAtPlayhead = () => {
		if (!doc.value) return
		const t = playheadSec.value
		const candidates = (selectedItems.value.length ? selectedItems.value : doc.value.timeline)
			.filter((i) => t > i.timelineStart + 0.01 && t < itemEnd(i) - 0.01)
		if (!candidates.length) return

		const before = snapshotState()
		const newIds: string[] = []
		for (const item of candidates) {
			const sourceSplit = item.in + (t - item.timelineStart) * (item.speed || 1)
			const right: TimelineItem = {
				...JSON.parse(JSON.stringify(item)),
				id: (crypto as any).randomUUID ? crypto.randomUUID() : `ti-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				timelineStart: t,
				in: sourceSplit,
				masterSegmentIndex: undefined, // sub-range no longer maps to one master scene
				duration: (item.out - sourceSplit) / (item.speed || 1)
			}
			item.out = sourceSplit
			item.duration = (item.out - item.in) / (item.speed || 1)
			item.masterSegmentIndex = undefined
			doc.value.timeline.push(right)
			newIds.push(item.id, right.id)
		}
		commitStep({ before, label: 'Split' })
		selectItems(newIds)
	}

	const deleteItems = (ids: string[], options: { ripple?: boolean } = {}) => {
		if (!doc.value || !ids.length) return
		const ripple = options.ripple !== false // magnetic default
		const before = snapshotState()
		const removed = doc.value.timeline.filter((i) => ids.includes(i.id))
		doc.value.timeline = doc.value.timeline.filter((i) => !ids.includes(i.id))

		if (ripple) {
			// Close each track's gaps: shift remaining items left by the total
			// duration of removed items that started before them (same track).
			for (const item of doc.value.timeline) {
				const shift = removed
					.filter((r) => r.trackId === item.trackId && r.timelineStart < item.timelineStart)
					.reduce((sum, r) => sum + itemDuration(r), 0)
				if (shift > 0) item.timelineStart -= shift
			}
		}
		commitStep({ before, label: ripple ? 'Ripple delete' : 'Delete' })
	}

	const rippleDownstream = (item: TimelineItem, delta: number) => {
		if (!doc.value || Math.abs(delta) < 1e-9) return
		for (const other of doc.value.timeline) {
			if (other.id !== item.id && other.trackId === item.trackId && other.timelineStart > item.timelineStart) {
				other.timelineStart = Math.max(0, other.timelineStart + delta)
			}
		}
	}

	const setItemSpeed = (id: string, speed: number) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item || !doc.value) return
		const before = snapshotState()
		const oldDuration = itemDuration(item)
		item.speed = clampSpeed(speed)
		item.duration = (item.out - item.in) / item.speed
		rippleDownstream(item, item.duration - oldDuration)
		commitStep({ before, label: `Speed ${item.speed.toFixed(2)}×` })
	}

	const setItemTargetDuration = (id: string, seconds: number) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item || seconds <= 0) return
		setItemSpeed(id, (item.out - item.in) / seconds)
	}

	const setItemPreservePitch = (id: string, preservePitch: boolean) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item) return
		const before = snapshotState()
		item.preservePitch = preservePitch
		commitStep({ before, label: 'Pitch mode' })
	}

	const toggleItemMuted = (id: string) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item) return
		const before = snapshotState()
		item.muted = !item.muted
		commitStep({ before, label: item.muted ? 'Mute clip' : 'Unmute clip' })
	}

	const nudgeItems = (ids: string[], deltaSec: number) => {
		if (!doc.value || !ids.length) return
		const before = snapshotState()
		const moving = doc.value.timeline.filter((i) => ids.includes(i.id))
		for (const item of moving) {
			item.timelineStart = Math.max(0, item.timelineStart + deltaSec)
		}
		// Overlap forbidden: revert wholesale on any collision
		const collides = moving.some((item) =>
			(itemsByTrack.value[item.trackId] || []).some(
				(other) => other.id !== item.id && !ids.includes(other.id) &&
					item.timelineStart < itemEnd(other) && itemEnd(item) > other.timelineStart
			)
		)
		if (collides) {
			doc.value.tracks = before.tracks
			doc.value.timeline = before.timeline
			return
		}
		commitStep({ before, label: 'Nudge' })
	}

	// Markers are renderer-owned and NOT undoable (outside TimelineDiff)
	const addMarker = (time: number, label?: string) => {
		if (!doc.value) return
		const marker: EditorMarker = {
			id: (crypto as any).randomUUID ? crypto.randomUUID() : `mk-${Date.now()}`,
			time,
			label
		}
		doc.value.markers = [...(doc.value.markers || []), marker].sort((a, b) => a.time - b.time)
		markDirty()
	}

	const removeMarker = (id: string) => {
		if (!doc.value?.markers) return
		doc.value.markers = doc.value.markers.filter((m) => m.id !== id)
		markDirty()
	}

	const toggleTrackFlag = (trackId: string, flag: 'muted' | 'locked' | 'hidden') => {
		const track = doc.value?.tracks.find((t) => t.id === trackId)
		if (!track) return
		const before = snapshotState()
		track[flag] = !track[flag]
		commitStep({ before, label: `Track ${flag}` })
	}

	const addOverlayTrack = () => {
		if (!doc.value) return
		const before = snapshotState()
		const count = doc.value.tracks.filter((t) => t.kind === 'overlay').length
		doc.value.tracks.push({
			id: (crypto as any).randomUUID ? crypto.randomUUID() : `tr-${Date.now()}`,
			kind: 'overlay',
			name: `OV${count + 1}`,
			order: Math.max(...doc.value.tracks.map((t) => t.order)) + 1,
			muted: false,
			locked: false,
			hidden: false,
			height: 48
		})
		commitStep({ before, label: 'Add overlay track' })
	}

	// ===== Persona actions (M3) =====
	const setActivePersona = (id: string) => {
		if (!doc.value) return
		doc.value.activePersonaId = id
		markDirty()
	}

	/** Create or update a persona in the GLOBAL library (main filters builtins). */
	const savePersona = async (persona: EditorPersona) => {
		const userPersonas = personas.value.filter((p) => !p.builtin && p.id !== persona.id)
		const merged = await api.setPersonas(
			JSON.parse(JSON.stringify([...userPersonas, { ...persona, builtin: false, featureSets: [] }]))
		)
		if (merged) personas.value = merged
	}

	const clonePersona = (sourceId: string): EditorPersona | null => {
		const source = findPersona(sourceId) || personas.value.find((p) => p.id === sourceId)
		if (!source) return null
		return {
			...JSON.parse(JSON.stringify(source)),
			id: (crypto as any).randomUUID ? crypto.randomUUID() : `persona-${Date.now()}`,
			name: `Copy of ${source.name}`,
			builtin: false,
			featureSets: []
		}
	}

	const deletePersona = async (id: string) => {
		const target = personas.value.find((p) => p.id === id)
		if (!target || target.builtin) return // built-ins can't be deleted
		const merged = await api.setPersonas(
			JSON.parse(JSON.stringify(personas.value.filter((p) => !p.builtin && p.id !== id)))
		)
		if (merged) personas.value = merged
		if (doc.value?.activePersonaId === id) {
			setActivePersona(DEFAULT_PERSONA_ID)
		}
	}

	// ===== AI prompt actions (M3) =====
	const runPrompt = async (prompt: string) => {
		if (!threadId.value || !doc.value || promptRunning.value || pendingProposal.value) return
		promptError.value = null
		lastAnswer.value = null
		// Flush the debounced autosave so main's doc (the context source) is current
		dirty.value = true
		await persistDoc()
		try {
			const result = await api.runEditorPrompt({
				threadId: threadId.value,
				personaId: activePersona.value?.id || DEFAULT_PERSONA_ID,
				prompt,
				baseStepId: doc.value.historyRef.currentStepId,
				selectedItemIds: JSON.parse(JSON.stringify(selectedItemIds.value)),
				playheadSec: playheadSec.value,
				widen: scopeWiden.value === 'auto' ? undefined : scopeWiden.value
			})
			if (result?.turnId) activeTurnId.value = result.turnId
		} catch (error: any) {
			promptError.value = error?.message || 'Failed to start the prompt'
		}
	}

	const abortPrompt = async () => {
		if (!threadId.value || !activeTurnId.value) return
		await api.abortEditorPrompt({ threadId: threadId.value, turnId: activeTurnId.value })
	}

	/**
	 * Validates a proposal diff against the CURRENT doc by dry-running it on a
	 * copy; returns the applied copy + human-readable pruned-op notes.
	 */
	const dryRunProposal = (diff: TimelineDiff): { applied: TimelineState; pruned: string[] } => {
		const applied: TimelineState = {
			tracks: JSON.parse(JSON.stringify(doc.value!.tracks)),
			timeline: JSON.parse(JSON.stringify(doc.value!.timeline))
		}
		const result = applyTimelineDiff(applied, diff, doc.value!.media)
		return { applied, pruned: result.errors }
	}

	const acceptProposal = async () => {
		const proposal = pendingProposal.value
		if (!proposal || !doc.value || !threadId.value) return

		// Re-validate at accept time — the user may have kept editing during review
		const { applied, pruned } = dryRunProposal(proposal.diff)
		const before = currentState()
		const diffed = diffTimelines(before, applied)
		if (!diffed) {
			// Everything pruned or a no-op — nothing to commit
			pendingProposal.value = {
				...proposal,
				droppedOps: [...proposal.droppedOps, ...pruned, 'nothing left to apply — the timeline changed'],
				diff: { schemaVersion: proposal.diff.schemaVersion }
			}
			return
		}

		doc.value.tracks = applied.tracks
		doc.value.timeline = applied.timeline
		const turn = doc.value.turns.find((t) => t.id === proposal.turnId)
		const persona = findPersona(turn?.personaId) || activePersona.value
		commitStep({
			prebuilt: diffed,
			origin: 'ai',
			turnId: proposal.turnId,
			label: persona?.name || 'AI edit'
		})

		// Markers ride outside the diff (non-undoable by design)
		for (const marker of proposal.addMarkers) {
			addMarker(marker.time, marker.label)
		}

		api.updateEditorTurn({
			threadId: threadId.value,
			turnId: proposal.turnId,
			patch: { resultStepId: doc.value.historyRef.currentStepId }
		}).catch(() => { /* non-critical */ })

		pendingProposal.value = null
	}

	const rejectProposal = () => {
		pendingProposal.value = null
	}

	const dismissAnswer = () => {
		lastAnswer.value = null
	}

	/** Handles a completed/errored turn arriving from main. */
	const onTurnUpdate = (payload: {
		threadId: string
		turn: PromptTurn
		addMarkers?: { time: number; label: string }[]
		thinContext?: boolean
		truncated?: boolean
	}) => {
		if (payload.threadId !== threadId.value || !doc.value) return
		const turn = payload.turn

		// Upsert into doc.turns (main-owned; echo also arrives via thread-updated)
		const index = doc.value.turns.findIndex((t) => t.id === turn.id)
		if (index === -1) doc.value.turns.push(turn)
		else doc.value.turns[index] = turn

		if (turn.id !== activeTurnId.value && turn.status === 'running') return

		if (turn.status === 'completed') {
			activeTurnId.value = null
			if (turn.answer && !hasOps(turn.diff)) {
				lastAnswer.value = { turnId: turn.id, text: turn.answer }
				return
			}
			if (!hasOps(turn.diff)) {
				promptError.value = 'The AI proposed no changes. Try a more specific request.'
				return
			}
			// Dry-run against the live doc; prune stale ops
			const { pruned } = dryRunProposal(turn.diff!)
			pendingProposal.value = {
				turnId: turn.id,
				diff: turn.diff!,
				rationale: turn.rationale,
				droppedOps: [...(turn.droppedOps || []), ...pruned],
				addMarkers: payload.addMarkers || [],
				scopeLabel: turn.scopeLabel,
				thinContext: !!payload.thinContext,
				truncated: !!payload.truncated
			}
		} else if (turn.status === 'error') {
			activeTurnId.value = null
			promptError.value = turn.error || 'Prompt failed'
		}
	}

	const hasOps = (diff?: TimelineDiff): boolean =>
		!!diff && !!(
			diff.addItems?.length || diff.removeItemIds?.length ||
			diff.updateItems?.length || diff.addTracks?.length || diff.removeTrackIds?.length
		)

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

		// Turns are main-owned — merge unconditionally (like media)
		doc.value.turns = updated.editor.turns || doc.value.turns

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
			doc.value.historyRef = updated.editor.historyRef
			doc.value.markers = updated.editor.markers
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

		if (api.onEditorTurnUpdate) {
			api.onEditorTurnUpdate((data: any) => {
				try {
					onTurnUpdate(data)
				} catch (error) {
					console.error('[editorStore] turn update failed:', error)
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
		// timeline view state
		playheadSec,
		isPlaying,
		pxPerSecond,
		timelineView,
		snapEnabled,
		seekRequest,
		selectedItemIds,
		// computeds
		assets,
		isEmpty,
		selectedAsset,
		selectedClip,
		sortedTracks,
		itemsByTrack,
		contentEnd,
		timelineTail,
		markers,
		selectedItems,
		videoSegments,
		canUndo,
		canRedo,
		firstVideoTrackId,
		historySteps,
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
		persistDoc,
		// timeline actions
		selectItems,
		toggleItemSelected,
		clearItemSelection,
		seekTo,
		commitStep,
		snapshotState,
		undo,
		redo,
		addItemFromClip,
		splitAtPlayhead,
		deleteItems,
		setItemSpeed,
		setItemTargetDuration,
		setItemPreservePitch,
		toggleItemMuted,
		nudgeItems,
		addMarker,
		removeMarker,
		toggleTrackFlag,
		addOverlayTrack,
		// personas
		personas,
		activePersona,
		personasByMode,
		setActivePersona,
		savePersona,
		clonePersona,
		deletePersona,
		// AI prompt / proposals
		pendingProposal,
		activeTurnId,
		lastAnswer,
		promptError,
		scopeWiden,
		promptRunning,
		scopePreview,
		proposalRemovedIds,
		proposalUpdatedById,
		ghostItemsByTrack,
		runPrompt,
		abortPrompt,
		acceptProposal,
		rejectProposal,
		dismissAnswer
	}
})
