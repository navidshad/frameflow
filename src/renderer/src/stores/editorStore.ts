import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type {
	BackgroundTask, Clip, EditorDocument, EditorHistoryStep, EditorMarker,
	EditorPersona, EditorRevision, MediaAsset, PromptTurn, Thread, TimelineDiff,
	TimelineItem, TimelineSnapshot, Track
} from '@shared/types'
import {
	applyTimelineDiff, clampSpeed, clipToItem, computeContentEnd,
	closeTimelineGaps, diffTimelines, findOverlaps, itemDuration, itemEnd, itemFromAsset,
	pruneOrphanItems, repairOverlaps,
	type TimelineState
} from '@shared/timeline'
import { computeScope } from '@shared/ai-scope'
import { childrenByParent, collectSubtree, hasBranch } from '@shared/revision-tree'
import { DEFAULT_PERSONA_ID } from '@shared/personas'

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
	/**
	 * The prompt-bar draft, owned by the store rather than PromptBar.
	 *
	 * Two reasons. Home hands a project its first prompt through queuePrompt()
	 * before the editor mounts; and PromptBar is v-if'd away whenever the chat
	 * rail collapses or toggles full-height, which silently destroyed a
	 * half-typed prompt.
	 */
	const promptDraft = ref('')
	/** Keyed by thread: /editor/:id reuses the component, so a queued prompt must not leak. */
	const pendingPrompt = ref<{ threadId: string; text: string } | null>(null)


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

	// ===== AI prompt turns (M3, reworked for revisions) =====
	const activeTurnId = ref<string | null>(null)
	const lastAnswer = ref<{ turnId: string; text: string } | null>(null)
	const promptError = ref<string | null>(null)
	const scopeWiden = ref<'auto' | 'chapter' | 'full'>('auto')

	// ===== Revision tree =====
	const revisions = ref<EditorRevision[]>([])

	/** Result card data for the most recent APPLIED AI edit (already a revision). */
	interface AiResult {
		turnId: string
		revisionId: string
		revisionSeq: number
		parentRevisionId: string | null
		counts: { added: number; removed: number; updated: number; markers: number }
		rationale?: string
		droppedOps: string[]
		scopeLabel?: string
		thinContext: boolean
		truncated: boolean
	}
	const lastResult = ref<AiResult | null>(null)

	// ===== Export / render (M4 + background exports) =====
	// Renders are keyed by THREAD id and survive project switches: the render
	// itself runs in main off an in-memory snapshot, so the user can keep
	// editing or load another project while it finishes. This map is
	// session-global — loadProject must NOT reset it.
	interface RenderEntry {
		threadId: string
		title: string
		renderId: string
		percent: number
		phase: 'rendering' | 'stitching' | 'done' | 'error'
		outputPath?: string
		error?: string
		startedAt: number
	}
	const renders = ref<Record<string, RenderEntry>>({})

	/** The CURRENT project's render state (compat shim for header/dialog). */
	const renderState = computed<RenderEntry | null>(() =>
		(threadId.value && renders.value[threadId.value]) || null
	)

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

	// Chain order, so a running task list reads top-to-bottom like the pipeline.
	const STEP_ORDER = ['proxy', 'audio', 'transcript', 'retranscribe', 'scenes', 'thumbnails', 'descriptions']

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

	// Audio-track segments for preview (PRD §5.3): items on audio-kind tracks.
	// Carries trackId so preview can play each audio track through its OWN
	// <audio> element in parallel with the video (multi-track sound). Audio
	// assets have no proxy, so preview reads originalPath.
	const audioSegments = computed(() => {
		if (!doc.value) return []
		const audioTrackIds = new Set(
			doc.value.tracks.filter((t) => t.kind === 'audio' && !t.hidden).map((t) => t.id)
		)
		const trackMuted = new Map(doc.value.tracks.map((t) => [t.id, t.muted]))
		const assetById = new Map(doc.value.media.map((a) => [a.id, a]))

		return doc.value.timeline
			.filter((item) => audioTrackIds.has(item.trackId))
			.sort((a, b) => a.timelineStart - b.timelineStart)
			.flatMap((item) => {
				const asset = assetById.get(item.sourceAssetId)
				const src = asset?.originalPath
				if (!src) return []
				return [{
					itemId: item.id,
					trackId: item.trackId,
					tStart: item.timelineStart,
					tEnd: itemEnd(item),
					src: `media://${src}`,
					sourceIn: item.in,
					speed: item.speed || 1,
					muted: !!item.muted || !!trackMuted.get(item.trackId),
					gain: item.gain ?? 1,
					fadeInSec: item.fadeInSec ?? 0,
					fadeOutSec: item.fadeOutSec ?? 0
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

	/**
	 * Built-in vs custom. This used to group by persona mode (Long-form /
	 * Summarize), which is the taxonomy that no longer exists — a persona is a
	 * style now, and length comes from the request.
	 */
	const personaGroups = computed(() => ({
		builtin: personas.value.filter((p) => p.builtin),
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

	// ===== Model selection (display only) =====
	const modelSelection = ref<Record<string, string>>({})
	const modelMetadata = ref<Record<string, { label: string }>>({})

	/**
	 * Friendly name of the model configured for an operation, e.g.
	 * modelLabelFor('corrected-transcript') -> "Gemini 2.5 Pro".
	 * Falls back to plain "Gemini" so a label never renders blank.
	 */
	const modelLabelFor = (operation: string): string => {
		const id = modelSelection.value[operation]
		if (!id) return 'Gemini'
		return modelMetadata.value[id]?.label || id
	}

	// ===== Revision computeds =====
	/** Markers are compared by position and label — ids are not meaningful here. */
	const markersDiffer = (a: EditorMarker[], b: EditorMarker[]): boolean => {
		if (a.length !== b.length) return true
		const key = (m: EditorMarker) => `${Math.round(m.time * 1000)}|${m.label || ''}`
		const left = [...a].map(key).sort()
		const right = [...b].map(key).sort()
		return left.some((value, index) => value !== right[index])
	}

	const currentRevision = computed<EditorRevision | null>(() =>
		revisions.value.find((r) => r.id === doc.value?.currentRevisionId) || null
	)

	/** Working state differs from the current revision's snapshot. */
	const revisionDirty = computed(() => {
		const rev = currentRevision.value
		if (!rev || !doc.value) return false
		if (diffTimelines(
			{ tracks: rev.snapshot.tracks, timeline: rev.snapshot.timeline },
			{ tracks: doc.value.tracks, timeline: doc.value.timeline }
		) !== null) return true
		// Markers live outside TimelineDiff, so the timeline comparison above is
		// blind to them. Without this, marker-only work counts as "clean" and
		// switchRevision overwrites it with no checkpoint and no undo.
		return markersDiffer(rev.snapshot.markers || [], doc.value.markers || [])
	})

	/** Children grouped by parentId (null key = root), createdAt-sorted. */
	const revisionChildren = computed<Map<string | null, EditorRevision[]>>(
		() => childrenByParent(revisions.value)
	)

	/** Does the history fork? Drives whether the revisions panel opens as a graph. */
	const revisionHasBranch = computed(() => hasBranch(revisions.value))

	// ===== Export computeds (M4) =====
	const isRendering = computed(() =>
		renderState.value?.phase === 'rendering' || renderState.value?.phase === 'stitching'
	)

	/** Every tracked render, newest first — feeds the global background pill. */
	const backgroundRenders = computed<RenderEntry[]>(() =>
		Object.values(renders.value).sort((a, b) => b.startedAt - a.startedAt)
	)

	// The AI has nothing to work with until at least one asset finished
	// preprocessing (pieces/transcript exist) — the chat gates on this.
	const hasReadyMedia = computed(() =>
		assets.value.some((a) => a.preprocessState === 'completed' && (a.clips?.length ?? 0) > 0)
	)
	const mediaProcessing = computed(() =>
		assets.value.some((a) => a.preprocessState === 'running' || a.preprocessState === 'pending')
	)

	const canExport = computed(() => {
		if (!doc.value || isRendering.value) return false
		const videoTrack = sortedTracks.value.find((t) => t.kind === 'video')
		if (!videoTrack || videoTrack.hidden) return false
		return doc.value.timeline.some((i) => i.trackId === videoTrack.id)
	})

	/**
	 * Pre-flight export warnings (PRD §5.9): content that exists on the timeline
	 * but will be missing from the render — muted/hidden tracks with clips,
	 * individually muted clips, overlay/text items. Warnings with an `action`
	 * offer a one-click fix (e.g. Unmute) in the export dialog.
	 */
	const exportWarnings = computed<Array<{
		id: string
		text: string
		action?: { label: string; trackId: string; flag: 'muted' | 'hidden' }
	}>>(() => {
		if (!doc.value) return []
		const warnings: Array<{ id: string; text: string; action?: { label: string; trackId: string; flag: 'muted' | 'hidden' } }> = []
		const itemsByTrack = new Map<string, number>()
		for (const item of doc.value.timeline) {
			itemsByTrack.set(item.trackId, (itemsByTrack.get(item.trackId) || 0) + 1)
		}
		const plural = (n: number) => n === 1 ? '1 clip' : `${n} clips`

		for (const track of doc.value.tracks) {
			const count = itemsByTrack.get(track.id) || 0
			if (count === 0 || track.kind === 'overlay' || track.kind === 'text') continue
			if (track.hidden) {
				warnings.push({
					id: `hidden-${track.id}`,
					text: `${track.name} (${plural(count)}) is hidden and won't be in the export.`,
					action: { label: 'Show', trackId: track.id, flag: 'hidden' }
				})
			} else if (track.muted) {
				warnings.push({
					id: `muted-${track.id}`,
					text: track.kind === 'audio'
						? `${track.name} (${plural(count)}) is muted and won't be heard in the export.`
						: `${track.name} (${plural(count)}) is muted — its clips render without their audio.`,
					action: { label: 'Unmute', trackId: track.id, flag: 'muted' }
				})
			}
		}

		const trackById = new Map(doc.value.tracks.map((t) => [t.id, t]))
		const mutedItems = doc.value.timeline.filter((i) => {
			const track = trackById.get(i.trackId)
			return i.muted && track && !track.muted && !track.hidden &&
				(track.kind === 'video' || track.kind === 'audio')
		})
		if (mutedItems.length > 0) {
			warnings.push({
				id: 'muted-items',
				text: `${plural(mutedItems.length)} ${mutedItems.length === 1 ? 'has' : 'have'} muted audio and won't be heard in the export.`
			})
		}

		const hasOverlayItems = doc.value.timeline.some((item) => {
			const track = trackById.get(item.trackId)
			return track && (track.kind === 'overlay' || track.kind === 'text')
		})
		if (hasOverlayItems) {
			warnings.push({ id: 'overlay', text: "Overlay/text tracks won't appear in this export." })
		}

		return warnings
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
				markers: doc.value.markers,
				currentRevisionId: doc.value.currentRevisionId
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

			// A prompt queued by Home lands in the bar but is NOT run: preprocessing
			// has not finished, so the AI would see an empty clip tray.
			promptDraft.value = pendingPrompt.value?.threadId === id ? pendingPrompt.value.text : ''
			pendingPrompt.value = null

			if (doc.value) {
				const state: TimelineState = { tracks: doc.value.tracks, timeline: doc.value.timeline }

				// Heal projects saved before removeAsset purged the timeline: clips
				// whose media is gone draw as empty, play nothing, and kill the
				// export. Swept BEFORE the overlap repair — repairing against items
				// about to be deleted would push survivors right for nothing.
				const orphans = pruneOrphanItems(state, new Set(doc.value.media.map((a) => a.id)))
				if (orphans.length) {
					doc.value.timeline = state.timeline
					console.warn(`[editorStore] Dropped ${orphans.length} timeline item(s) whose media is gone`)
					refreshMetaDuration()
					markDirty()
				}

				// Heal any pre-existing same-track overlaps (e.g. from AI accepts
				// made before overlap repair existed) — persists via autosave.
				if (repairOverlaps(state)) {
					console.warn('[editorStore] Repaired overlapping timeline items on load')
					markDirty()
				}
			}

			backgroundTasks.value = (await api.getBackgroundTasks(id)) || {}

			// ---- Personas (global library incl. builtins) ----
			try {
				personas.value = (await api.getPersonas()) || []
			} catch (error) {
				console.error('[editorStore] Failed to load personas:', error)
			}

			// ---- Which model each operation is configured to use ----
			// So buttons that spend tokens can name the model instead of just
			// saying "uses Gemini" — the selection is user-configurable.
			try {
				const [settings, metadata] = await Promise.all([
					api.getModelSettings(),
					api.getModelMetadata()
				])
				modelSelection.value = settings?.selection || {}
				modelMetadata.value = metadata || {}
			} catch (error) {
				console.error('[editorStore] Failed to load model settings:', error)
			}

			// ---- Revisions sidecar + pointer reconciliation ----
			// Invariant: losing/corrupting the sidecar NEVER mutates the working doc.
			lastResult.value = null
			try {
				revisions.value = (await api.getEditorRevisions(id))?.revisions || []
			} catch (error) {
				console.error('[editorStore] Failed to load revisions:', error)
				revisions.value = []
			}
			if (doc.value?.currentRevisionId &&
				!revisions.value.some((r) => r.id === doc.value!.currentRevisionId)) {
				// Sidecar lost or pointer dangling — clear and lazily re-bootstrap
				delete doc.value.currentRevisionId
				markDirty()
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
		// Counted before the IPC: the dialog has to say what will actually be lost.
		const clipCount = doc.value.timeline.filter((i) => i.sourceAssetId === assetId).length
		const confirmed = await api.showConfirmation({
			title: 'Remove media',
			message: clipCount
				? `Remove this media and the ${clipCount} clip${clipCount === 1 ? '' : 's'} it has on the timeline?`
				: 'Remove this media from the project?',
			detail: clipCount
				? 'The imported copy and generated thumbnails will be deleted, and those clips will leave gaps you can close with Close gaps. This cannot be undone. The original file on disk is not affected.'
				: 'The imported copy and generated thumbnails will be deleted. This cannot be undone. The original file on disk is not affected.',
			buttons: ['Cancel', 'Remove']
		})
		if (!confirmed || confirmed.response !== 1) return
		const success = await api.removeMediaAsset({ threadId: threadId.value, assetId })
		if (success) {
			doc.value.media = doc.value.media.filter((a) => a.id !== assetId)
			// Mirror the purge main already made (editor/assets.ts removeAsset).
			// Without this the stale timeline goes straight back to disk on the
			// next autosave and the export dies on a clip with no media.
			//
			// No ripple and no history step, deliberately: the asset directory is
			// gone from disk so the removal cannot be undone, and shifting
			// survivors here would move them outside the undo ring — which stores
			// absolute positions — so undoing any EARLIER step would snap them
			// back and re-open the hole. Main's purge does not ripple either.
			const state: TimelineState = { tracks: doc.value.tracks, timeline: doc.value.timeline }
			if (pruneOrphanItems(state, new Set(doc.value.media.map((a) => a.id))).length) {
				doc.value.timeline = state.timeline
				refreshMetaDuration()
				pruneSelection()
				markDirty()
			}
			if (selectedAssetId.value === assetId) selectedAssetId.value = doc.value.media[0]?.id || null
			if (selectedClip.value?.sourceAssetId === assetId) selectedClipId.value = null
			if (silenceScan.value?.assetId === assetId) silenceScan.value = null
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

	const transcribeAsset = async (assetId: string) => {
		if (!threadId.value) return
		await api.preprocessMedia({ threadId: threadId.value, assetId, steps: ['audio', 'transcript'] })
	}

	/**
	 * Repair a looped transcript: a stronger model re-checks it against the audio
	 * and the speech pieces are rebuilt from the result. Confirmed because it
	 * costs tokens and replaces every piece derived from the old transcript.
	 */
	const repairTranscript = async (assetId: string) => {
		if (!threadId.value) return
		const confirmed = await api.showConfirmation({
			title: 'Re-transcribe this media?',
			message: 'Check the audio again and rebuild the speech pieces?',
			detail: 'A stronger model re-reads the audio alongside the current transcript to fix the repeated section. This runs Gemini (costs tokens) and replaces the pieces derived from the old transcript. Clips already on the timeline keep playing the same footage.',
			buttons: ['Cancel', 'Re-transcribe']
		})
		if (!confirmed || confirmed.response !== 1) return
		await api.preprocessMedia({ threadId: threadId.value, assetId, steps: ['retranscribe'] })
	}

	/** Remove derived Gemini data (transcript / scene descriptions) from an asset. */
	const clearAssetData = async (assetId: string, kind: 'transcript' | 'descriptions') => {
		if (!threadId.value) return
		const label = kind === 'transcript' ? 'transcript' : 'scene descriptions'
		const confirmed = await api.showConfirmation({
			title: `Remove ${label}?`,
			message: `Delete the ${label} for this media?`,
			detail: `The ${label} data is removed from every piece. Regenerating it later runs Gemini again and costs tokens.`,
			buttons: ['Cancel', 'Remove']
		})
		if (!confirmed || confirmed.response !== 1) return
		const updated = await api.clearAssetData({ threadId: threadId.value, assetId, kind })
		if (updated && doc.value) {
			const index = doc.value.media.findIndex((a) => a.id === updated.id)
			if (index !== -1) doc.value.media[index] = { ...doc.value.media[index], clips: updated.clips, preprocessing: updated.preprocessing }
		}
	}

	/** Rename the project (title is a main-owned Thread field). */
	const renameProject = async (title: string) => {
		if (!threadId.value) return
		const clean = title.trim().slice(0, 120)
		if (!clean) return
		if (thread.value) thread.value.title = clean // optimistic; thread-updated echoes it
		await api.renameEditorProject({ threadId: threadId.value, title: clean })
	}

	// ===== Scene-piece corrections (§5.2) =====

	/**
	 * Lazily generate dense filmstrips (§5.5): fired when filmstrip view is
	 * active, for completed assets that are used on the timeline and don't
	 * have one yet. One batched ffmpeg pass per asset, cached on the asset.
	 */
	const filmstripRequested = new Set<string>()
	const ensureFilmstrips = () => {
		if (!threadId.value || !doc.value || timelineView.value !== 'filmstrip') return
		const usedAssetIds = new Set(doc.value.timeline.map((i) => i.sourceAssetId))
		for (const asset of doc.value.media) {
			if (!usedAssetIds.has(asset.id)) continue
			if (asset.preprocessState !== 'completed') continue
			if (asset.filmstrip?.length || filmstripRequested.has(asset.id)) continue
			filmstripRequested.add(asset.id)
			api.preprocessMedia({ threadId: threadId.value, assetId: asset.id, steps: ['filmstrip'] })
		}
	}
	watch([timelineView, () => doc.value?.timeline.length], () => ensureFilmstrips())

	/**
	 * Repair assets whose pieces lost their thumbnails (a re-transcribe used to
	 * clear them). Local ffmpeg only — no Gemini, no cost. Runs once per asset.
	 */
	const thumbnailsRequested = new Set<string>()
	const ensureThumbnails = () => {
		if (!threadId.value || !doc.value) return
		for (const asset of doc.value.media) {
			if (asset.preprocessState !== 'completed') continue
			if (!asset.clips?.length || thumbnailsRequested.has(asset.id)) continue
			if (asset.clips.some((c) => !!c.thumbnailPath)) continue
			thumbnailsRequested.add(asset.id)
			console.warn(`[editorStore] ${asset.name} has no piece thumbnails — regenerating`)
			api.preprocessMedia({ threadId: threadId.value, assetId: asset.id, steps: ['thumbnails'] })
		}
	}
	watch(() => doc.value?.media.map((a) => a.id).join(','), () => ensureThumbnails())

	/** Re-run scene detection with a custom threshold (lower = more pieces). */
	const redetectScenes = async (assetId: string, threshold: number) => {
		if (!threadId.value) return
		await api.preprocessMedia({
			threadId: threadId.value,
			assetId,
			steps: ['scenes', 'thumbnails'],
			threshold
		})
	}

	/** Replace one asset's clips from a main-process response. */
	const patchAssetClips = (updated: MediaAsset | null) => {
		if (!updated || !doc.value) return
		const index = doc.value.media.findIndex((a) => a.id === updated.id)
		if (index !== -1) doc.value.media[index] = { ...doc.value.media[index], clips: updated.clips }
	}

	/** Merge the selected (adjacent) pieces of an asset. Returns an error message or null. */
	const mergeSelectedClips = async (assetId: string): Promise<string | null> => {
		if (!threadId.value || !doc.value) return null
		const asset = doc.value.media.find((a) => a.id === assetId)
		const clipIds = (asset?.clips || []).filter((c) => c.selected).map((c) => c.id)
		if (clipIds.length < 2) return 'Select at least two pieces to merge.'
		try {
			patchAssetClips(await api.mergeClips({ threadId: threadId.value, assetId, clipIds }))
			return null
		} catch (error: any) {
			return error?.message?.split('Error: ').pop() || 'Merge failed.'
		}
	}

	/** Split each selected piece at its midpoint. Returns an error message or null. */
	const splitSelectedClips = async (assetId: string): Promise<string | null> => {
		if (!threadId.value || !doc.value) return null
		const asset = doc.value.media.find((a) => a.id === assetId)
		const clipIds = (asset?.clips || []).filter((c) => c.selected).map((c) => c.id)
		if (!clipIds.length) return 'Select a piece to split.'
		try {
			let updated: MediaAsset | null = null
			for (const clipId of clipIds) {
				updated = await api.splitClip({ threadId: threadId.value, assetId, clipId })
			}
			patchAssetClips(updated)
			return null
		} catch (error: any) {
			return error?.message?.split('Error: ').pop() || 'Split failed.'
		}
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

		// Log-only tripwire. Nothing here repairs the timeline — repairing after
		// the diff would leave the doc and its history out of step — but a
		// gesture or diff that produces an overlap corrupts the export silently,
		// so surface it on the first drag instead of at export time.
		if (import.meta.env.DEV) {
			const bad = findOverlaps(currentState())
			if (bad.length) {
				console.warn(`[editorStore] ${options.label || 'edit'} left ${bad.length} overlapping pair(s):`, bad)
			}
		}

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

	const firstAudioTrackId = computed(() =>
		sortedTracks.value.find((t) => t.kind === 'audio' && !t.locked && !t.hidden)?.id || null
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
		if (!clip) return null
		const asset = doc.value.media.find((a) => a.id === clip.sourceAssetId)
		// Default the target lane by the clip's kind (audio piece → audio lane).
		const targetTrackId = trackId
			|| (asset?.kind === 'audio' ? firstAudioTrackId.value : firstVideoTrackId.value)
		if (!targetTrackId) return null
		const track = doc.value.tracks.find((t) => t.id === targetTrackId)
		if (!track || track.locked || track.hidden) return null
		if (track.kind !== 'video' && track.kind !== (asset?.kind || 'video')) return null

		const before = snapshotState()
		const start = resolveFreePosition(targetTrackId, atSec ?? playheadSec.value, clip.duration)
		const item = clipToItem(clip, targetTrackId, start)
		doc.value.timeline.push(item)
		commitStep({ before, label: `Add ${item.label || 'clip'}` })
		selectItems([item.id])
		return item
	}

	/**
	 * Drop a WHOLE asset onto the timeline as a single full-span item. Defaults
	 * the target track by kind (audio→A-lane, video→V-lane); kind must match
	 * (audio assets only on audio tracks, video only on video tracks).
	 */
	const addItemFromAsset = (assetId: string, trackId?: string | null, atSec?: number): TimelineItem | null => {
		if (!doc.value) return null
		const asset = doc.value.media.find((a) => a.id === assetId)
		if (!asset) return null
		const targetTrackId = trackId || (asset.kind === 'audio' ? firstAudioTrackId.value : firstVideoTrackId.value)
		if (!targetTrackId) return null
		const track = doc.value.tracks.find((t) => t.id === targetTrackId)
		if (!track || track.locked || track.hidden) return null
		const compatible = asset.kind === 'audio' ? track.kind === 'audio' : track.kind === 'video'
		if (!compatible) return null
		const duration = asset.metadata?.duration || 0
		if (duration <= 0) return null

		const before = snapshotState()
		const start = resolveFreePosition(targetTrackId, atSec ?? playheadSec.value, duration)
		const item = itemFromAsset(asset, targetTrackId, start)
		doc.value.timeline.push(item)
		commitStep({ before, label: `Add ${asset.name}` })
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

	/**
	 * Pull every clip left so each track runs back to back. Removals already
	 * ripple, so this is for holes that are already there — an AI edit from
	 * before removals rippled, or a clip dragged out of line by hand.
	 * `hasGaps` drives the toolbar button's enabled state.
	 */
	const hasGaps = computed(() => {
		if (!doc.value?.timeline.length) return false
		const probe = {
			tracks: doc.value.tracks,
			timeline: doc.value.timeline.map((i) => ({ ...i }))
		}
		return closeTimelineGaps(probe)
	})

	const closeGaps = () => {
		if (!doc.value?.timeline.length) return
		const before = snapshotState()
		if (!closeTimelineGaps({ tracks: doc.value.tracks, timeline: doc.value.timeline })) return
		commitStep({ before, label: 'Close gaps' })
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

	const setItemGain = (id: string, gain: number) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item || !Number.isFinite(gain)) return
		const before = snapshotState()
		item.gain = Math.max(0, Math.min(2, gain))
		commitStep({ before, label: `Gain ${item.gain.toFixed(2)}` })
	}

	/** Audio fade-in/out length in seconds, clamped to the item's on-timeline duration. */
	const setItemFade = (id: string, edge: 'in' | 'out', seconds: number) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item || !Number.isFinite(seconds)) return
		const before = snapshotState()
		const clamped = Math.max(0, Math.min(item.duration, seconds))
		if (edge === 'in') item.fadeInSec = clamped || undefined
		else item.fadeOutSec = clamped || undefined
		commitStep({ before, label: `Fade ${edge} ${clamped.toFixed(1)}s` })
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

	// ===== Silence / dead-air finder (§5.6) =====
	// Read-only analysis; the caller reviews before applying. Scan state lives
	// here (not in the Inspector) so results survive selection/mode changes.
	const silenceScanning = ref(false)
	const silenceScanPercent = ref<number | null>(null)
	const silenceScan = ref<{ assetId: string; regions: { start: number; end: number }[] } | null>(null)
	const silenceNoiseDb = ref(-30)
	const silenceMinDurationSec = ref(0.5)

	const findSilence = async (
		assetId: string,
		opts?: { noiseDb?: number; minDurationSec?: number }
	): Promise<{ start: number; end: number }[]> => {
		if (!threadId.value) return []
		return await api.findSilence({ threadId: threadId.value, assetId, ...opts })
	}

	const scanSilence = async (assetId: string) => {
		silenceScanning.value = true
		silenceScanPercent.value = 0
		try {
			const regions = await findSilence(assetId, {
				noiseDb: silenceNoiseDb.value,
				minDurationSec: silenceMinDurationSec.value
			})
			silenceScan.value = { assetId, regions }
		} finally {
			silenceScanning.value = false
			silenceScanPercent.value = null
		}
	}

	const clearSilenceScan = () => {
		silenceScan.value = null
	}

	/** Map a source-time position on `assetId` to the first timeline position it appears at, or null if unplaced. */
	const sourceTimeToTimeline = (assetId: string, sourceT: number): number | null => {
		if (!doc.value) return null
		for (const item of doc.value.timeline) {
			if (item.sourceAssetId === assetId && sourceT >= item.in && sourceT <= item.out) {
				return item.timelineStart + (sourceT - item.in) / (item.speed || 1)
			}
		}
		return null
	}

	/**
	 * Apply reviewed silence regions (source seconds of `assetId`) as ripple-deletes:
	 * carve each region out of every timeline item drawn from that asset and close
	 * the removed on-timeline duration, preserving intentional (non-silence) gaps.
	 * One undoable history step; never auto-invoked.
	 */
	const applySilenceRegions = (assetId: string, regions: { start: number; end: number }[]) => {
		if (!doc.value || !regions.length) return

		// Normalize + merge overlapping/adjacent regions.
		const merged = [...regions]
			.filter((r) => r.end > r.start)
			.sort((a, b) => a.start - b.start)
			.reduce<{ start: number; end: number }[]>((acc, r) => {
				const last = acc[acc.length - 1]
				if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
				else acc.push({ ...r })
				return acc
			}, [])
		if (!merged.length) return

		// Keep-intervals of [in,out] after subtracting merged regions (clamped).
		const keptIntervals = (inSec: number, outSec: number) => {
			const kept: { start: number; end: number }[] = []
			let cursor = inSec
			for (const r of merged) {
				if (r.end <= inSec) continue      // region entirely before this item
				if (r.start >= outSec) break      // region entirely after — nothing more overlaps
				const s = Math.max(inSec, r.start)
				const e = Math.min(outSec, r.end)
				if (s > cursor) kept.push({ start: cursor, end: s })
				cursor = Math.max(cursor, e)
			}
			if (cursor < outSec) kept.push({ start: cursor, end: outSec })
			return kept
		}

		const before = snapshotState()
		const newTimeline: TimelineItem[] = []

		const trackIds = Array.from(new Set(doc.value.timeline.map((i) => i.trackId)))
		for (const trackId of trackIds) {
			const items = doc.value.timeline
				.filter((i) => i.trackId === trackId)
				.sort((a, b) => a.timelineStart - b.timelineStart)

			let removedSoFar = 0
			for (const item of items) {
				if (item.sourceAssetId !== assetId) {
					// Untouched content: keep its own leading gap, close upstream removals.
					newTimeline.push({ ...item, timelineStart: Math.max(0, item.timelineStart - removedSoFar) })
					continue
				}
				const speed = item.speed || 1
				const originalOnTimeline = itemDuration(item)
				const kept = keptIntervals(item.in, item.out)
				let pieceStart = Math.max(0, item.timelineStart - removedSoFar)
				let keptOnTimeline = 0
				for (const seg of kept) {
					const dur = (seg.end - seg.start) / speed
					newTimeline.push({
						...JSON.parse(JSON.stringify(item)),
						id: (crypto as any).randomUUID ? crypto.randomUUID() : `ti-${Date.now()}-${Math.random().toString(36).slice(2)}`,
						in: seg.start,
						out: seg.end,
						duration: dur,
						timelineStart: pieceStart,
						masterSegmentIndex: undefined // sub-range no longer maps to one master scene
					})
					pieceStart += dur
					keptOnTimeline += dur
				}
				removedSoFar += originalOnTimeline - keptOnTimeline
			}
		}

		doc.value.timeline = newTimeline
		commitStep({ before, label: 'Remove silence' })
		if (silenceScan.value?.assetId === assetId) silenceScan.value = null
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

	// ===== Revision actions =====
	const deepClone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

	const snapshotOfWorkingState = () => deepClone({
		tracks: doc.value!.tracks,
		timeline: doc.value!.timeline,
		timelineMeta: doc.value!.timelineMeta,
		markers: doc.value!.markers || []
	})

	/** Push to the sidecar and mirror the assigned seq back (awaited — cards need real V numbers). */
	/**
	 * Main assigns the real `seq` and may prune the oldest leaf to stay under the
	 * cap. Both land in ONE reactive assignment: the previous version mutated the
	 * raw `rev` object rather than the array's proxy, so nothing re-rendered — it
	 * only appeared to work because createRevision writes currentRevisionId
	 * immediately afterwards and that forced a re-read.
	 */
	const pushRevisionInternal = async (rev: EditorRevision): Promise<EditorRevision> => {
		revisions.value = [...revisions.value, rev]
		let stored = rev
		try {
			const res = await api.pushEditorRevision({ threadId: threadId.value, revision: deepClone(rev) })
			const pruned = new Set<string>(res?.prunedIds || [])
			stored = { ...rev, seq: res?.seq ?? rev.seq }
			revisions.value = revisions.value
				.filter((r) => !pruned.has(r.id))
				.map((r) => (r.id === rev.id ? stored : r))
		} catch (error) {
			console.error('[editorStore] pushEditorRevision failed:', error)
		}
		return stored
	}

	/** Lazy root bootstrap: the parent chain is never empty; zero migration. */
	const ensureRootRevision = async (): Promise<EditorRevision | null> => {
		if (!doc.value || !threadId.value) return null
		if (revisions.value.length === 0) {
			const root: EditorRevision = {
				id: (crypto as any).randomUUID ? crypto.randomUUID() : `rev-${Date.now()}`,
				parentId: null,
				seq: 0,
				origin: 'init',
				label: 'Original',
				snapshot: snapshotOfWorkingState(),
				createdAt: Date.now()
			}
			// Use the returned object: it carries the seq main assigned.
			const storedRoot = await pushRevisionInternal(root)
			doc.value.currentRevisionId = storedRoot.id
			markDirty()
			return storedRoot
		}
		// Revisions exist but the pointer dangles (crash window): re-point at the
		// newest WITHOUT touching the working doc.
		if (!currentRevision.value) {
			const newest = [...revisions.value].sort((a, b) => b.createdAt - a.createdAt)[0]
			doc.value.currentRevisionId = newest.id
			markDirty()
		}
		return currentRevision.value
	}

	const createRevision = async (options: {
		origin: 'ai' | 'manual'
		label?: string
		turnId?: string
		personaId?: string
	}): Promise<EditorRevision | null> => {
		if (!doc.value || !threadId.value) return null
		await ensureRootRevision()
		// Manual checkpoint with nothing changed = no-op (return the current node)
		if (options.origin === 'manual' && !revisionDirty.value) return currentRevision.value
		const rev: EditorRevision = {
			id: (crypto as any).randomUUID ? crypto.randomUUID() : `rev-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			parentId: doc.value.currentRevisionId || null,
			seq: 0,
			origin: options.origin,
			label: options.label?.trim() || (options.origin === 'ai' ? 'AI edit' : 'Checkpoint'),
			turnId: options.turnId,
			personaId: options.personaId,
			snapshot: snapshotOfWorkingState(),
			createdAt: Date.now()
		}
		// Callers render "V{seq}" off this, so return the stored object — the
		// local `rev` still has the placeholder seq of 0.
		const stored = await pushRevisionInternal(rev)
		doc.value.currentRevisionId = stored.id
		markDirty()
		return stored
	}

	/**
	 * Switches the working state to a revision's snapshot.
	 * Resets the fine-grained undo ring (its diffs were computed against
	 * pre-switch states — redo onto the switched snapshot would corrupt it).
	 */
	const switchRevision = async (id: string, options: { force?: boolean } = {}): Promise<boolean> => {
		if (!doc.value || !threadId.value) return false
		if (id === doc.value.currentRevisionId) return true
		const target = revisions.value.find((r) => r.id === id)
		if (!target) return false
		if (promptRunning.value) return false // blocked: completing turn would land on the wrong parent

		if (!options.force && revisionDirty.value) {
			const confirmed = await api.showConfirmation({
				title: 'Unsaved changes',
				message: 'Your timeline has changes not saved to a revision.',
				detail: 'Save them as a revision before switching, or discard them?',
				buttons: ['Cancel', 'Discard changes', 'Save & switch'],
				defaultId: 2,
				cancelId: 0
			})
			if (!confirmed || confirmed.response === 0) return false
			if (confirmed.response === 2) {
				await createRevision({ origin: 'manual', label: 'Manual save' })
			}
		}

		// Apply the snapshot
		const snap = deepClone(target.snapshot)
		// A revision taken before a media removal still holds that media's clips;
		// restoring it verbatim would put orphans straight back. Sanitised on the
		// way in only — the stored revision is a record of what was, not a mirror
		// of the present, so the sidecar on disk is left untouched.
		const snapState: TimelineState = { tracks: snap.tracks, timeline: snap.timeline }
		const dropped = pruneOrphanItems(snapState, new Set(doc.value.media.map((a) => a.id)))
		if (dropped.length) {
			console.warn(`[editorStore] V${target.seq}: dropped ${dropped.length} clip(s) whose media is gone`)
		}
		doc.value.tracks = snapState.tracks
		doc.value.timeline = snapState.timeline
		doc.value.timelineMeta = snap.timelineMeta
		doc.value.markers = snap.markers || []
		doc.value.currentRevisionId = id

		// Ring reset (local + sidecar; pointer-only reset would rehydrate stale steps)
		historySteps.value = []
		doc.value.historyRef = { currentStepId: '', stepCount: 0 }
		api.clearEditorHistory({ threadId: threadId.value })
			.catch((error: unknown) => console.error('[editorStore] clearEditorHistory failed:', error))

		// Hygiene
		clearItemSelection()
		refreshMetaDuration()
		seekTo(Math.min(playheadSec.value, contentEnd.value))
		lastResult.value = null
		markDirty()
		return true
	}

	const saveCheckpoint = async (label?: string): Promise<'saved' | 'clean' | null> => {
		if (!doc.value) return null
		await ensureRootRevision()
		if (!revisionDirty.value) return 'clean'
		const rev = await createRevision({ origin: 'manual', label: label || 'Checkpoint' })
		return rev ? 'saved' : null
	}

	const deleteRevisionSubtree = async (id: string): Promise<boolean> => {
		if (!doc.value || !threadId.value || promptRunning.value) return false
		const target = revisions.value.find((r) => r.id === id)
		if (!target || target.parentId === null) return false // root undeletable

		// Collect the subtree (chat's removeMessageBranch pattern)
		const ids = collectSubtree(revisions.value, id)

		// If current is inside, land on the subtree root's parent first
		if (ids.has(doc.value.currentRevisionId || '')) {
			const ok = await switchRevision(target.parentId)
			if (!ok) return false
		}

		const confirmed = await api.showConfirmation({
			title: 'Delete revisions',
			message: `Delete V${target.seq}${ids.size > 1 ? ` and ${ids.size - 1} descendant revision(s)` : ''}?`,
			detail: 'The timeline states saved in them will be lost. The current timeline is not affected.',
			buttons: ['Cancel', 'Delete']
		})
		if (!confirmed || confirmed.response !== 1) return false

		await api.deleteEditorRevisions({ threadId: threadId.value, ids: [...ids] })
		revisions.value = revisions.value.filter((r) => !ids.has(r.id))
		return true
	}

	const dismissResult = () => {
		lastResult.value = null
	}

	// ===== AI prompt actions (M3) =====
	// `override.widen` applies to THIS call only — it never rewrites the user's
	// scope chip. Used by "Keep building", which must see the whole timeline even
	// once it has grown past the chapter-window threshold.
	/** Hand a not-yet-open project its opening prompt. Cleared once consumed. */
	const queuePrompt = (id: string, text: string) => {
		pendingPrompt.value = text.trim() ? { threadId: id, text: text.trim() } : null
	}

	const runPrompt = async (prompt: string, override?: { widen?: 'chapter' | 'full' }) => {
		if (!threadId.value || !doc.value || promptRunning.value) return
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
				widen: override?.widen ?? (scopeWiden.value === 'auto' ? undefined : scopeWiden.value)
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
		// AI placements aren't gesture-clamped — push any same-track overlaps
		// right so the applied state always satisfies the M2 no-overlap invariant.
		repairOverlaps(applied)
		return { applied, pruned: result.errors }
	}

	const dismissAnswer = () => {
		lastAnswer.value = null
	}

	// ===== Export actions (M4 + background exports) =====
	const startExport = async (quality: 'original' | 'preview') => {
		if (!threadId.value || !canExport.value || !doc.value) return
		const tid = threadId.value
		const entry: RenderEntry = {
			threadId: tid,
			title: thread.value?.title || 'Export',
			renderId: '',
			percent: 0,
			phase: 'rendering',
			startedAt: Date.now()
		}
		renders.value = { ...renders.value, [tid]: entry }
		try {
			// Pass an in-memory SNAPSHOT of the live doc: the render detaches
			// from the editor entirely (keep editing / switch revision / load
			// another project), and the snapshot is never persisted.
			const snapshot = JSON.parse(JSON.stringify(doc.value))
			const result = await api.exportEditorTimeline({ threadId: tid, quality, doc: snapshot })
			if (result?.renderId && renders.value[tid]) {
				renders.value = { ...renders.value, [tid]: { ...renders.value[tid], renderId: result.renderId } }
			}
		} catch (error: any) {
			// Pre-flight rejection (missing files, missing media, empty timeline…).
			// Strip Electron's "Error invoking remote method '…': Error:" prefix so
			// the actionable part is what the user actually reads.
			renders.value = {
				...renders.value,
				[tid]: {
					...entry, phase: 'error',
					error: error?.message?.split('Error: ').pop() || 'Export failed to start'
				}
			}
		}
	}

	const abortExport = async () => {
		if (!renderState.value?.renderId) return
		await api.abortEditorRender({ renderId: renderState.value.renderId })
	}

	/** Dismiss a render entry (defaults to the current project's). */
	const clearRenderState = (tid?: string) => {
		const key = tid || threadId.value
		if (!key || !renders.value[key]) return
		const next = { ...renders.value }
		delete next[key]
		renders.value = next
	}

	/**
	 * Handles a completed/errored turn: the diff is APPLIED IMMEDIATELY and
	 * lands as a new revision (branching from the current one). No accept/
	 * reject — jumping back = switching to the parent revision.
	 */
	const onTurnUpdate = async (payload: {
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
			const markers = payload.addMarkers || []
			if (!hasOps(turn.diff) && !markers.length) {
				promptError.value = 'The AI proposed no changes. Try a more specific request.'
				return
			}

			// Validate against the live doc (prune stale ops + repair overlaps)
			const { applied, pruned } = dryRunProposal(turn.diff!)
			const before = currentState()
			const diffed = diffTimelines(before, applied)
			if (!diffed && !markers.length) {
				promptError.value = 'Nothing applicable — the timeline changed while the AI was working.'
				return
			}

			await ensureRootRevision()
			// Unsaved manual work is auto-checkpointed FIRST, so the AI revision's
			// parent snapshot is exactly the state the diff applied to and nothing
			// is ever stranded inside a child snapshot.
			if (revisionDirty.value) {
				await createRevision({ origin: 'manual', label: 'Auto checkpoint' })
			}

			const persona = findPersona(turn.personaId)
			if (diffed) {
				doc.value.tracks = applied.tracks
				doc.value.timeline = applied.timeline
				// Ring step preserved: Cmd+Z undoes the AI diff in place
				commitStep({ prebuilt: diffed, origin: 'ai', turnId: turn.id, label: persona?.name || 'AI edit' })
			}
			for (const m of markers) addMarker(m.time, m.label)

			const rev = await createRevision({
				origin: 'ai',
				turnId: turn.id,
				personaId: turn.personaId,
				label: persona?.name || 'AI edit'
			})
			if (rev && threadId.value) {
				api.updateEditorTurn({
					threadId: threadId.value,
					turnId: turn.id,
					patch: { resultStepId: doc.value.historyRef.currentStepId, revisionId: rev.id }
				}).catch(() => { /* non-critical */ })

				lastResult.value = {
					turnId: turn.id,
					revisionId: rev.id,
					revisionSeq: rev.seq,
					parentRevisionId: rev.parentId,
					counts: {
						added: diffed?.forward.addItems?.length || 0,
						removed: diffed?.forward.removeItemIds?.length || 0,
						updated: diffed?.forward.updateItems?.length || 0,
						markers: markers.length
					},
					rationale: turn.rationale,
					droppedOps: [...(turn.droppedOps || []), ...pruned],
					scopeLabel: turn.scopeLabel,
					thinContext: !!payload.thinContext,
					truncated: !!payload.truncated
				}
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
			doc.value.currentRevisionId = updated.editor.currentRevisionId
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

		if (api.onEditorSilenceProgress) {
			api.onEditorSilenceProgress((data: { assetId: string; percent: number }) => {
				if (silenceScanning.value) silenceScanPercent.value = data.percent
			})
		}

		if (api.onEditorTurnUpdate) {
			api.onEditorTurnUpdate((data: any) => {
				onTurnUpdate(data).catch((error: unknown) => {
					console.error('[editorStore] turn update failed:', error)
				})
			})
		}

		if (api.onEditorRenderProgress) {
			api.onEditorRenderProgress((data: {
				threadId: string; renderId: string; percent: number
				phase: 'rendering' | 'stitching' | 'done' | 'error'
				outputPath?: string; error?: string
			}) => {
				// Renders are background jobs — track progress for ANY thread,
				// not just the currently open project.
				const existing = renders.value[data.threadId]
				// Ignore stale renders (a fresh export may have started for this thread)
				if (existing?.renderId && data.renderId !== existing.renderId) return
				renders.value = {
					...renders.value,
					[data.threadId]: {
						threadId: data.threadId,
						title: existing?.title || 'Export',
						startedAt: existing?.startedAt || Date.now(),
						renderId: data.renderId,
						percent: data.percent,
						phase: data.phase,
						outputPath: data.outputPath,
						error: data.error
					}
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
		hasReadyMedia,
		mediaProcessing,
		selectedAsset,
		selectedClip,
		sortedTracks,
		itemsByTrack,
		contentEnd,
		timelineTail,
		markers,
		selectedItems,
		videoSegments,
		audioSegments,
		canUndo,
		canRedo,
		firstVideoTrackId,
		firstAudioTrackId,
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
		transcribeAsset,
		repairTranscript,
		modelLabelFor,
		clearAssetData,
		renameProject,
		redetectScenes,
		mergeSelectedClips,
		splitSelectedClips,
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
		addItemFromAsset,
		splitAtPlayhead,
		deleteItems,
		closeGaps,
		hasGaps,
		setItemSpeed,
		setItemTargetDuration,
		setItemPreservePitch,
		toggleItemMuted,
		setItemGain,
		setItemFade,
		nudgeItems,
		addMarker,
		removeMarker,
		findSilence,
		silenceScanning,
		silenceScanPercent,
		silenceScan,
		silenceNoiseDb,
		silenceMinDurationSec,
		scanSilence,
		clearSilenceScan,
		sourceTimeToTimeline,
		applySilenceRegions,
		toggleTrackFlag,
		addOverlayTrack,
		// personas
		personas,
		activePersona,
		personaGroups,
		promptDraft,
		queuePrompt,
		setActivePersona,
		savePersona,
		clonePersona,
		deletePersona,
		// AI prompt
		activeTurnId,
		lastAnswer,
		promptError,
		scopeWiden,
		promptRunning,
		scopePreview,
		runPrompt,
		abortPrompt,
		dismissAnswer,
		// revisions
		revisions,
		currentRevision,
		revisionDirty,
		revisionChildren,
		revisionHasBranch,
		lastResult,
		ensureRootRevision,
		createRevision,
		switchRevision,
		saveCheckpoint,
		deleteRevisionSubtree,
		dismissResult,
		// export
		renderState,
		renders,
		backgroundRenders,
		isRendering,
		canExport,
		exportWarnings,
		startExport,
		abortExport,
		clearRenderState
	}
})
