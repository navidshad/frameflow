import { defineStore } from 'pinia'
import { ref, shallowRef, computed, watch } from 'vue'
import type {
	BackgroundTask, Clip, EditorDocument, EditorHistoryStep, EditorMarker,
	EditorPersona, EditorRevision, EditorRevisionSummary, MediaAsset, RevisionSnapshot, PromptTurn, Thread, TimelineDiff,
	DeliveryFormat, SoundBinding, TimelineItem, TimelineItemTransform, TimelineSnapshot, Track
} from '@shared/types'
import {
	applyTimelineDiff, clampSpeed, clipToItem, computeContentEnd,
	closeTimelineGaps, diffTimelines, findOverlaps, itemDuration, itemEnd, itemFromAsset,
	pruneOrphanItems, repairOverlaps, repairOverlapsReporting,
	type TimelineState
} from '@shared/timeline'
import { computeScope } from '@shared/ai-scope'
import { engineRetry, type EngineRetry } from '@shared/engines'
import { hasTransform, TRANSFORM_DEFAULTS } from '@shared/transform'
import { isAnimatableOn, valueAt } from '@shared/keyframes'
import {
	freeMotionTrack, lengthAfterPageChange, motionAnimatablePaths, motionTemplate, newMotionSpec, nextMotionTrackName,
	renderVersion, resolveDefinition, sameMotion, type MotionDefinition, type MotionSettingValue, type MotionSpec
} from '@shared/motion'
import {
	describePrompt, editedSpec, failedSpec, fixPrompt, htmlHash, unverifiedPage, verifiedSpec,
	type CheckIssue, type RuntimeReport
} from '@shared/motionCode'
import { setUserMotionTemplates, userMotionTemplate, type MotionUserTemplate } from '@shared/motionTemplates'
import { planRangeRemoval } from '@shared/rangeEdit'
import { hasKey, KEY_DEFAULTS, type KeySpec } from '@shared/keying'
import { GENERATOR_DEFAULTS, GENERATORS, type GeneratorSpec } from '@shared/generators'
import { defaultParams, effectDef, registerEffects } from '@shared/effects'
import { parsePack } from '@shared/packs'
import {
	captionsFromTimeline, type CaptionCue, type TranscriptEntry
} from '@shared/captions'
import { sequenceFrame as resolveSequenceFrame } from '@shared/framing'
import { childrenByParent, collectSubtree, hasBranch, summarizeRevision } from '@shared/revision-tree'
import { DEFAULT_PERSONA_ID } from '@shared/personas'
import { agentChangeBadges, type AgentApplyOutcome } from '@shared/agentFeed'
import { toMediaUrl } from '@shared/media-url'
import { roleSpec, type AudioAnalysis, type TrackRole } from '@shared/audio'
import { applySoundBindings, boundStart, freeSoundTrack, suggestCues, type SoundCue } from '@shared/sound'
import { recipeKey, soundLead, soundLength, type SoundRecipe } from '@shared/synth'
import {
	canHostItem, findTitleTrack, hasLayerContent, isCompositedItem, nextTrackName, nextTrackOrder,
	orderedTracks, trackFamily, TITLE_TRACK_NAME
} from '@shared/tracks'
import { isTransitionKind, transitionLabel } from '@shared/transitionPresets'
import { seamFingerprint, type PreviewEntry } from '@shared/previewFrame'
import {
	MAX_TRANSITION_SEC, MIN_TRANSITION_SEC, planTransitions, seamAt, sourceDurationsFrom,
	type Seam
} from '@shared/transitionPlan'
import { dialog } from '../composables/useDialog'

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
	// `phase` marks yt-dlp self-heal detours (auto-update + retry) mid-import
	const urlImports = ref<Record<string, {
		url: string
		percent: number
		phase?: 'updating-ytdlp' | 'retrying'
	}>>({})
	const interruptedAssets = ref<Set<string>>(new Set())
	const dirty = ref(false)
	const saveInFlight = ref(false)
	const deps = ref<{ ffmpeg: boolean; ytDlp: boolean }>({
		ffmpeg: true,
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
	/** UI state the keyboard reaches but the timeline does not own. */
	const shortcutsOpen = ref(false)
	const monitorFullscreen = ref(false)
	/** Which framing guide the monitor draws, if any. A view setting, not an edit. */
	const activeGuideId = ref<string | null>(null)
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
	// Summaries only. A snapshot can be megabytes of motion page HTML, so only
	// the current revision's is held (for revisionDirty), and a switch fetches
	// the target's from main.
	const revisions = ref<EditorRevisionSummary[]>([])
	const currentSnapshot = shallowRef<{ threadId: string; id: string; snapshot: RevisionSnapshot } | null>(null)

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

	// ===== External agents (MCP) =====
	/**
	 * Items the agent's latest edit touched, with their badge ("AI", "−2.4s"),
	 * and the revision it made: the timeline's dashed violet outlines and the
	 * "changed by the agent in V8" legend. Cleared on any revision switch.
	 */
	const agentMarks = ref<Record<string, string>>({})
	const agentMarksSeq = ref<number | null>(null)
	const clearAgentMarks = () => {
		agentMarks.value = {}
		agentMarksSeq.value = null
	}

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
	/**
	 * The lanes top to bottom: video family first with the FRONT-MOST layer at
	 * the top, then audio. Sorting every track into one ascending list put a new
	 * video lane underneath the audio — and had the timeline reading the picture
	 * upside down, since the compositor takes the HIGHEST order as the front.
	 */
	const sortedTracks = computed<Track[]>(() => orderedTracks(doc.value?.tracks || []))

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

	// ===== Captions =====

	/** Transcripts by asset id, in SOURCE seconds. Fetched from the main process,
	 *  which owns the files; refreshed whenever a transcript lands or moves. */
	const transcripts = ref<Record<string, TranscriptEntry[]>>({})

	const refreshTranscripts = async () => {
		if (!threadId.value) return
		try {
			transcripts.value = await api.getEditorTranscripts(threadId.value) || {}
		} catch (error) {
			console.error('[editorStore] transcript fetch failed:', error)
		}
	}

	/**
	 * Every caption the sequence shows, from the SAME function the export burns
	 * with — so what the monitor draws is what ends up in the file.
	 */
	const captionCues = computed<CaptionCue[]>(() => {
		if (!doc.value?.captionsEnabled) return []
		return captionsFromTimeline(doc.value, transcripts.value)
	})

	const captionsEnabled = computed(() => doc.value?.captionsEnabled === true)

	/**
	 * The spoken words on the timeline, whether or not captions are switched on.
	 *
	 * `captionCues` answers "what is burned in"; this answers "what is said",
	 * which is what a transcript panel and word-level editing need — you should
	 * be able to cut a sentence without turning captions on first.
	 */
	const transcriptCues = computed<CaptionCue[]>(() =>
		doc.value ? captionsFromTimeline(doc.value, transcripts.value) : []
	)

	/**
	 * Every spoken word with its own start, for snapping keyframes to speech.
	 * Transcripts are timed per phrase; this is the captions' own estimate with
	 * one word per cue, so a key lands where the caption shows the word.
	 */
	const transcriptWords = computed<CaptionCue[]>(() =>
		doc.value ? captionsFromTimeline(doc.value, transcripts.value, { maxWords: 1, minCueSec: 0 }) : []
	)

	/** Whether there is anything to caption — the toggle is dead weight without it. */
	const hasTranscript = computed(() => {
		const d = doc.value
		if (!d) return false
		return d.timeline.some((i) => transcripts.value[i.sourceAssetId]?.length)
	})

	/** Project-level, and NOT undoable: it is a setting, like markers. */
	const setCaptionsEnabled = (enabled: boolean) => {
		if (!doc.value) return
		doc.value.captionsEnabled = enabled
		markDirty()
	}

	/**
	 * Say what an audio track is for. A music bed ducks under speech everywhere
	 * else; voice and sfx say what the content is so the mix can level it.
	 * `undefined` clears it: the track is then speech, as far as ducking goes.
	 */
	const setTrackRole = (trackId: string, role: TrackRole | undefined) => {
		const track = doc.value?.tracks.find((t) => t.id === trackId)
		if (!track || track.kind !== 'audio' || track.role === role) return
		const before = snapshotState()
		if (role) track.role = role
		else delete track.role
		const spec = roleSpec(role)
		commitStep({ before, label: spec ? `Mark ${track.name} as ${spec.label.toLowerCase()}` : `Clear role on ${track.name}` })
	}

	/** The old music-bed switch, kept for callers that only know that one. */
	const toggleTrackMusic = (trackId: string) => {
		const track = doc.value?.tracks.find((t) => t.id === trackId)
		if (track) setTrackRole(trackId, track.role === 'music' ? undefined : 'music')
	}

	// ===== What the sources sound like =====

	/**
	 * Waveform and loudness per asset, measured in the main process the first time
	 * something asks and cached on disk, so a reload costs nothing. Reactive: a
	 * clip draws a flat line until its source's analysis lands, then redraws.
	 */
	const audioAnalysis = ref<Record<string, AudioAnalysis>>({})
	const audioAnalysisPending = new Set<string>()

	const ensureAudioAnalysis = async (assetId: string) => {
		if (!threadId.value || audioAnalysis.value[assetId] || audioAnalysisPending.has(assetId)) return
		audioAnalysisPending.add(assetId)
		try {
			audioAnalysis.value[assetId] = await api.getAudioAnalysis({ threadId: threadId.value, assetId })
		} catch (error) {
			console.warn('[audio] analysis failed for', assetId, error)
		} finally {
			audioAnalysisPending.delete(assetId)
		}
	}

	// ===== Sounds =====

	/** What a preview call returns: the rendered file and a few bars of its shape. */
	type SoundPreview = { path: string; lengthSec: number; ms: number; peaks: number[] }
	const soundPreviews = ref<Record<string, SoundPreview>>({})
	const soundPreviewPending = new Map<string, Promise<SoundPreview | null>>()

	/** Render (or fetch from the cache) a recipe for auditioning. */
	const previewSound = (recipe: SoundRecipe): Promise<SoundPreview | null> => {
		const key = recipeKey(recipe)
		if (soundPreviews.value[key]) return Promise.resolve(soundPreviews.value[key])
		if (!threadId.value) return Promise.resolve(null)
		const pending = soundPreviewPending.get(key)
		if (pending) return pending
		const request = api.previewSound({ threadId: threadId.value, recipe })
			.then((out: SoundPreview) => { soundPreviews.value[key] = out; return out })
			.catch((error: unknown) => { console.warn('[sound] preview failed:', error); return null })
			.finally(() => soundPreviewPending.delete(key))
		soundPreviewPending.set(key, request)
		return request
	}

	let auditionEl: HTMLAudioElement | null = null
	/** Play a recipe once, cutting off whatever was auditioning. */
	const auditionSound = async (recipe: SoundRecipe) => {
		const out = await previewSound(recipe)
		if (!out) return
		auditionEl?.pause()
		auditionEl = new Audio(toMediaUrl(out.path))
		void auditionEl.play().catch(() => { /* a blocked autoplay is not worth a message */ })
	}
	const stopAudition = () => { auditionEl?.pause(); auditionEl = null }

	/** The audio track a sound should go on: a free lane of its role (effects by default), else a new one. */
	const soundTrackFor = (start: number, length: number, ignoreItemId?: string, role: TrackRole = 'sfx'): string | null => {
		if (!doc.value) return null
		const free = freeSoundTrack(currentState(), start, length, ignoreItemId, role)
		if (free) return free
		const track: Track = {
			id: newId('tr'), kind: 'audio', name: nextTrackName(doc.value.tracks, 'audio'),
			order: nextTrackOrder(doc.value.tracks, 'audio'), muted: false, locked: false, hidden: false, height: 48,
			role
		}
		doc.value.tracks.push(track)
		return track.id
	}

	interface SoundRequest { recipe: SoundRecipe; bind?: SoundBinding; atSec?: number }

	/**
	 * Add sounds to the timeline in ONE undo step. Each is rendered to a file by
	 * ffmpeg first (cached by recipe, so a repeat is instant), then placed on a
	 * free effects lane at its moment — or at the playhead — with its lead, and
	 * set to follow the moment when it has one.
	 */
	const addSounds = async (requests: SoundRequest[], label?: string): Promise<TimelineItem[]> => {
		if (!doc.value || !threadId.value || !requests.length) return []
		const assets: MediaAsset[] = await Promise.all(
			requests.map((r) => api.ensureSoundAsset({ threadId: threadId.value, recipe: r.recipe }))
		)
		if (!doc.value) return []
		assets.forEach(upsertAsset)

		const before = snapshotState()
		const added: TimelineItem[] = []
		requests.forEach((req, i) => {
			const asset = assets[i]
			const length = asset.metadata?.duration || soundLength(req.recipe)
			const target = req.bind ? doc.value!.timeline.find((t) => t.id === req.bind!.itemId) : undefined
			const bind: SoundBinding | undefined = target && req.bind
				? { ...req.bind, leadSec: req.bind.leadSec ?? soundLead(req.recipe) }
				: undefined
			const wanted = target && bind ? boundStart(target, bind) : Math.max(0, req.atSec ?? playheadSec.value)
			const trackId = soundTrackFor(wanted, length)
			if (!trackId) return
			const start = bind ? wanted : resolveFreePosition(trackId, wanted, length)
			const item = itemFromAsset(asset, trackId, start, length)
			if (bind) item.bind = bind
			doc.value!.timeline.push(item)
			added.push(item)
		})
		if (!added.length) return []
		commitStep({ before, label: label ?? (added.length === 1 ? `Add ${assets[0].name.toLowerCase()} sound` : `Add ${added.length} sounds`) })
		selectItems(added.map((i) => i.id))
		return added
	}

	const addSound = async (recipe: SoundRecipe, opts: { atSec?: number; bind?: SoundBinding } = {}) =>
		(await addSounds([{ recipe, ...opts }]))[0] ?? null

	// ===== Generated audio (a provider made it once; from here it is a file) =====

	/** Voices, effects and music made for this project, newest first. */
	const generatedAssets = computed(() =>
		(doc.value?.media ?? []).filter((a) => a.generated).sort((a, b) => (b.generated!.madeAt - a.generated!.madeAt))
	)

	/**
	 * Put a generated sound on the timeline at the playhead (or `atSec`), on a free
	 * lane of its kind: a voice-over goes on a voice lane, music on a music lane.
	 * One undo step. The asset is already in the project; this only places it.
	 */
	const placeGeneratedAudio = (asset: MediaAsset, opts: { atSec?: number } = {}): TimelineItem | null => {
		if (!doc.value || asset.kind !== 'audio') return null
		upsertAsset(asset)
		const length = asset.metadata?.duration || 0
		if (length <= 0) return null
		const capability = asset.generated?.capability
		const role: TrackRole = capability === 'speech' ? 'voice' : capability === 'music' ? 'music' : 'sfx'
		const before = snapshotState()
		const wanted = Math.max(0, opts.atSec ?? playheadSec.value)
		const trackId = soundTrackFor(wanted, length, undefined, role)
		if (!trackId) return null
		const item = itemFromAsset(asset, trackId, resolveFreePosition(trackId, wanted, length), length)
		doc.value.timeline.push(item)
		commitStep({ before, label: `Add ${capability === 'speech' ? 'voice-over' : capability === 'music' ? 'music' : 'sound effect'}` })
		selectItems([item.id])
		return item
	}

	/** Play a generated (or any audio) asset once, cutting off whatever was auditioning. */
	const auditionAsset = (asset: MediaAsset) => {
		auditionEl?.pause()
		auditionEl = new Audio(toMediaUrl(asset.originalPath))
		void auditionEl.play().catch(() => { /* a blocked autoplay is not worth a message */ })
	}

	/** A synthesised sound's recipe, if that is what the clip is. */
	const soundRecipeOf = (itemId: string): Required<SoundRecipe> | null => {
		const item = doc.value?.timeline.find((i) => i.id === itemId)
		return doc.value?.media.find((a) => a.id === item?.sourceAssetId)?.synth ?? null
	}

	/**
	 * Change what a sound is — its take, pitch, level, air or seed. A recipe is a
	 * file's identity, so this renders the new one and points the clip at it.
	 */
	const setSoundRecipe = async (itemId: string, patch: Partial<SoundRecipe>) => {
		if (!doc.value || !threadId.value) return
		const current = soundRecipeOf(itemId)
		if (!current) return
		const next: SoundRecipe = { ...current, ...patch }
		if (recipeKey(next) === recipeKey(current)) return
		const asset: MediaAsset = await api.ensureSoundAsset({ threadId: threadId.value, recipe: next })
		if (!doc.value) return
		const item = doc.value.timeline.find((i) => i.id === itemId)
		if (!item) return
		upsertAsset(asset)
		const before = snapshotState()
		const length = asset.metadata?.duration || soundLength(next)
		item.sourceAssetId = asset.id
		item.in = 0
		item.out = length
		item.duration = length / (item.speed || 1)
		item.label = asset.name
		// A different kind of sound has its own lead: keep the hit on the moment.
		if (item.bind && patch.kind && patch.kind !== current.kind) item.bind = { ...item.bind, leadSec: soundLead(next) }
		commitStep({ before, label: `Change ${asset.name.toLowerCase()}` })
		// The old file's asset stays in the project: undo has to be able to point the
		// clip back at it. The Media panel only lists sounds something still uses.
	}

	/** Roll the noise again: the same sound with a different seed. */
	const rerollSound = (itemId: string) => {
		const current = soundRecipeOf(itemId)
		if (current) void setSoundRecipe(itemId, { seed: current.seed + 1 })
	}

	/** Make a sound follow a moment (or, with no binding, stop following). */
	const bindSound = (itemId: string, bind: SoundBinding | undefined) => {
		if (!doc.value) return
		const item = doc.value.timeline.find((i) => i.id === itemId)
		if (!item || item.bind === bind) return
		const before = snapshotState()
		if (!bind) delete item.bind
		else {
			const recipe = soundRecipeOf(itemId)
			item.bind = { ...bind, leadSec: bind.leadSec ?? (recipe ? soundLead(recipe) : 0) }
		}
		commitStep({ before, label: bind ? 'Make the sound follow' : 'Stop following' })
	}

	/** Dragging a following sound by hand is a choice to place it: it stops following. */
	const releaseSoundBinding = (itemId: string) => {
		const item = doc.value?.timeline.find((i) => i.id === itemId)
		if (item?.bind) delete item.bind
	}

	/** The moments worth a sound on this timeline (see shared/sound.ts). */
	const soundCues = computed<SoundCue[]>(() => (doc.value ? suggestCues(currentState()) : []))

	// ===== Titles =====

	const DEFAULT_TITLE_SEC = 3

	/**
	 * Add a title at the playhead, making its lane if there is not one.
	 *
	 * The lane is an ordinary VIDEO track named `T1`, the same way a generated
	 * background is the video track named `BG`. Titles burn over the finished
	 * picture from wherever they sit, so the lane is only there to give a title
	 * somewhere to be that is not already occupied by a clip.
	 *
	 * A title item carries no `sourceAssetId` — it references no media — which
	 * is why `findOrphanItems` exempts anything holding a `text` spec. Without
	 * that, main would read the empty id as media that had been removed and
	 * prune the title on the next autosave.
	 */
	const addTitle = (content = 'Title') => {
		if (!doc.value) return null
		const before = snapshotState()
		let track = findTitleTrack(doc.value.tracks)
		if (!track) {
			track = {
				id: newId('tr'), kind: 'video', name: TITLE_TRACK_NAME,
				order: nextTrackOrder(doc.value.tracks, 'video'),
				muted: false, locked: false, hidden: false, height: 40
			}
			doc.value.tracks.push(track)
		}
		const start = Math.max(0, playheadSec.value)
		const id = newId('ti')
		doc.value.timeline.push({
			id, trackId: track.id, sourceAssetId: '',
			timelineStart: start, in: 0, out: DEFAULT_TITLE_SEC,
			speed: 1, preservePitch: true, duration: DEFAULT_TITLE_SEC,
			label: content,
			text: { content }
		})
		commitStep({ before, label: 'Add title' })
		selectItems([id])
		return id
	}

	/** Generated layers covering the playhead — the monitor draws them in CSS. */
	const activeGenerators = computed(() => {
		const d = doc.value
		if (!d) return []
		const hidden = new Set(d.tracks.filter((t) => t.hidden).map((t) => t.id))
		const t = playheadSec.value
		return d.timeline.filter((i) =>
			i.generator && !hidden.has(i.trackId) &&
			t >= i.timelineStart && t < i.timelineStart + i.duration
		)
	})

	/**
	 * Motion layers covering the playhead — the monitor gives each one a
	 * sandboxed page. Bottom-most first, so DOM order matches stacking order.
	 */
	const activeMotion = computed(() => {
		const d = doc.value
		if (!d) return []
		const hidden = new Set(d.tracks.filter((t) => t.hidden).map((t) => t.id))
		const order = new Map(d.tracks.map((t) => [t.id, t.order]))
		const t = playheadSec.value
		return d.timeline
			.filter((i) => i.motion && !hidden.has(i.trackId) && t >= i.timelineStart && t < i.timelineStart + i.duration)
			.sort((a, b) => (order.get(a.trackId) ?? 0) - (order.get(b.trackId) ?? 0))
	})

	/**
	 * Where each motion layer's content sits on the frame, as fractions — what
	 * its page reported after the last seek. The gizmo draws its handles round
	 * this rather than round the whole frame.
	 */
	const motionBounds = ref<Record<string, { x: number; y: number; w: number; h: number } | null>>({})

	/** The template being dragged from the library, so lanes can light up. */
	const draggingMotionTemplate = ref<string | null>(null)

	/** Titles covering the playhead, so the monitor can draw them. */
	const activeTitles = computed(() => {
		const d = doc.value
		if (!d) return []
		const hidden = new Set(d.tracks.filter((t) => t.hidden).map((t) => t.id))
		const t = playheadSec.value
		return d.timeline.filter((i) =>
			i.text?.content?.trim() &&
			!hidden.has(i.trackId) &&
			t >= i.timelineStart && t < i.timelineStart + i.duration
		)
	})

	const setTitle = (itemId: string, patch: Partial<NonNullable<TimelineItem['text']>>) => {
		const item = doc.value?.timeline.find((i) => i.id === itemId)
		if (!item?.text) return
		const before = snapshotState()
		// Replace, never mutate — the diff compares by value.
		item.text = { ...item.text, ...patch }
		if (patch.content !== undefined) item.label = patch.content
		commitStep({ before, label: 'Edit title' })
	}

	// ===== Loudness =====

	const loudnessEnabled = computed(() => doc.value?.loudnessEnabled === true)

	/** Project-level and not undoable, exactly like captions. */
	const setLoudnessEnabled = (enabled: boolean) => {
		if (!doc.value) return
		doc.value.loudnessEnabled = enabled
		markDirty()
	}

	// Transcripts live on disk and arrive from preprocessing, not from an edit —
	// so the trigger is a transcript appearing, moving or being cleared. The
	// preprocess state rides along because a RE-transcribe rewrites the same
	// path, and the path alone would look unchanged.
	watch(
		() => (doc.value?.media || [])
			.map((a) => `${a.id}:${a.preprocessing?.transcriptPath || ''}:${a.preprocessState || ''}`)
			.join('|'),
		() => { void refreshTranscripts() },
		{ immediate: true }
	)

	/**
	 * The shape this project exports in. Resolved through the same function the
	 * render uses, so the frame drawn in the monitor is the frame that encodes.
	 */
	const sequenceFrame = computed(() => {
		const d = doc.value
		if (!d) return { width: 1920, height: 1080 }
		const used = new Set(d.timeline.map((i) => i.sourceAssetId))
		return resolveSequenceFrame(
			d.timelineMeta,
			d.media.filter((a) => used.has(a.id) && a.kind !== 'audio').map((a) => a.metadata ?? {})
		)
	})

	const contentEnd = computed(() => computeContentEnd(doc.value?.timeline || []))
	/** Motion pages, backgrounds or titles are showing — content the footage segments never list. */
	const hasLayers = computed(() => hasLayerContent(doc.value?.timeline || [], doc.value?.tracks || []))
	const timelineTail = computed(() => Math.max(60, 0.25 * contentEnd.value))

	const markers = computed<EditorMarker[]>(() => doc.value?.markers || [])

	const selectedItems = computed<TimelineItem[]>(() =>
		(doc.value?.timeline || []).filter((i) => selectedItemIds.value.includes(i.id))
	)

	/**
	 * Every cut between adjacent video clips, with what a transition there could
	 * support and the window any annotation resolves to. One list serves the drag
	 * affordance, the timeline blocks and the inspector.
	 *
	 * VIDEO tracks only: findJunctions pairs whatever it is given, and the export
	 * planner passes video items for the same reason.
	 */
	const seams = computed<Seam[]>(() => {
		if (!doc.value) return []
		const videoTrackIds = new Set(
			doc.value.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id)
		)
		return planTransitions(
			doc.value.timeline.filter((i) => videoTrackIds.has(i.trackId)),
			sourceDurationsFrom(doc.value.media)
		)
	})

	/**
	 * Junction ids whose window a clip on ANOTHER video track crosses — the
	 * exact condition the export refuses with a throw (render.ts). Computed
	 * here so the timeline can say so while you are still editing, instead of
	 * the export failing after you have waited for it.
	 */
	const conflictedSeamIds = computed<Set<string>>(() => {
		const out = new Set<string>()
		const d = doc.value
		if (!d) return out
		const videoTrackIds = new Set(
			d.tracks.filter((t) => t.kind === 'video' && !t.hidden).map((t) => t.id)
		)
		for (const seam of seams.value) {
			const w = seam.window
			if (!w) continue
			const clash = d.timeline.some((i) =>
				i.trackId !== w.trackId && videoTrackIds.has(i.trackId) &&
				i.timelineStart < w.end - 1e-6 && itemEnd(i) > w.start + 1e-6
			)
			if (clash) out.add(w.junctionId)
		}
		return out
	})

	/** Ephemeral, like silenceScan — a seam is not an item, so it stays out of
	 *  doc.selection, which pruneSelection would strip of any non-item id. */
	const selectedSeamId = ref<string | null>(null)
	const selectedSeam = computed<Seam | null>(() =>
		seams.value.find((s) => s.junction.id === selectedSeamId.value) || null
	)
	const selectSeam = (id: string | null) => {
		selectedSeamId.value = id
		if (id) clearItemSelection()
	}

	/**
	 * Cached exact previews of each transition window, junction id -> state.
	 *
	 * The monitor stacks two <video> elements, so unaided it can only cross-fade
	 * — a wipe or a slide would preview as a dissolve. Instead the main process
	 * renders each window with the real filter and the monitor plays that file;
	 * the cross-fade is only the stand-in until it lands.
	 *
	 * Ephemeral and never persisted: the files live in the thread's temp dir.
	 */
	const transitionPreviews = ref<Map<string, PreviewEntry>>(new Map())

	const setPreview = (junctionId: string, entry: PreviewEntry) => {
		const next = new Map(transitionPreviews.value)
		next.set(junctionId, entry)
		transitionPreviews.value = next
	}

	/** Items the EDL can actually play. `seams` keeps clips whose media is gone;
	 *  blending against one that will never load would just show black. */
	const playableItemIds = computed(() => new Set(videoSegments.value.map((s) => s.itemId)))

	let previewTimer: ReturnType<typeof setTimeout> | null = null

	/** Ask main for any window we do not have yet. Debounced, because dragging the
	 *  duration slider would otherwise queue an encode per step. */
	const requestTransitionPreviews = () => {
		if (previewTimer) clearTimeout(previewTimer)
		previewTimer = setTimeout(async () => {
			if (!doc.value || !threadId.value) return
			const wanted = seams.value.filter((s) => s.window)
			if (!wanted.length) return
			const snapshot = JSON.parse(JSON.stringify(doc.value))
			for (const seam of wanted) {
				const id = seam.junction.id
				if (transitionPreviews.value.get(id)?.status === 'rendering') continue
				setPreview(id, { status: 'rendering' })
				try {
					const result = await api.ensureTransitionPreview({
						threadId: threadId.value,
						doc: snapshot,
						outgoingId: seam.junction.outgoing.id,
						incomingId: seam.junction.incoming.id
					})
					setPreview(id, { status: 'ready', src: toMediaUrl(result.path) })
				} catch (error) {
					console.warn('[preview] transition render failed:', error)
					setPreview(id, { status: 'error' })
				}
			}
		}, 400)
	}

	// Re-request whenever a window's geometry OR either flanking clip's render
	// state changes. The fingerprint deliberately includes the WHOLE items:
	// enumerating "render-relevant" fields is how the main-side cache key went
	// stale, and over-triggering costs nothing — main hashes the actual graph,
	// so a no-op change (a label edit) resolves to the same file instantly.
	watch(() => {
		const flanks = seams.value
			.filter((s) => s.window)
			.map((s) => JSON.stringify([s.junction.outgoing, s.junction.incoming]))
			.join('\u0000')
		return `${seamFingerprint(seams.value)}#${flanks}`
	}, (next, previous) => {
		if (next === previous) return
		transitionPreviews.value = new Map()
		if (next) requestTransitionPreviews()
	})

	/** The preset kind currently being dragged, so lanes know to reveal seams. */
	const draggingTransitionKind = ref<string | null>(null)

	/** Seam nearest `t`, within a tolerance the caller derives from zoom. */
	const seamNear = (t: number, toleranceSec: number) => seamAt(seams.value, t, toleranceSec)

	/** Visible video tracks, bottom-most first — the render's stacking order. */
	const visibleVideoTracks = computed(() =>
		(doc.value?.tracks ?? [])
			.filter((t) => t.kind === 'video' && !t.hidden)
			.sort((a, b) => a.order - b.order)
	)

	/**
	 * Video tracks the monitor's <video> pair can actually play — ones carrying
	 * at least one item with a real file behind it.
	 *
	 * A generated background is a video track with no footage on it, and it sits
	 * BELOW everything by design. Taking the lowest track as the timebase would
	 * hand the pair a track with nothing to play and blank the monitor, which is
	 * exactly what happened the first time a background was added.
	 */
	const playableVideoTracks = computed(() => {
		const withMedia = new Set(
			(doc.value?.timeline ?? [])
				// Generated and motion layers draw themselves; neither is a file
				// the <video> pair could play.
				.filter((i) => !i.generator && !i.motion && isCompositedItem(i))
				.map((i) => i.trackId)
		)
		return visibleVideoTracks.value.filter((t) => withMedia.has(t.id))
	})

	/** The layer everything else composites onto, and the monitor's timebase. */
	const baseVideoTrackId = computed(() => playableVideoTracks.value[0]?.id ?? null)

	/**
	 * How deep each video track sits, 1 = furthest back.
	 *
	 * The export composites by `order`, higher in front (`render.ts` sorts the
	 * tracks by it). The monitor used to draw generated layers under every video
	 * element unconditionally, on the assumption that a generator is a
	 * background — which stopped being true when anything visible could share a
	 * video track: a gradient on the TOP lane belongs in front of the footage,
	 * and previewing it behind hid it completely. One number, read by every
	 * layer the monitor stacks, so the picture agrees with the render.
	 */
	const videoLayerDepth = computed<Record<string, number>>(() => {
		const depth: Record<string, number> = {}
		visibleVideoTracks.value.forEach((track, i) => { depth[track.id] = i + 1 })
		return depth
	})

	const segmentsForTracks = (trackIds: Set<string>) => {
		if (!doc.value || !trackIds.size) return []
		const trackById = new Map(doc.value.tracks.map((t) => [t.id, t]))
		const trackMuted = new Map(doc.value.tracks.map((t) => [t.id, t.muted]))
		const assetById = new Map(doc.value.media.map((a) => [a.id, a]))

		return doc.value.timeline
			.filter((item) => trackIds.has(item.trackId))
			.sort((a, b) => a.timelineStart - b.timelineStart)
			.flatMap((item) => {
				const asset = assetById.get(item.sourceAssetId)
				const src = asset ? (asset.proxyPath || asset.originalPath) : null
				if (!src) return []
				return [{
					itemId: item.id,
					tStart: item.timelineStart,
					tEnd: itemEnd(item),
					src: toMediaUrl(src),
					sourceIn: item.in,
					speed: item.speed || 1,
					muted: !!item.muted || !!trackMuted.get(item.trackId),
					// The MIX state, so the monitor plays what the export mixes.
					// These were simply absent, so a video clip's gain and fades
					// were silently ignored in preview — while the inspector
					// claimed otherwise. Gain multiplies item × track, the same
					// product `effectiveGain` gives the export.
					gain: (item.gain ?? 1) * (trackById.get(item.trackId)?.gain ?? 1),
					fadeInSec: item.fadeInSec ?? 0,
					fadeOutSec: item.fadeOutSec ?? 0,
					preservePitch: item.preservePitch !== false
				}]
			})
	}

	/**
	 * Ordered playable segments for the monitor's A/B pair.
	 *
	 * Only the BASE track: the pair assumes its segments never overlap, and two
	 * video tracks overlap by definition — that is what compositing is. Higher
	 * layers get their own element below.
	 */
	const videoSegments = computed(() =>
		segmentsForTracks(new Set(baseVideoTrackId.value ? [baseVideoTrackId.value] : []))
	)

	/**
	 * The layer drawn ON TOP of the pair, from the highest visible video track.
	 *
	 * One layer, not n: the monitor has one overlay element. The export
	 * composites every layer, so a three-track stack still renders correctly —
	 * it just previews as base plus top.
	 */
	const overlaySegments = computed(() => {
		const tracks = playableVideoTracks.value
		if (tracks.length < 2) return []
		return segmentsForTracks(new Set([tracks[tracks.length - 1].id]))
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
					src: toMediaUrl(src),
					sourceIn: item.in,
					speed: item.speed || 1,
					muted: !!item.muted || !!trackMuted.get(item.trackId),
					// Item × track, as the export mixes it — track gain was dropped.
					gain: (item.gain ?? 1) * (doc.value!.tracks.find((t) => t.id === item.trackId)?.gain ?? 1),
					preservePitch: item.preservePitch !== false,
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
	/**
	 * An outside agent holds this project (an open MCP round; the agent store
	 * sets it). The user's own exports and revision switches wait until it ends.
	 */
	const agentHolds = ref<string | null>(null)

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

	const currentRevision = computed<EditorRevisionSummary | null>(() =>
		revisions.value.find((r) => r.id === doc.value?.currentRevisionId) || null
	)

	/**
	 * Working state differs from the current revision's snapshot. False while
	 * that snapshot is still being fetched — every action that acts on this
	 * (switch, checkpoint) awaits ensureCurrentSnapshot() first.
	 */
	const revisionDirty = computed(() => {
		const rev = currentRevision.value
		const held = currentSnapshot.value
		if (!rev || !doc.value || !held || held.id !== rev.id || held.threadId !== threadId.value) return false
		const snap = held.snapshot
		if (diffTimelines(
			{ tracks: snap.tracks, timeline: snap.timeline, motionKits: snap.motionKits ?? [] },
			{ tracks: doc.value.tracks, timeline: doc.value.timeline, motionKits: doc.value.motionKits ?? [] }
		) !== null) return true
		// Markers live outside TimelineDiff, so the timeline comparison above is
		// blind to them. Without this, marker-only work counts as "clean" and
		// switchRevision overwrites it with no checkpoint and no undo.
		return markersDiffer(snap.markers || [], doc.value.markers || [])
	})

	/** Fetches one revision's snapshot from main; null when it is gone or damaged. */
	const fetchRevisionSnapshot = async (id: string): Promise<RevisionSnapshot | null> => {
		if (!threadId.value) return null
		try {
			return (await api.getEditorRevisionSnapshot({ threadId: threadId.value, revisionId: id })) || null
		} catch (error) {
			console.error('[editorStore] getEditorRevisionSnapshot failed:', error)
			return null
		}
	}

	/** Makes sure the current revision's snapshot is held, so revisionDirty is accurate. */
	const ensureCurrentSnapshot = async (): Promise<void> => {
		const id = doc.value?.currentRevisionId
		const thread = threadId.value
		// Not listed yet (still loading) or dangling (cleared on load): nothing to fetch.
		if (!id || !thread || !revisions.value.some((r) => r.id === id)) return
		const held = currentSnapshot.value
		if (held && held.id === id && held.threadId === thread) return
		const snapshot = await fetchRevisionSnapshot(id)
		// The project or pointer may have moved on while this was in flight.
		if (snapshot && doc.value?.currentRevisionId === id && threadId.value === thread) {
			currentSnapshot.value = { threadId: thread, id, snapshot }
		}
	}
	// The pointer also moves outside the actions above (an agent's revision
	// arriving through thread-updated, a dangling pointer re-aimed on load).
	watch(() => [threadId.value, doc.value?.currentRevisionId], () => { void ensureCurrentSnapshot() })

	/** Children grouped by parentId (null key = root), createdAt-sorted. */
	const revisionChildren = computed<Map<string | null, EditorRevisionSummary[]>>(
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
	/**
	 * Chat has something to work on: footage that is ready, or layers (motion pages,
	 * backgrounds, titles) that need no footage. A motion-only timeline used to be
	 * told to "import media to start" with the input disabled — so the AI could not
	 * be asked to make the very thing the timeline is for.
	 */
	const canPrompt = computed(() => hasReadyMedia.value || hasLayers.value)
	const mediaProcessing = computed(() =>
		assets.value.some((a) => a.preprocessState === 'running' || a.preprocessState === 'pending')
	)

	const canExport = computed(() => {
		if (!doc.value || isRendering.value || agentHolds.value) return false
		// ANY visible video lane carrying a picture will do. Asking the lowest one
		// specifically was already wrong the day generated backgrounds landed —
		// `BG` sits below everything, so an export with a background and footage
		// above it was judged on the wrong lane.
		const lanes = new Set(visibleVideoTracks.value.map((t) => t.id))
		return doc.value.timeline.some((i) => lanes.has(i.trackId) && isCompositedItem(i))
	})

	/**
	 * Pre-flight export warnings (PRD §5.9): content that exists on the timeline
	 * but will be missing from the render — muted/hidden tracks with clips,
	 * individually muted clips. Warnings with an `action`
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
			if (count === 0) continue
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
			return i.muted && track && !track.muted && !track.hidden
		})
		if (mutedItems.length > 0) {
			warnings.push({
				id: 'muted-items',
				text: `${plural(mutedItems.length)} ${mutedItems.length === 1 ? 'has' : 'have'} muted audio and won't be heard in the export.`
			})
		}

		if (doc.value.loudnessEnabled) {
			warnings.push({
				id: 'loudness',
				text: 'The mix will be normalised to -14 LUFS, the level streaming platforms expect.'
			})
		}

		if (conflictedSeamIds.value.size) {
			warnings.push({
				id: 'transition-clash',
				text: `${conflictedSeamIds.value.size === 1 ? 'A clip on another track crosses' : 'Clips on other tracks cross'} a transition — the export will refuse until it is moved clear.`
			})
		}

		// Not a mistake to fix — a cost to know about. Every other export stitches
		// with a stream copy; painting captions onto the picture cannot.
		if (doc.value.captionsEnabled && captionCues.value.length) {
			warnings.push({
				id: 'captions',
				text: 'Captions are burned in, so the whole video is re-encoded. This export will take longer.'
			})
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
				currentRevisionId: doc.value.currentRevisionId,
				motionKits: doc.value.motionKits ?? [],
				// `?? false` because JSON.stringify drops an undefined, and the main
				// handler would then read the patch as "no opinion" and keep the old
				// value — the same trap the cleared-transition bug fell into.
				captionsEnabled: doc.value.captionsEnabled ?? false,
				loudnessEnabled: doc.value.loudnessEnabled ?? false
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
			clearAgentMarks()

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
			const storageProblems: string[] = []
			currentSnapshot.value = null
			try {
				const index = await api.getEditorRevisions(id)
				revisions.value = index?.revisions || []
				if (index?.problem) storageProblems.push(index.problem)
			} catch (error) {
				console.error('[editorStore] Failed to load revisions:', error)
				revisions.value = []
				storageProblems.push('Saved versions could not be loaded.')
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
				if (hist?.problem) storageProblems.push(hist.problem)
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
				storageProblems.push('Undo history could not be loaded.')
			}

			// The project is open either way; say what was lost, without blocking.
			if (storageProblems.length) {
				void dialog.notify({
					title: 'Some history could not be opened',
					message: 'Your current timeline is fine.',
					detail: storageProblems.join(' '),
					tone: 'warning'
				})
			}
			void ensureCurrentSnapshot()

			// Detect assets interrupted by an app quit mid-preprocess: persisted as
			// 'running' but with no live task process. Any incoming task update for
			// the asset clears the flag.
			interruptedAssets.value = new Set(
				(doc.value?.media || [])
					.filter((a) => a.preprocessState === 'running')
					.map((a) => a.id)
			)

			// Fire-and-forget: the ffmpeg/yt-dlp binary checks spawn processes
			// and can take seconds — never block first paint on them.
			api.checkSystemRequirements()
				.then((reqs: any) => {
					deps.value = {
						ffmpeg: reqs?.ffmpegAvailable !== false,
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

	/**
	 * The first import decides the sequence's shape, the way an NLE does — so a
	 * project shot on a phone does not start life landscape. Fires at most once
	 * per project: it marks the frame chosen, and the picker owns it after that.
	 *
	 * Called on every upsert rather than only on insert, because dimensions
	 * arrive with the main process's probe, which often lands after the asset.
	 */
	const seedSequenceFrame = (asset: MediaAsset) => {
		const meta = doc.value?.timelineMeta
		if (!meta || meta.frameChosen || asset.kind === 'audio') return
		const width = asset.metadata?.width
		const height = asset.metadata?.height
		if (!width || !height) return
		doc.value!.timelineMeta = { ...meta, width, height, frameChosen: true }
		markDirty()
	}

	const upsertAsset = (incoming: MediaAsset) => {
		if (!doc.value) return
		const index = doc.value.media.findIndex((a) => a.id === incoming.id)
		if (index === -1) {
			doc.value.media.push(incoming)
		} else {
			doc.value.media[index] = mergeMainOwnedAsset(doc.value.media[index], incoming)
		}
		seedSequenceFrame(doc.value.media[index === -1 ? doc.value.media.length - 1 : index])
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
		const confirmed = await dialog.confirm({
			title: 'Remove media',
			message: clipCount
				? `Remove this media and the ${clipCount} clip${clipCount === 1 ? '' : 's'} it has on the timeline?`
				: 'Remove this media from the project?',
			detail: clipCount
				? 'The imported copy and generated thumbnails will be deleted, and those clips will leave gaps you can close with Close gaps. This cannot be undone. The original file on disk is not affected.'
				: 'The imported copy and generated thumbnails will be deleted. This cannot be undone. The original file on disk is not affected.',
			confirmLabel: 'Remove',
			danger: true
		})
		if (!confirmed) return
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
		const confirmed = await dialog.confirm({
			title: 'Re-transcribe this media?',
			message: 'Check the audio again and rebuild the speech pieces?',
			detail: 'A stronger model re-reads the audio alongside the current transcript to fix the repeated section. This runs Gemini (costs tokens) and replaces the pieces derived from the old transcript. Clips already on the timeline keep playing the same footage.',
			confirmLabel: 'Re-transcribe'
		})
		if (!confirmed) return
		await api.preprocessMedia({ threadId: threadId.value, assetId, steps: ['retranscribe'] })
	}

	/** Remove derived Gemini data (transcript / scene descriptions) from an asset. */
	const clearAssetData = async (assetId: string, kind: 'transcript' | 'descriptions') => {
		if (!threadId.value) return
		const label = kind === 'transcript' ? 'transcript' : 'scene descriptions'
		const confirmed = await dialog.confirm({
			title: `Remove ${label}?`,
			message: `Delete the ${label} for this media?`,
			detail: `The ${label} data is removed from every piece. Regenerating it later runs Gemini again and costs tokens.`,
			confirmLabel: 'Remove',
			danger: true
		})
		if (!confirmed) return
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

	/** Re-run scene detection at a custom sensitivity (higher = more pieces). */
	const redetectScenes = async (assetId: string, sensitivity: number) => {
		if (!threadId.value) return
		await api.preprocessMedia({
			threadId: threadId.value,
			assetId,
			steps: ['scenes', 'thumbnails'],
			sensitivity
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
		timeline: doc.value!.timeline,
		motionKits: doc.value!.motionKits ?? []
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

		// A sound that follows a moment goes with it, in the SAME step as whatever
		// moved the moment — so one undo puts both back. (A prebuilt diff — an
		// agent's — brings its own bindings along.)
		if (!options.prebuilt) applySoundBindings(currentState())

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

		// Truncate any redo branch beyond the pointer, then append. This part must
		// be synchronous — undo/redo has to feel instant — and main performs the
		// same truncation, so the two agree without coordination.
		//
		// The ring cap is NOT mirrored here. Main owns it and reports what it
		// evicted (see the push result below); duplicating the limit meant two
		// literals across an IPC boundary that silently had to match.
		const idx = pointerIndex.value
		historySteps.value = [...historySteps.value.slice(0, idx + 1), step]

		doc.value.historyRef = { currentStepId: step.id, stepCount: historySteps.value.length }
		refreshMetaDuration()
		pruneSelection()
		markDirty()

		// Persist to the sidecar fire-and-forget; keyframe every 10th push
		pushCounter++
		const keyframe: TimelineSnapshot | undefined = pushCounter % 10 === 0
			? { stepId: step.id, ...snapshotState(), timelineMeta: { ...doc.value.timelineMeta } } as TimelineSnapshot
			: undefined
		api.pushEditorStep({
			threadId: threadId.value,
			step: JSON.parse(JSON.stringify(step)),
			keyframe: keyframe ? JSON.parse(JSON.stringify(keyframe)) : undefined
		}).then((res: { seq: number; prunedIds?: string[] } | null) => {
			if (!res) return
			// Apply the cap and the assigned seq in ONE reactive write. The previous
			// version assigned `step.seq` on the raw object, which fires no effect —
			// and seq is persisted, so in-session and post-reload state disagreed.
			const pruned = new Set(res.prunedIds || [])
			historySteps.value = historySteps.value
				.filter((s) => !pruned.has(s.id))
				.map((s) => (s.id === step.id ? { ...s, seq: res.seq ?? s.seq } : s))
			if (doc.value) doc.value.historyRef.stepCount = historySteps.value.length
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
			timeline: [...doc.value.timeline],
			motionKits: [...(doc.value.motionKits ?? [])]
		}
		const result = applyTimelineDiff(state, diff, doc.value.media)
		if (result.errors.length) {
			console.warn('[editorStore] applyTimelineDiff reported:', result.errors)
		}
		doc.value.tracks = state.tracks
		doc.value.timeline = state.timeline
		doc.value.motionKits = state.motionKits
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

	/**
	 * Where a clip lands when nobody says which lane: the BASE of its family —
	 * the bottom-most video lane, the first audio one. Deliberately not the top
	 * of `sortedTracks`, which is now the front-most layer; dropping footage into
	 * the layer in front of everything is not what "add this to the timeline"
	 * means.
	 */
	const baseOfFamily = (family: 'video' | 'audio') =>
		(doc.value?.tracks || [])
			.filter((t) => trackFamily(t) === family && !t.locked && !t.hidden)
			.sort((a, b) => a.order - b.order)[0]?.id || null

	const firstVideoTrackId = computed(() => baseOfFamily('video'))

	const firstAudioTrackId = computed(() => baseOfFamily('audio'))

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
		if (!track) return null
		if (!canHostItem(track, { sourceAssetId: clip.sourceAssetId }, doc.value.media).ok) return null

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
	 * the target track by family (something you hear → an audio lane, anything
	 * you see → a video lane), which is the same rule a drag across lanes obeys.
	 */
	const addItemFromAsset = (assetId: string, trackId?: string | null, atSec?: number): TimelineItem | null => {
		if (!doc.value) return null
		const asset = doc.value.media.find((a) => a.id === assetId)
		if (!asset) return null
		const targetTrackId = trackId || (asset.kind === 'audio' ? firstAudioTrackId.value : firstVideoTrackId.value)
		if (!targetTrackId) return null
		const track = doc.value.tracks.find((t) => t.id === targetTrackId)
		if (!track) return null
		if (!canHostItem(track, { sourceAssetId: assetId }, doc.value.media).ok) return null
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

	/**
	 * Remove spans of timeline rather than whole clips — what "cut the bit where
	 * he says that" needs.
	 *
	 * The granularity comes from wherever the span does: a caption cue, a
	 * transcript search, or the AI naming a time. Afterwards it closes the gaps
	 * exactly as a normal delete does, so the result is indistinguishable from
	 * having trimmed by hand.
	 */
	const removeRanges = (ranges: { start: number; end: number }[], label = 'Remove range') => {
		if (!doc.value) return 0
		const plan = planRangeRemoval(doc.value.timeline, ranges, () => newId('ti'))
		if (!plan.removeIds.length && !plan.updated.length && !plan.added.length) return 0

		const before = snapshotState()
		const dead = new Set(plan.removeIds)
		const reshaped = new Map(plan.updated.map((i) => [i.id, i]))
		doc.value.timeline = [
			...doc.value.timeline.filter((i) => !dead.has(i.id)).map((i) => reshaped.get(i.id) ?? i),
			...plan.added
		]
		closeTimelineGaps({ tracks: doc.value.tracks, timeline: doc.value.timeline })
		commitStep({ before, label })
		return plan.removedSec
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
			// The deep clone above copied `transition.out` onto BOTH halves. It
			// belongs to the cut at the original clip's END, which only the right
			// half still has — the left half's would sit on the split itself, a cut
			// the user just created and never asked to soften.
			if (item.transition?.out) {
				const rest = { ...item.transition }
				delete rest.out
				item.transition = Object.keys(rest).length ? rest : undefined
			}
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

	// ===== Effect packs =====

	/**
	 * Bumped once packs are registered. `allEffects()` reads a module-level
	 * registry, which Vue cannot see into — this is what tells the library to
	 * re-render once the extra looks are in it.
	 */
	const effectsVersion = ref(0)

	/**
	 * Register the packs main found.
	 *
	 * The renderer parses the manifests ITSELF, with the same `parsePack`, rather
	 * than receiving finished definitions: an EffectDef carries a `build`
	 * function and cannot cross IPC. One parser, one set of rules, two processes.
	 */
	const loadEffectPacks = async () => {
		try {
			const packs = await api.getEffectPacks() as { manifest: unknown; files: Record<string, string> }[]
			let added = 0
			for (const pack of packs || []) {
				const parsed = parsePack(pack.manifest, (name) => pack.files[name] ?? null)
				if (parsed.effects.length) {
					registerEffects(parsed.effects)
					added += parsed.effects.length
				}
			}
			if (added) effectsVersion.value++
		} catch (error) {
			console.error('[editorStore] effect packs failed to load:', error)
		}
	}

	// ===== Effects =====

	/** The id idiom used throughout this store, in one place. */
	const newId = (prefix: string) =>
		(crypto as any).randomUUID ? crypto.randomUUID() : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`

	/** The kind currently being dragged, so clips can light up as a target. */
	const draggingEffectKind = ref<string | null>(null)

	/**
	 * Append an effect to a clip, at its identity settings — adding one and
	 * applying it stay separate gestures, so you can see what your own
	 * adjustment did.
	 */
	const addEffect = (itemId: string, kind: string) => {
		const item = doc.value?.timeline.find((i) => i.id === itemId)
		const def = effectDef(kind)
		if (!item || !def) return
		const before = snapshotState()
		// Replace, never mutate — the diff compares by value and a mutated array
		// makes the before/after snapshots alias, recording no edit at all.
		item.effects = [
			...(item.effects ?? []),
			{ id: newId('fx'), kind, params: defaultParams(def) }
		]
		commitStep({ before, label: `Add ${def.label}` })
	}

	const removeEffect = (itemId: string, effectId: string) => {
		const item = doc.value?.timeline.find((i) => i.id === itemId)
		if (!item?.effects?.length) return
		const before = snapshotState()
		const next = item.effects.filter((e) => e.id !== effectId)
		item.effects = next.length ? next : undefined
		commitStep({ before, label: 'Remove effect' })
	}

	const setEffectParam = (itemId: string, effectId: string, key: string, value: number | string) => {
		const item = doc.value?.timeline.find((i) => i.id === itemId)
		const effect = item?.effects?.find((e) => e.id === effectId)
		if (!item || !effect) return
		const before = snapshotState()
		item.effects = item.effects!.map((e) =>
			e.id === effectId ? { ...e, params: { ...(e.params ?? {}), [key]: value } } : e
		)
		commitStep({ before, label: 'Adjust effect' })
	}

	/** Reorder within the chain. A filter chain is not commutative, so this is
	 *  a real edit rather than a cosmetic one. */
	const moveEffect = (itemId: string, effectId: string, delta: number) => {
		const item = doc.value?.timeline.find((i) => i.id === itemId)
		if (!item?.effects?.length) return
		const from = item.effects.findIndex((e) => e.id === effectId)
		const to = from + delta
		if (from < 0 || to < 0 || to >= item.effects.length) return
		const before = snapshotState()
		const next = [...item.effects]
		next.splice(to, 0, ...next.splice(from, 1))
		item.effects = next
		commitStep({ before, label: 'Reorder effects' })
	}

	const DEFAULT_GENERATED_SEC = 5

	/**
	 * Add a generated layer on its own track BELOW everything else.
	 *
	 * Not on the bottom existing track: the footage is already there, the two
	 * would overlap, and `repairOverlaps` would quietly throw the background
	 * away — which is exactly what happened the first time this was tried. The
	 * compositor draws bottom-up, so a background wants to be genuinely
	 * underneath, and that means a track of its own.
	 */
	const addGeneratedLayer = (kind: GeneratorSpec['kind'] = 'gradient') => {
		if (!doc.value) return null
		const before = snapshotState()
		let track = doc.value.tracks.find((t) => t.kind === 'video' && t.name === 'BG')
		if (!track) {
			track = {
				id: newId('tr'), kind: 'video', name: 'BG',
				// Below every existing track. Order is only a sort key, so a
				// negative one is the honest way to say "underneath".
				order: Math.min(0, ...doc.value.tracks.map((t) => t.order)) - 1,
				muted: false, locked: false, hidden: false, height: 48
			}
			doc.value.tracks.push(track)
		}
		const id = newId('ti')
		const duration = DEFAULT_GENERATED_SEC
		const start = Math.max(0, playheadSec.value)
		// Its own track, so the only thing it can collide with is another
		// background — push past one rather than let the repair discard this.
		const busyUntil = doc.value.timeline
			.filter((i) => i.trackId === track!.id && itemEnd(i) > start)
			.reduce((max, i) => Math.max(max, itemEnd(i)), start)
		doc.value.timeline.push({
			id, trackId: track.id, sourceAssetId: '',
			timelineStart: busyUntil,
			in: 0, out: duration, speed: 1, preservePitch: true, duration,
			label: GENERATORS.find((g) => g.kind === kind)?.label || 'Background',
			layerRole: 'background',
			generator: { kind, ...GENERATOR_DEFAULTS }
		})
		commitStep({ before, label: 'Add background' })
		selectItems([id])
		return id
	}

	const setGenerator = (id: string, patch: Partial<GeneratorSpec>) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item?.generator) return
		const before = snapshotState()
		item.generator = { ...item.generator, ...patch }
		commitStep({ before, label: 'Edit background' })
	}

	// ===== Motion layers =====

	/**
	 * Place a motion layer — a template from the library, or a blank custom page
	 * when `templateId` is null — at `atSec` (the playhead by default).
	 *
	 * It goes on a motion track (`M1`, made on top of the video family when
	 * there is none). A clash is never solved by sliding the layer later: it
	 * lands on the next motion track free at that moment, made if needed — the
	 * same rule the AI's addMotion follows, from the same shared function.
	 */
	const addMotionLayer = (templateId: string | null, atSec?: number) => {
		if (!doc.value) return null
		const before = snapshotState()
		// `project:<item id>` is another placement of a custom layer already in
		// this project: its page, settings and timing are copied as they are.
		const source = templateId?.startsWith('project:')
			? doc.value.timeline.find((i) => i.id === templateId.slice('project:'.length) && i.motion)
			: undefined
		const spec: MotionSpec = source
			? JSON.parse(JSON.stringify(source.motion))
			: newMotionSpec(templateId ?? undefined)
		const duration = source ? source.duration : resolveDefinition(spec).duration
		const start = Math.max(0, atSec ?? playheadSec.value)
		let track = freeMotionTrack(doc.value.tracks, doc.value.timeline, start, duration)
		if (!track) {
			track = {
				id: newId('tr'), kind: 'video', name: nextMotionTrackName(doc.value.tracks),
				order: nextTrackOrder(doc.value.tracks, 'video'),
				muted: false, locked: false, hidden: false, height: 64
			}
			doc.value.tracks.push(track)
		}
		const id = newId('ti')
		doc.value.timeline.push({
			id, trackId: track.id, sourceAssetId: '',
			timelineStart: start, in: 0, out: duration, speed: 1, preservePitch: true, duration,
			label: source?.label ?? motionTemplate(templateId ?? undefined)?.label ?? userMotionTemplate(templateId ?? undefined)?.label ?? 'Custom HTML',
			layerRole: 'overlay',
			motion: spec
		})
		commitStep({ before, label: 'Add motion' })
		selectItems([id])
		return id
	}

	/** Tidy a spec so an untouched map compares equal to an absent one. */
	const tidyMotion = (spec: MotionSpec): MotionSpec => {
		const out: MotionSpec = { ...spec }
		if (!out.settings || !Object.keys(out.settings).length) delete out.settings
		if (!out.moments || !Object.keys(out.moments).length) delete out.moments
		return out
	}

	/** Set one setting's static value. Replace, never mutate. */
	const setMotionSetting = (id: string, key: string, value: MotionSettingValue) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item?.motion) return
		const before = snapshotState()
		item.motion = tidyMotion({ ...item.motion, settings: { ...item.motion.settings, [key]: value } })
		commitStep({ before, label: 'Edit motion' })
	}

	/**
	 * Retime a motion layer's windows. `moments` holds the FIXED windows (in,
	 * out); `length`, when given, is the clip's new length — which is how the
	 * hold is set, since the hold is whatever the length leaves.
	 */
	const setMotionTiming = (id: string, moments: Record<string, number>, length?: number) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item?.motion) return
		const before = snapshotState()
		item.motion = tidyMotion({ ...item.motion, moments: { ...item.motion.moments, ...moments } })
		if (length !== undefined && Number.isFinite(length) && length > 0) setMotionLength(item, length)
		commitStep({ before, label: 'Retime motion' })
	}

	/**
	 * Give a motion layer a new length. Lengthening stops at the next layer on
	 * the lane rather than pushing it later: where a motion layer sits is the
	 * point of it. The caller commits the step.
	 */
	const setMotionLength = (item: TimelineItem, length: number) => {
		const room = doc.value!.timeline
			.filter((i) => i.id !== item.id && i.trackId === item.trackId && i.timelineStart >= item.timelineStart + 1e-6)
			.reduce((min, i) => Math.min(min, i.timelineStart - item.timelineStart), Infinity)
		const next = Math.max(0.2, Math.min(length, room))
		item.in = 0
		item.out = next
		item.duration = next
	}

	/**
	 * A custom page's own report of its definition, for pages whose `define`
	 * call is not a literal the reader can evaluate. It describes the page that
	 * is DRAWN (the passing version), so that is what it updates; the working
	 * text only follows when it is the same page.
	 */
	const setMotionDefinition = (id: string, definition: MotionDefinition) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item?.motion || item.motion.template) return
		const motion = item.motion
		const drawn = renderVersion(motion)
		const next: MotionSpec = {
			...motion,
			passed: motion.passed ? { ...motion.passed, definition } : motion.passed,
			definition: motion.passed && motion.passed.html !== motion.html ? motion.definition : definition
		}
		if (sameMotion(next, motion) || drawn.source === 'nothing') return
		const before = snapshotState()
		item.motion = next
		commitStep({ before, label: 'Update motion page' })
	}

	// ===== Custom HTML pages (stage 5) =====

	/** The probe's latest word on a page, by its text — the HTML tab's runtime checks. */
	const motionRuntime = ref<Record<string, RuntimeReport>>({})

	/** Saved templates (main owns the files; this is the Motion tab's copy). */
	const motionUserTemplates = ref<MotionUserTemplate[]>([])

	const adoptUserTemplates = (list: MotionUserTemplate[]) => {
		motionUserTemplates.value = list
		setUserMotionTemplates(list)
	}

	const loadMotionTemplates = async () => {
		try {
			adoptUserTemplates((await api.listMotionTemplates()) || [])
		} catch (error) {
			console.error('[editorStore] Failed to load motion templates:', error)
		}
	}

	/**
	 * Draw `html` twice in the hidden window and compare. Never rejects: a probe
	 * that cannot run is `skipped`, which blocks nothing.
	 */
	const probeMotionHtml = async (html: string, definition: MotionDefinition, kitId?: string): Promise<RuntimeReport> => {
		const meta = doc.value?.timelineMeta
		const kit = kitId ? doc.value?.motionKits?.find((k) => k.id === kitId) : undefined
		try {
			const result = await api.probeMotionPage({
				html, definition: JSON.parse(JSON.stringify(definition)),
				kit: kit ? JSON.parse(JSON.stringify(kit)) : undefined,
				frame: { width: meta?.width || 1920, height: meta?.height || 1080 }
			})
			const report: RuntimeReport = {
				determinism: result?.determinism ?? 'skipped', differsAt: result?.differsAt, error: result?.error,
				definition: result?.definition
			}
			motionRuntime.value = { ...motionRuntime.value, [htmlHash(html)]: report }
			return report
		} catch (error) {
			console.error('[editorStore] Motion probe failed to run:', error)
			return { determinism: 'skipped' }
		}
	}

	/**
	 * A person's edit to a custom page, as ONE undoable step. The caller has
	 * already run the checks; `passed` says whether the text cleared them, which
	 * decides whether it becomes the drawn version or waits as the working copy.
	 */
	const commitMotionHtml = (
		id: string,
		text: string,
		outcome: { passed: boolean; definition?: MotionDefinition }
	): boolean => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item?.motion || item.motion.template) return false
		const next = editedSpec(item.motion, text, outcome)
		if (sameMotion(next, item.motion)) return false
		const before = snapshotState()
		// A layer at its page's own length follows the page: a fresh custom layer is
		// the blank page's 3 s, and the scene written into it is longer.
		const length = lengthAfterPageChange(item.motion, next, item.duration)
		item.motion = next
		if (Math.abs(length - item.duration) > 1e-6) setMotionLength(item, length)
		return commitStep({ before, label: outcome.passed ? 'Edit motion HTML' : 'Edit motion HTML (checks failing)' })
	}

	/**
	 * Pages an AI or an agent wrote land drawn but unprobed (the ops path has no
	 * window). Probe each distinct one once, quietly: a pass marks it verified;
	 * a failure draws nothing, so a page that fails is never rendered.
	 */
	const probing = new Set<string>()
	const verifyMotionPages = async () => {
		const d = doc.value
		if (!d) return
		for (const item of d.timeline) {
			const page = unverifiedPage(item.motion)
			if (!page) continue
			const kitId = item.motion?.kit
			// The same text under a different kit is a different page.
			const key = `${htmlHash(page.html)}:${kitId ?? ''}`
			if (probing.has(key)) continue
			probing.add(key)
			try {
				const report = await probeMotionHtml(page.html, resolveDefinition(item.motion), kitId)
				const ok = report.determinism !== 'fail' && !report.error
				let changed = false
				for (const other of doc.value?.timeline ?? []) {
					if (!other.motion || unverifiedPage(other.motion)?.html !== page.html || other.motion.kit !== kitId) continue
					other.motion = ok ? verifiedSpec(other.motion, page.html) : failedSpec(other.motion, page.html)
					changed = true
				}
				// Quiet on purpose: the checks are a fact about the page, not an edit.
				if (changed) markDirty()
			} finally {
				probing.delete(key)
			}
		}
	}
	watch(
		() => doc.value?.timeline.map((i) => unverifiedPage(i.motion)?.html ?? '').join('\u0000'),
		(signature) => { if (signature && signature.replace(/\u0000/g, '')) void verifyMotionPages() }
	)

	/** Save a passing custom layer to the library, for every project. */
	const saveMotionAsTemplate = async (
		id: string,
		label: string
	): Promise<{ ok: true; template: MotionUserTemplate } | { ok: false; error: string }> => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item?.motion || item.motion.template) return { ok: false, error: 'Only a custom layer can be saved as a template.' }
		const drawn = renderVersion(item.motion)
		try {
			const result = await api.saveMotionTemplate({
				label, html: drawn.html, definition: JSON.parse(JSON.stringify(drawn.definition)),
				author: item.motion.author?.by ?? 'you'
			})
			if (result?.ok) {
				adoptUserTemplates(result.templates)
				return { ok: true, template: result.template }
			}
			return { ok: false, error: result?.error || 'Could not save the template.' }
		} catch (error: any) {
			return { ok: false, error: error?.message || 'Could not save the template.' }
		}
	}

	const deleteMotionTemplate = async (templateId: string) => {
		try {
			adoptUserTemplates((await api.deleteMotionTemplate(templateId)) || [])
		} catch (error) {
			console.error('[editorStore] Failed to delete motion template:', error)
		}
	}

	/** "Ask AI to fix": the error, the line and the page, scoped to this layer. */
	const askAiToFixMotion = (id: string, issue: CheckIssue | undefined, html: string) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item?.motion || promptRunning.value) return
		if (!selectedItemIds.value.includes(id)) selectItems([id])
		void runPrompt(fixPrompt({ layer: item.label || 'Custom HTML', itemId: id, issue, html }))
	}

	/** "Describe it": a blank custom layer, then the AI writes its page. */
	const describeMotionLayer = (description: string, atSec?: number) => {
		const text = description.trim()
		const id = addMotionLayer(null, atSec)
		if (!id || !text) return id
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (item) {
			// Named for what it is, so the library tile and the timeline say so.
			const before = snapshotState()
			item.label = text.length > 28 ? `${text.slice(0, 27).trimEnd()}…` : text
			commitStep({ before, label: 'Name motion layer' })
		}
		void runPrompt(describePrompt({ layer: item?.label || 'Custom HTML', itemId: id, description: text }))
		return id
	}

	/**
	 * Key a clip's background out, so it sits IN FRONT of the layer below
	 * rather than beside it. `undefined` puts the background back.
	 */
	const setItemKey = (id: string, key: KeySpec | undefined) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item) return
		const before = snapshotState()
		// Replace, never mutate — the diff compares by value.
		item.key = key && hasKey(key) ? { ...key } : undefined
		commitStep({ before, label: key ? 'Key background' : 'Remove key' })
	}

	/** What this clip is FOR in a stack. Descriptive, and read by the AI. */
	const setLayerRole = (id: string, role: TimelineItem['layerRole']) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item) return
		const before = snapshotState()
		item.layerRole = role
		commitStep({ before, label: 'Set layer role' })
	}

	/**
	 * A continuous gesture — dragging a handle on the canvas — as ONE history
	 * step. The snapshot is taken when the pointer goes down, the item is
	 * updated live while it moves (replacing objects, never mutating, so the
	 * value-comparing diff still works), and the step commits on release.
	 * Without this a drag would bury the undo stack under a step per pixel —
	 * the same reason the sliders commit on `change` rather than `input`.
	 */
	let gestureBefore: TimelineState | null = null

	const beginItemGesture = () => {
		if (!doc.value || gestureBefore) return
		gestureBefore = snapshotState()
	}

	/**
	 * Live update mid-gesture: no history, no autosave — just the picture.
	 *
	 * Serves the canvas handles AND the inspector's sliders on `input`, so a
	 * value is seen the moment it moves rather than on release. Object fields
	 * are REPLACED, never mutated, keeping the value-comparing diff honest for
	 * the commit at the end.
	 */
	const updateItemGesture = (id: string, patch: {
		transform?: TimelineItemTransform
		text?: Partial<NonNullable<TimelineItem['text']>>
		framing?: TimelineItem['framing']
		generator?: Partial<NonNullable<TimelineItem['generator']>>
		motion?: MotionSpec
		keyframes?: TimelineItem['keyframes']
		/** Clip length, for a motion layer whose hold is being dragged. */
		length?: number
		key?: TimelineItem['key']
		effects?: TimelineItem['effects']
		gain?: number
		fadeInSec?: number
		fadeOutSec?: number
	}) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item) return
		if (patch.transform) {
			item.transform = hasTransform(patch.transform) ? { ...patch.transform } : undefined
		}
		if (patch.text && item.text) item.text = { ...item.text, ...patch.text }
		if ('framing' in patch) item.framing = patch.framing ? { ...patch.framing } : undefined
		if (patch.generator && item.generator) item.generator = { ...item.generator, ...patch.generator }
		if (patch.motion && item.motion) item.motion = { ...patch.motion }
		if ('keyframes' in patch) {
			item.keyframes = patch.keyframes && Object.keys(patch.keyframes).length
				? Object.fromEntries(Object.entries(patch.keyframes).map(([k, v]) => [k, v.map((key) => ({ ...key }))]))
				: undefined
		}
		if (patch.length !== undefined && item.motion && patch.length > 0) {
			item.in = 0
			item.out = patch.length
			item.duration = patch.length
		}
		if ('key' in patch) item.key = patch.key ? { ...patch.key } : undefined
		if (patch.effects) item.effects = patch.effects.map((e) => ({ ...e, params: { ...e.params } }))
		if (patch.gain !== undefined) item.gain = patch.gain
		if (patch.fadeInSec !== undefined) item.fadeInSec = patch.fadeInSec
		if (patch.fadeOutSec !== undefined) item.fadeOutSec = patch.fadeOutSec
	}

	const endItemGesture = (label: string) => {
		if (!gestureBefore) return
		commitStep({ before: gestureBefore, label })
		gestureBefore = null
	}

	/**
	 * Move, scale or rotate a clip inside the frame — the free transform, and
	 * what PiP is built on. Replace, never mutate: the diff compares by value.
	 */
	const setItemTransform = (id: string, patch: Partial<TimelineItemTransform>) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item) return
		const before = snapshotState()
		const next = { ...TRANSFORM_DEFAULTS, ...item.transform, ...patch }
		item.transform = hasTransform(next) ? next : undefined
		commitStep({ before, label: 'Transform clip' })
	}

	/**
	 * Add or replace a keyframe on `path` at clip-local time `t`.
	 *
	 * Times are clip-local so a keyframe survives the clip being moved, and
	 * SNAPPED to a hundredth of a second so clicking the same spot twice edits
	 * one keyframe rather than stacking two a microsecond apart.
	 */
	const setKeyframe = (id: string, path: string, t: number, value: number) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item || !isAnimatableOn(path, motionAnimatablePaths(item)) || !Number.isFinite(value)) return
		const at = Math.max(0, Math.round(t * 100) / 100)
		const before = snapshotState()
		const existing = item.keyframes?.[path] ?? []
		const next = [...existing.filter((k) => Math.abs(k.t - at) > 0.005), { t: at, value }]
			.sort((a, b) => a.t - b.t)
		item.keyframes = { ...item.keyframes, [path]: next }
		commitStep({ before, label: 'Add keyframe' })
	}

	const removeKeyframe = (id: string, path: string, t: number) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item?.keyframes?.[path]) return
		const before = snapshotState()
		const next = item.keyframes[path].filter((k) => Math.abs(k.t - t) > 0.005)
		const tracks = { ...item.keyframes }
		if (next.length) tracks[path] = next
		else delete tracks[path]
		item.keyframes = Object.keys(tracks).length ? tracks : undefined
		commitStep({ before, label: 'Remove keyframe' })
	}

	/** Stop animating a parameter, leaving its static value in charge. */
	const clearKeyframes = (id: string, path: string) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item?.keyframes?.[path]) return
		const before = snapshotState()
		const tracks = { ...item.keyframes }
		delete tracks[path]
		item.keyframes = Object.keys(tracks).length ? tracks : undefined
		commitStep({ before, label: 'Clear keyframes' })
	}

	/**
	 * How a clip fills a sequence frame of a different shape: letterbox it (`fit`,
	 * the default and today's behaviour) or crop it to the frame (`fill`), with a
	 * pan choosing which part survives. Part of the timeline, so it undoes.
	 */
	const setItemFraming = (id: string, mode: 'fit' | 'fill', pan = 0) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item || !Number.isFinite(pan)) return
		const before = snapshotState()
		const clamped = Math.max(-1, Math.min(1, pan))
		// Replace, never mutate — same contract as `transition`; the diff compares
		// this object by value and mutating it makes the snapshots alias.
		item.framing = mode === 'fit' ? undefined : { mode, pan: clamped }
		commitStep({ before, label: mode === 'fit' ? 'Fit to frame' : 'Fill frame' })
	}

	/**
	 * The sequence's own frame. Deliberately NOT undoable: `timelineMeta` sits
	 * outside TimelineState, which is what the history diffs, and a project's
	 * shape is a setting rather than an edit — the same call markers make.
	 */
	const setSequenceFrame = (width: number, height: number) => {
		if (!doc.value || !Number.isFinite(width) || !Number.isFinite(height)) return
		if (width < 2 || height < 2) return
		doc.value.timelineMeta = { ...doc.value.timelineMeta, width, height, frameChosen: true }
		markDirty()
	}

	/** Back to following the footage. Picking a frame was otherwise one-way. */
	const clearSequenceFrame = () => {
		if (!doc.value) return
		doc.value.timelineMeta = { ...doc.value.timelineMeta, frameChosen: false }
		markDirty()
	}

	/**
	 * Attach a transition to the cut AFTER this clip. The annotation lives on the
	 * outgoing item; no clip moves and the sequence length is unchanged — the
	 * window is resolved at render time from each side's trimmed-away handles.
	 */
	const setTransition = (id: string, kind: string, seconds: number) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item || !isTransitionKind(kind) || !Number.isFinite(seconds)) return
		const before = snapshotState()
		const duration = Math.max(MIN_TRANSITION_SEC, Math.min(MAX_TRANSITION_SEC, seconds))
		// REPLACE, never mutate: diffTimelines compares `transition` by value, and
		// mutating in place makes the before/after snapshots alias so the edit is
		// never recorded. See the contract in shared/timeline.ts.
		item.transition = { ...item.transition, out: { kind, duration } }
		commitStep({ before, label: `Transition ${transitionLabel(kind)}` })
	}

	const clearTransition = (id: string) => {
		const item = doc.value?.timeline.find((i) => i.id === id)
		if (!item?.transition?.out) return
		const before = snapshotState()
		const rest = { ...item.transition }
		delete rest.out
		item.transition = Object.keys(rest).length ? rest : undefined
		commitStep({ before, label: 'Remove transition' })
	}

	/**
	 * Copy a selection, so it can be pasted somewhere else.
	 *
	 * The clipboard is a deep snapshot rather than a list of ids: paste has to
	 * keep working after the originals are deleted, and a shallow copy would
	 * hand the pasted clip the SAME effects and transition objects as the one it
	 * came from — the diff compares those by value and two items sharing one
	 * would make every later edit ambiguous.
	 */
	const clipboard = ref<TimelineItem[]>([])

	const copyItems = (ids: string[] = selectedItemIds.value) => {
		const wanted = new Set(ids)
		const picked = (doc.value?.timeline ?? []).filter((i) => wanted.has(i.id))
		if (!picked.length) return 0
		clipboard.value = JSON.parse(JSON.stringify(picked))
		return picked.length
	}

	/**
	 * Paste at the playhead, keeping the selection's internal spacing.
	 *
	 * Relative to the EARLIEST item copied, so pasting a three-clip run puts it
	 * back as a run rather than stacking all three on the playhead.
	 */
	const pasteItems = (atSec = playheadSec.value) => {
		if (!doc.value || !clipboard.value.length) return []
		const trackIds = new Set(doc.value.tracks.map((t) => t.id))
		const origin = Math.min(...clipboard.value.map((i) => i.timelineStart))
		const fallbackTrack = visibleVideoTracks.value[0]?.id
			?? doc.value.tracks.find((t) => t.kind === 'video')?.id
		const before = snapshotState()
		const made: string[] = []
		for (const source of clipboard.value) {
			// A track the copy came from may be gone by now.
			const trackId = trackIds.has(source.trackId) ? source.trackId : fallbackTrack
			if (!trackId) continue
			const id = newId('ti')
			doc.value.timeline.push({
				...JSON.parse(JSON.stringify(source)),
				id,
				trackId,
				timelineStart: Math.max(0, atSec + (source.timelineStart - origin))
			})
			made.push(id)
		}
		if (!made.length) return []
		// Pasting onto occupied time is normal; the existing repair decides.
		repairOverlaps({ tracks: doc.value.tracks, timeline: doc.value.timeline })
		commitStep({ before, label: made.length > 1 ? `Paste ${made.length} clips` : 'Paste' })
		selectItems(made)
		return made
	}

	/** Copy and paste in one step, landing each copy right after its original. */
	const duplicateItems = (ids: string[] = selectedItemIds.value) => {
		if (!doc.value) return []
		const wanted = new Set(ids)
		const picked = doc.value.timeline.filter((i) => wanted.has(i.id))
		if (!picked.length) return []
		const before = snapshotState()
		const made: string[] = []
		for (const source of picked) {
			const id = newId('ti')
			doc.value.timeline.push({
				...JSON.parse(JSON.stringify(source)),
				id,
				timelineStart: itemEnd(source)
			})
			made.push(id)
		}
		repairOverlaps({ tracks: doc.value.tracks, timeline: doc.value.timeline })
		commitStep({ before, label: made.length > 1 ? `Duplicate ${made.length} clips` : 'Duplicate' })
		selectItems(made)
		return made
	}

	/** Everything on unlocked tracks — locked means locked, including from here. */
	const selectAllItems = () => {
		if (!doc.value) return
		const locked = new Set(doc.value.tracks.filter((t) => t.locked).map((t) => t.id))
		selectItems(doc.value.timeline.filter((i) => !locked.has(i.trackId)).map((i) => i.id))
	}

	/**
	 * Trim everything on one side of the playhead away from a clip.
	 *
	 * `side: 'left'` keeps what is AFTER the playhead — the gesture for "the
	 * take starts here". Trims rather than splitting-and-deleting so it is one
	 * history step and leaves no fragment behind.
	 *
	 * Ripples afterwards, like every other removal here. Leaving the hole would
	 * be a different gesture from the delete key on the same timeline, and a
	 * user who tightens a clip is not asking for a gap where it used to be.
	 */
	const trimToPlayhead = (side: 'left' | 'right') => {
		if (!doc.value) return 0
		const t = playheadSec.value
		const candidates = (selectedItems.value.length ? selectedItems.value : doc.value.timeline)
			.filter((i) => t > i.timelineStart + 0.01 && t < itemEnd(i) - 0.01)
		if (!candidates.length) return 0
		const before = snapshotState()
		for (const item of candidates) {
			const speed = item.speed || 1
			const cut = item.in + (t - item.timelineStart) * speed
			if (side === 'left') {
				item.in = cut
				item.timelineStart = t
			} else {
				item.out = cut
			}
			item.duration = (item.out - item.in) / speed
			item.masterSegmentIndex = undefined
		}
		closeTimelineGaps({ tracks: doc.value.tracks, timeline: doc.value.timeline })
		commitStep({ before, label: side === 'left' ? 'Trim start' : 'Trim end' })
		return candidates.length
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

	/**
	 * A second video track, which is what makes picture-in-picture reachable:
	 * the render composites every visible video track bottom-up, and until now
	 * there was no way to make a second one.
	 */
	const addVideoTrack = () => {
		if (!doc.value) return
		const before = snapshotState()
		doc.value.tracks.push({
			id: newId('tr'),
			kind: 'video',
			name: nextTrackName(doc.value.tracks, 'video'),
			// Above its OWN family, not the end of a flat list — which is how a new
			// lane used to land underneath the audio and off the bottom of a
			// viewport this short.
			order: nextTrackOrder(doc.value.tracks, 'video'),
			muted: false, locked: false, hidden: false, height: 64
		})
		commitStep({ before, label: 'Add video track' })
	}

	/** The audio half of the same thing. There was no way to add one before. */
	const addAudioTrack = () => {
		if (!doc.value) return
		const before = snapshotState()
		doc.value.tracks.push({
			id: newId('tr'),
			kind: 'audio',
			name: nextTrackName(doc.value.tracks, 'audio'),
			order: nextTrackOrder(doc.value.tracks, 'audio'),
			muted: false, locked: false, hidden: false, height: 64
		})
		commitStep({ before, label: 'Add audio track' })
	}

	/**
	 * Delete a track and everything on it.
	 *
	 * The last video track is kept: a sequence with nowhere to put a picture is
	 * not a state worth being able to reach. Audio has no such floor — a project
	 * that only ever uses the sound its clips carry needs no audio lane at all.
	 */
	const removeTrack = (trackId: string) => {
		if (!doc.value) return false
		const track = doc.value.tracks.find((t) => t.id === trackId)
		if (!track) return false
		if (!canRemoveTrack(trackId)) return false
		const before = snapshotState()
		doc.value.tracks = doc.value.tracks.filter((t) => t.id !== trackId)
		doc.value.timeline = doc.value.timeline.filter((i) => i.trackId !== trackId)
		commitStep({ before, label: `Remove ${track.name}` })
		return true
	}

	/** Whether removing this track is offered at all. */
	const canRemoveTrack = (trackId: string) => {
		const d = doc.value
		const track = d?.tracks.find((t) => t.id === trackId)
		if (!d || !track) return false
		return trackFamily(track) !== 'video' ||
			d.tracks.filter((t) => trackFamily(t) === 'video').length > 1
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
		markers: doc.value!.markers || [],
		motionKits: doc.value!.motionKits ?? []
	})

	/** Push to the sidecar and mirror the assigned seq back (awaited — cards need real V numbers). */
	/**
	 * Main assigns the real `seq` and may prune the oldest leaf to stay under the
	 * cap. Both land in ONE reactive assignment: the previous version mutated the
	 * raw `rev` object rather than the array's proxy, so nothing re-rendered — it
	 * only appeared to work because createRevision writes currentRevisionId
	 * immediately afterwards and that forced a re-read.
	 */
	const pushRevisionInternal = async (rev: EditorRevision): Promise<EditorRevisionSummary> => {
		const summary = summarizeRevision(rev)
		revisions.value = [...revisions.value, summary]
		let stored = summary
		try {
			const res = await api.pushEditorRevision({ threadId: threadId.value, revision: deepClone(rev) })
			const pruned = new Set<string>(res?.prunedIds || [])
			stored = { ...summary, seq: res?.seq ?? rev.seq }
			revisions.value = revisions.value
				.filter((r) => !pruned.has(r.id))
				.map((r) => (r.id === rev.id ? stored : r))
		} catch (error) {
			console.error('[editorStore] pushEditorRevision failed:', error)
		}
		return stored
	}

	/** The new revision becomes current: its snapshot is already in hand. */
	const holdAsCurrent = (id: string, snapshot: RevisionSnapshot) => {
		if (threadId.value) currentSnapshot.value = { threadId: threadId.value, id, snapshot }
	}

	/** Lazy root bootstrap: the parent chain is never empty; zero migration. */
	const ensureRootRevision = async (): Promise<EditorRevisionSummary | null> => {
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
			holdAsCurrent(storedRoot.id, root.snapshot)
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
	}): Promise<EditorRevisionSummary | null> => {
		if (!doc.value || !threadId.value) return null
		await ensureRootRevision()
		await ensureCurrentSnapshot()
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
		holdAsCurrent(stored.id, rev.snapshot)
		markDirty()
		return stored
	}

	/**
	 * Switches the working state to a revision's snapshot.
	 * Resets the fine-grained undo ring (its diffs were computed against
	 * pre-switch states — redo onto the switched snapshot would corrupt it).
	 */
	const switchRevision = async (id: string, options: { force?: boolean; engineTurnId?: string } = {}): Promise<boolean> => {
		if (!doc.value || !threadId.value) return false
		if (id === doc.value.currentRevisionId) return true
		const target = revisions.value.find((r) => r.id === id)
		if (!target) return false
		// Blocked: a completing Gemini turn would land its diff on the wrong
		// parent. A CLI engine's turn carries no diff (its edits are revisions
		// already), so the engine running it may switch inside it.
		const engineTurn = !!options.engineTurnId && options.engineTurnId === activeTurnId.value &&
			!!doc.value.turns.find((t) => t.id === activeTurnId.value)?.engine
		if (promptRunning.value && !engineTurn) return false
		// The agent's own switches (over MCP) are forced; the user's wait for its round to end.
		if (agentHolds.value && !options.force) return false

		if (!options.force) await ensureCurrentSnapshot()
		if (!options.force && revisionDirty.value) {
			const choice = await dialog.choose<'cancel' | 'discard' | 'save'>({
				title: 'Unsaved changes',
				message: 'Your timeline has changes not saved to a revision.',
				detail: 'Save them as a revision before switching, or discard them?',
				tone: 'warning',
				actions: [
					{ label: 'Cancel', value: 'cancel' },
					{ label: 'Discard changes', value: 'discard', danger: true },
					{ label: 'Save & switch', value: 'save', primary: true }
				],
				dismissValue: 'cancel'
			})
			if (choice === 'cancel') return false
			if (choice === 'save') {
				await createRevision({ origin: 'manual', label: 'Manual save' })
			}
		}

		// Fetch and apply the snapshot
		const stored = await fetchRevisionSnapshot(id)
		if (!stored || !doc.value) {
			void dialog.notify({
				title: `V${target.seq} can't be restored`,
				message: 'This saved version is missing or damaged. Your timeline was not changed.',
				tone: 'error'
			})
			return false
		}
		const snap = deepClone(stored)
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
		doc.value.motionKits = snap.motionKits ?? []
		doc.value.currentRevisionId = id
		holdAsCurrent(id, stored)

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
		clearAgentMarks()
		markDirty()
		return true
	}

	const saveCheckpoint = async (label?: string): Promise<'saved' | 'clean' | null> => {
		if (!doc.value) return null
		await ensureRootRevision()
		await ensureCurrentSnapshot()
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

		const confirmed = await dialog.confirm({
			title: 'Delete revisions',
			message: `Delete V${target.seq}${ids.size > 1 ? ` and ${ids.size - 1} descendant revision(s)` : ''}?`,
			detail: 'The timeline states saved in them will be lost. The current timeline is not affected.',
			confirmLabel: 'Delete',
			danger: true
		})
		if (!confirmed) return false

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

	const runPrompt = async (prompt: string, override?: { widen?: 'chapter' | 'full'; retry?: EngineRetry }) => {
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
				selectedItemIds: JSON.parse(JSON.stringify(override?.retry?.selectedItemIds ?? selectedItemIds.value)),
				playheadSec: override?.retry?.playheadSec ?? playheadSec.value,
				widen: override?.retry ? override.retry.widen : override?.widen ?? (scopeWiden.value === 'auto' ? undefined : scopeWiden.value),
				engine: override?.retry?.engine
			})
			if (result?.turnId) activeTurnId.value = result.turnId
		} catch (error: any) {
			promptError.value = error?.message || 'Failed to start the prompt'
		}
	}

	/** What Retry would re-send for this turn, or null when it is not offered. */
	const retryFor = (turn: PromptTurn | null | undefined) => engineRetry(turn, doc.value?.turns || [])

	/** Run a failed engine turn again: same prompt, scope and engine. */
	const retryTurn = (turn: PromptTurn) => {
		const retry = retryFor(turn)
		if (retry) return runPrompt(retry.prompt, { retry })
	}

	const abortPrompt = async () => {
		if (!threadId.value || !activeTurnId.value) return
		await api.abortEditorPrompt({ threadId: threadId.value, turnId: activeTurnId.value })
	}

	/**
	 * Validates a proposal diff against the CURRENT doc by dry-running it on a
	 * copy; returns the applied copy + human-readable pruned-op notes.
	 */
	const dryRunProposal = (diff: TimelineDiff): { applied: TimelineState; pruned: string[]; shifted: string[] } => {
		const applied: TimelineState = {
			tracks: JSON.parse(JSON.stringify(doc.value!.tracks)),
			timeline: JSON.parse(JSON.stringify(doc.value!.timeline)),
			motionKits: JSON.parse(JSON.stringify(doc.value!.motionKits ?? []))
		}
		const result = applyTimelineDiff(applied, diff, doc.value!.media)
		// AI placements aren't gesture-clamped — push any same-track overlaps
		// right so the applied state always satisfies the M2 no-overlap invariant.
		const shifted = repairOverlapsReporting(applied)
		return { applied, pruned: result.errors, shifted }
	}

	const dismissAnswer = () => {
		lastAnswer.value = null
	}

	// ===== Export actions (M4 + background exports) =====

	/**
	 * Formats still to render for this project, after the one in flight.
	 *
	 * A queue rather than concurrency: an export saturates the machine, and two
	 * at once finishes later than two in sequence while making the progress bar
	 * meaningless. `renders` is keyed by thread, so there is one slot anyway.
	 */
	const exportQueue = ref<{ quality: 'original' | 'preview'; format: DeliveryFormat }[]>([])

	/**
	 * Render the timeline once per format, in order.
	 *
	 * The snapshot is taken PER JOB rather than once for the batch — each render
	 * detaches from the live doc, and a doc that changed between jobs should
	 * produce what it says at the moment each one starts.
	 */
	const startExportBatch = (quality: 'original' | 'preview', formats: DeliveryFormat[]) => {
		const wanted = formats.length ? formats : ['h264' as const]
		exportQueue.value = wanted.slice(1).map((format) => ({ quality, format }))
		void startExport(quality, wanted[0])
	}

	/** Start the next queued format, if a finished export left one waiting. */
	const drainExportQueue = () => {
		const next = exportQueue.value[0]
		if (!next) return
		exportQueue.value = exportQueue.value.slice(1)
		void startExport(next.quality, next.format)
	}

	const startExport = async (quality: 'original' | 'preview', format: DeliveryFormat = 'h264') => {
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
			const result = await api.exportEditorTimeline({ threadId: tid, quality, doc: snapshot, format })
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
		docSettings?: { captionsEnabled?: boolean; loudnessEnabled?: boolean; frame?: { width: number; height: number } }
		/** Rendered sounds the diff places: they must exist here before it is applied. */
		addAssets?: MediaAsset[]
		thinContext?: boolean
		truncated?: boolean
	}): Promise<AgentApplyOutcome | undefined> => {
		// An external agent's turn (MCP) answers the agent instead of the chat:
		// its failures go back as the tool's error, not into promptError.
		const isAgent = !!payload.turn.agent
		if (payload.threadId !== threadId.value || !doc.value) {
			return isAgent
				? { ok: false, error: 'The project the edit was built against is no longer open in the editor. Read it again.' }
				: undefined
		}
		const turn = payload.turn
		for (const asset of payload.addAssets ?? []) upsertAsset(asset)

		// Upsert into doc.turns (main-owned; echo also arrives via thread-updated)
		const index = doc.value.turns.findIndex((t) => t.id === turn.id)
		if (index === -1) doc.value.turns.push(turn)
		else doc.value.turns[index] = turn

		if (turn.id !== activeTurnId.value && turn.status === 'running') return

		if (turn.status === 'completed' && turn.engine && !isAgent) {
			// A CLI engine's turn: its edits already landed as their own agent
			// turns (apply_ops), each a revision. This closes the chat turn and
			// points the result card at the last of them.
			if (turn.id === activeTurnId.value) activeTurnId.value = null
			const engine = turn.engine
			const lastId = engine.finalRevisionId || engine.revisionIds?.[engine.revisionIds.length - 1]
			const rev = lastId ? revisions.value.find((r) => r.id === lastId) : undefined
			if (rev) {
				lastResult.value = {
					turnId: turn.id,
					revisionId: rev.id,
					revisionSeq: rev.seq,
					parentRevisionId: engine.parentRevisionId ?? rev.parentId ?? null,
					counts: engine.counts || { added: 0, removed: 0, updated: 0, markers: 0 },
					rationale: turn.rationale,
					droppedOps: [],
					thinContext: false,
					truncated: false
				}
			} else if (turn.answer) {
				lastAnswer.value = { turnId: turn.id, text: turn.answer }
			}
			return
		}

		if (turn.status === 'completed') {
			// An agent's turn must not end the user's own prompt still in flight.
			if (!isAgent || turn.id === activeTurnId.value) activeTurnId.value = null
			if (turn.answer && !hasOps(turn.diff)) {
				lastAnswer.value = { turnId: turn.id, text: turn.answer }
				return
			}
			const markers = payload.addMarkers || []
			const settings = payload.docSettings
			if (!hasOps(turn.diff) && !markers.length && !settings) {
				const dropped = turn.droppedOps?.length ? ` Dropped: ${turn.droppedOps.join('; ')}` : ''
				if (isAgent) return { ok: false, error: `Those operations change nothing on the timeline.${dropped}` }
				promptError.value = 'The AI proposed no changes. Try a more specific request.'
				return
			}

			// Validate against the live doc (prune stale ops + repair overlaps)
			const { applied, pruned, shifted } = dryRunProposal(turn.diff!)
			const before = currentState()
			const diffed = diffTimelines(before, applied)
			if (!diffed && !markers.length && !settings) {
				if (isAgent) {
					return { ok: false, error: `Nothing applicable against the live timeline.${pruned.length ? ` Rejected: ${pruned.join('; ')}` : ''}` }
				}
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
			// An agent's turn is labelled with the agent: "Claude Code", not a persona.
			const label = turn.agent?.name || persona?.name || 'AI edit'
			if (diffed) {
				doc.value.tracks = applied.tracks
				doc.value.timeline = applied.timeline
				doc.value.motionKits = applied.motionKits
				// Ring step preserved: Cmd+Z undoes the AI diff in place
				commitStep({ prebuilt: diffed, origin: 'ai', turnId: turn.id, label })
			}
			for (const m of markers) addMarker(m.time, m.label)
			// Project settings sit outside TimelineState, so they are applied
			// directly rather than through the diff — the same route markers take.
			if (settings?.captionsEnabled !== undefined) setCaptionsEnabled(settings.captionsEnabled)
			if (settings?.loudnessEnabled !== undefined) setLoudnessEnabled(settings.loudnessEnabled)
			if (settings?.frame) setSequenceFrame(settings.frame.width, settings.frame.height)

			const rev = await createRevision({
				origin: 'ai',
				turnId: turn.id,
				personaId: turn.personaId,
				label
			})
			if (!rev) return isAgent ? { ok: false, error: 'The edit applied but its revision could not be saved.' } : undefined
			const counts = {
				added: diffed?.forward.addItems?.length || 0,
				removed: diffed?.forward.removeItemIds?.length || 0,
				updated: diffed?.forward.updateItems?.length || 0,
				markers: markers.length
			}
			if (isAgent) {
				agentMarks.value = diffed ? agentChangeBadges(diffed.forward, before.timeline) : {}
				agentMarksSeq.value = rev.seq
			}
			if (rev && threadId.value) {
				api.updateEditorTurn({
					threadId: threadId.value,
					turnId: turn.id,
					patch: { resultStepId: doc.value.historyRef.currentStepId, revisionId: rev.id }
				}).catch(() => { /* non-critical */ })

				// A CLI engine's own edits wait for its turn to end: that turn's card
				// shows them all at once, with its steps.
				if (!turn.agent?.engineTurnId) lastResult.value = {
					turnId: turn.id,
					revisionId: rev.id,
					revisionSeq: rev.seq,
					parentRevisionId: rev.parentId,
					counts,
					rationale: turn.rationale,
					droppedOps: [...(turn.droppedOps || []), ...pruned],
					scopeLabel: turn.scopeLabel,
					thinContext: !!payload.thinContext,
					truncated: !!payload.truncated
				}
			}
			return {
				ok: true, revisionId: rev.id, revisionSeq: rev.seq, parentRevisionId: rev.parentId,
				counts, pruned, shifted: shifted.length ? shifted : undefined
			}
		} else if (turn.status === 'error') {
			activeTurnId.value = null
			// An engine turn's failure shows in its own chat card, with its own Retry.
			if (!turn.engine) promptError.value = turn.error || 'Prompt failed'
		}
	}

	const hasOps = (diff?: TimelineDiff): boolean =>
		!!diff && !!(
			diff.addItems?.length || diff.removeItemIds?.length ||
			diff.updateItems?.length || diff.addTracks?.length || diff.removeTrackIds?.length ||
			diff.setMotionKits?.length || diff.removeMotionKitIds?.length
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
			api.onEditorImportProgress((data: {
				threadId: string
				assetId: string
				url?: string
				percent: number
				phase?: 'updating-ytdlp' | 'retrying'
			}) => {
				if (data.threadId !== threadId.value) return
				// A plain progress event (no phase) clears any recovery phase
				urlImports.value = {
					...urlImports.value,
					[data.assetId]: { url: data.url || '', percent: data.percent, phase: data.phase }
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
				// `replyId` = an MCP agent is waiting on this turn (main/mcp/rendererBridge).
				const reply = (response: { ok: boolean; result?: unknown; error?: string }) => {
					if (data?.replyId) api.mcpRespond({ id: data.replyId, ...response })
				}
				onTurnUpdate(data)
					.then((outcome) => reply({ ok: true, result: outcome ?? { ok: false, error: 'The editor did not apply the edit.' } }))
					.catch((error: any) => {
						console.error('[editorStore] turn update failed:', error)
						reply({ ok: false, error: error?.message || 'The editor failed to apply the edit.' })
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
				// A batch moves on when the one in flight lands — including on an
				// error, so one bad format does not strand the rest.
				if (data.threadId === threadId.value && (data.phase === 'done' || data.phase === 'error')) {
					drainExportQueue()
				}
			})
		}
	}

	return {
		// state
		threadId,
		thread,
		doc,
		upsertAsset,
		generatedAssets,
		placeGeneratedAudio,
		auditionAsset,
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
		shortcutsOpen,
		monitorFullscreen,
		activeGuideId,
		seekRequest,
		selectedItemIds,
		// computeds
		assets,
		isEmpty,
		hasReadyMedia,
		canPrompt,
		mediaProcessing,
		selectedAsset,
		selectedClip,
		sortedTracks,
		itemsByTrack,
		contentEnd,
		hasLayers,
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
		removeRanges,
		copyItems,
		pasteItems,
		duplicateItems,
		selectAllItems,
		trimToPlayhead,
		clipboard,
		deleteItems,
		closeGaps,
		hasGaps,
		setItemSpeed,
		setItemTargetDuration,
		setItemPreservePitch,
		toggleItemMuted,
		setItemGain,
		setItemFade,
		setTransition,
		clearTransition,
		setItemTransform,
		beginItemGesture,
		updateItemGesture,
		endItemGesture,
		setItemKey,
		addGeneratedLayer,
		setGenerator,
		addMotionLayer,
		setMotionSetting,
		setMotionTiming,
		setMotionDefinition,
		motionRuntime,
		motionUserTemplates,
		loadMotionTemplates,
		probeMotionHtml,
		commitMotionHtml,
		saveMotionAsTemplate,
		deleteMotionTemplate,
		askAiToFixMotion,
		describeMotionLayer,
		activeMotion,
		motionBounds,
		draggingMotionTemplate,
		setLayerRole,
		setKeyframe,
		removeKeyframe,
		clearKeyframes,
		setItemFraming,
		effectsVersion,
		loadEffectPacks,
		draggingEffectKind,
		addEffect,
		removeEffect,
		setEffectParam,
		moveEffect,
		setSequenceFrame,
		clearSequenceFrame,
		sequenceFrame,
		captionCues,
		transcriptCues,
		transcriptWords,
		captionsEnabled,
		hasTranscript,
		setCaptionsEnabled,
		exportQueue,
		startExportBatch,
		agentHolds,
		toggleTrackMusic,
		setTrackRole,
		soundPreviews,
		previewSound,
		auditionSound,
		stopAudition,
		addSound,
		addSounds,
		soundRecipeOf,
		setSoundRecipe,
		rerollSound,
		bindSound,
		releaseSoundBinding,
		soundCues,
		audioAnalysis,
		ensureAudioAnalysis,
		addVideoTrack,
		addAudioTrack,
		removeTrack,
		canRemoveTrack,
		overlaySegments,
		baseVideoTrackId,
		videoLayerDepth,
		addTitle,
		setTitle,
		activeTitles,
		activeGenerators,
		loudnessEnabled,
		setLoudnessEnabled,
		refreshTranscripts,
		seams,
		conflictedSeamIds,
		selectedSeamId,
		selectedSeam,
		selectSeam,
		draggingTransitionKind,
		seamNear,
		transitionPreviews,
		playableItemIds,
		requestTransitionPreviews,
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
		// personas
		personas,
		activePersona,
		findPersona,
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
		retryFor,
		retryTurn,
		abortPrompt,
		dismissAnswer,
		// revisions
		revisions,
		currentRevision,
		revisionDirty,
		revisionChildren,
		revisionHasBranch,
		lastResult,
		agentMarks,
		agentMarksSeq,
		clearAgentMarks,
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
