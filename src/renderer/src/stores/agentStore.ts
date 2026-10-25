import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { AgentAccessState, AgentActivity, AgentSessionInfo } from '@shared/agentFeed'
import type { AgentFocus } from '@shared/engines'
import type { EditorRevisionSummary } from '@shared/types'
import { applyRoundEvent, type AgentLock, type AgentRound, type RoundEvent } from '@shared/agentRounds'
import { useEditorStore } from './editorStore'

/**
 * External agents (MCP), renderer side.
 *
 * Two jobs. It is the editor's half of the live-document bridge — main asks
 * over `mcp-request` and this answers from the editor store, because the store
 * (not main's copy on disk) is the truth. And it keeps what the Agent tab and
 * the header banner draw: who is connected and what they have done.
 *
 * Instantiated at startup (main.ts), so main gets an answer even when no
 * editor is open: "no project" in milliseconds rather than a timeout.
 */

/** Feed rows kept per app run; the oldest scroll off. */
const MAX_ACTIVITIES = 300

const api = (window as any).api

export const useAgentStore = defineStore('agent', () => {
	const access = ref<AgentAccessState | null>(null)
	const activities = ref<AgentActivity[]>([])
	/** Ticks once a second while someone is connected, for elapsed times. */
	const now = ref(Date.now())

	const sessions = computed<AgentSessionInfo[]>(() => access.value?.sessions || [])

	/** The client the banner names: whoever acted most recently. */
	const liveSession = computed<AgentSessionInfo | null>(() =>
		[...sessions.value].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] || null
	)

	/**
	 * The banner's subject: a live session that acted in the last two minutes.
	 * A connected client that has gone quiet is not "editing".
	 */
	const EDITING_WINDOW_MS = 2 * 60_000
	const editingSession = computed<AgentSessionInfo | null>(() => {
		const s = liveSession.value
		return s && now.value - s.lastActivityAt < EDITING_WINDOW_MS ? s : null
	})

	/** Every session seen this run, so a feed outlives its connection. */
	const known = ref<Record<string, AgentSessionInfo>>({})
	const isLive = (sessionId: string | undefined) => !!sessionId && sessions.value.some((s) => s.id === sessionId)

	/** What the Agent tab shows: the live session, else the last one that ended. */
	const shownSession = computed<AgentSessionInfo | null>(() =>
		liveSession.value ||
		Object.values(known.value).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] ||
		null
	)

	const feedFor = (sessionId: string | null | undefined): AgentActivity[] =>
		sessionId ? activities.value.filter((a) => a.sessionId === sessionId) : []

	/**
	 * The version before this session's first edit — what "Back to V{n}" in the
	 * Agent tab returns to, undoing everything the agent did this session.
	 */
	const baselineRevision = (sessionId: string | null | undefined): EditorRevisionSummary | null => {
		const editor = useEditorStore()
		if (!sessionId || !editor.doc) return null
		const turnIds = new Set(editor.doc.turns.filter((t) => t.agent?.sessionId === sessionId).map((t) => t.id))
		const made = editor.revisions
			.filter((r) => r.turnId && turnIds.has(r.turnId))
			.sort((a, b) => a.seq - b.seq)[0]
		return made ? editor.revisions.find((r) => r.id === made.parentId) || null : null
	}

	// ===== Where the agent is acting (board 3) =====
	// External agents and FrameFlow's own CLI engine alike.

	/** The latest focus, with when it happened and, for a look, whether it finished. */
	const focus = ref<{ focus: AgentFocus; at: number; done: boolean; activityId: string } | null>(null)
	/** How long a focus stays shown once the agent moves on or goes quiet. */
	const FOCUS_WINDOW_MS = 60_000
	const engineRunning = computed(() => {
		const editor = useEditorStore()
		const id = editor.activeTurnId
		return !!id && !!editor.doc?.turns.find((t) => t.id === id)?.engine
	})
	const agentActive = computed(() => !!editingSession.value || engineRunning.value || !!lock.value)

	const readKey = 'frameflow.followAgent'
	const followAgent = ref<boolean>((() => {
		try { return localStorage.getItem(readKey) !== '0' } catch { return true }
	})())
	const setFollowAgent = (on: boolean) => {
		followAgent.value = on
		try { localStorage.setItem(readKey, on ? '1' : '0') } catch { /* per-viewer nicety */ }
	}

	const fresh = () => !!focus.value && agentActive.value && now.value - focus.value.at < FOCUS_WINDOW_MS

	/** The media the agent is reading: an asset id or a file name, as the agent gave it. */
	const readingAsset = computed<string | null>(() =>
		fresh() && focus.value!.focus.kind === 'read' ? (focus.value!.focus as { asset: string }).asset : null
	)
	/** The timeline time of the agent's last finished render_frame. */
	const lookedAt = computed<number | null>(() =>
		fresh() && focus.value!.focus.kind === 'look' && focus.value!.done ? (focus.value!.focus as { timeSec: number }).timeSec : null
	)

	const isReading = (asset: { id: string; name: string }): boolean => {
		const ref = readingAsset.value
		if (!ref) return false
		const stem = (n: string) => n.toLowerCase().replace(/\.[^.]+$/, '')
		return ref === asset.id || ref.toLowerCase() === asset.name.toLowerCase() || stem(ref) === stem(asset.name)
	}

	const onFocus = (activity: AgentActivity) => {
		if (!activity.focus) return
		const done = activity.status !== 'running'
		focus.value = { focus: activity.focus, at: Date.now(), done, activityId: activity.id }
		now.value = Date.now()
		// Follow agent: the playhead goes where the agent looks or edits.
		if (followAgent.value && activity.focus.kind !== 'read' && (done || activity.focus.kind === 'edit')) {
			const editor = useEditorStore()
			if (editor.doc && !editor.isPlaying) editor.seekTo(activity.focus.timeSec)
		}
	}

	const refresh = async () => {
		access.value = await api.getAgentAccess()
	}

	const disconnect = async (sessionId: string) => {
		await api.disconnectAgentSession(sessionId)
	}

	// ===== Live-document bridge =====

	const editorIsOpen = () => window.location.hash.startsWith('#/editor/')

	// ===== Rounds: one agent per project =====

	/** Who holds the project right now (an MCP agent's open round), app-wide. */
	const lock = ref<AgentLock | null>(null)
	/** The open project's rounds: the MCP conversation the chat shows. */
	const rounds = ref<AgentRound[]>([])
	const roundsThreadId = ref<string | null>(null)

	/** An MCP agent is working on the project the editor shows: the user should not touch it, the chat is locked. */
	const mcpWorking = computed<AgentLock | null>(() => {
		const editor = useEditorStore()
		return lock.value && lock.value.threadId === editor.threadId ? lock.value : null
	})

	const loadRounds = async (threadId: string | null) => {
		roundsThreadId.value = threadId
		if (!threadId || !api?.getAgentRounds) {
			rounds.value = []
			return
		}
		const state = await api.getAgentRounds(threadId)
		if (roundsThreadId.value !== threadId) return
		rounds.value = state?.rounds ?? []
		lock.value = state?.lock ?? null
	}

	const onRoundEvent = (event: RoundEvent) => {
		if (event.type === 'lock') {
			lock.value = event.lock
			now.value = Date.now()
			return
		}
		const threadId = event.type === 'round' ? event.round.threadId : event.threadId
		if (threadId !== roundsThreadId.value) return
		rounds.value = applyRoundEvent(rounds.value, event)
	}

	/** Ticks when the user tries to edit while an agent works: the working strip pulses. */
	const nudges = ref(0)
	const nudgeWorking = () => { nudges.value++ }

	/** Stop the working agent: its round ends and it is disconnected. */
	const stopRound = async () => {
		await api.stopAgentRound?.()
	}

	/** Resolves once the editor shows this project, loaded. */
	const waitForProject = async (threadId: string, timeoutMs: number): Promise<boolean> => {
		const editor = useEditorStore()
		const until = Date.now() + timeoutMs
		while (Date.now() < until) {
			if (editorIsOpen() && editor.threadId === threadId && !!editor.doc && !editor.loading) return true
			await new Promise((r) => setTimeout(r, 100))
		}
		return false
	}

	const answer = async (kind: string, payload: any): Promise<unknown> => {
		const editor = useEditorStore()
		const open = editorIsOpen() && !!editor.doc && !!editor.threadId && !editor.loading
		switch (kind) {
			case 'get-project': {
				if (!open) return null
				const doc = editor.doc!
				return JSON.parse(JSON.stringify({
					threadId: editor.threadId,
					title: editor.thread?.title || 'Untitled Project',
					doc,
					revisions: editor.revisions.map(({ itemCount: _count, firstClips: _clips, ...rest }) => rest),
					currentRevisionId: doc.currentRevisionId || null,
					playheadSec: editor.playheadSec,
					chatBusy: editor.promptRunning
				}))
			}
			case 'open-project': {
				const threadId = String(payload?.threadId || '')
				if (!threadId) return { ok: false, error: 'No project id.' }
				if (editor.promptRunning) return { ok: false, error: 'FrameFlow’s own chat is running a prompt. Try again when it finishes.' }
				if (open && editor.threadId === threadId) return { ok: true }
				// Flush the project being left before the editor moves on.
				if (open) await editor.persistDoc?.()
				window.location.hash = `#/editor/${threadId}`
				return (await waitForProject(threadId, 45_000))
					? { ok: true }
					: { ok: false, error: 'The editor did not finish opening that project within 45 s.' }
			}
			case 'switch-revision': {
				if (!open) return { ok: false, error: 'No project is open in the editor.' }
				// FrameFlow's own engine may switch inside the turn it is running.
				if (editor.promptRunning && !(payload.engineTurnId && payload.engineTurnId === editor.activeTurnId)) {
					return { ok: false, error: 'FrameFlow’s own AI is in the middle of an edit. Try again when it finishes.' }
				}
				// Never strand the user's unsaved work: checkpoint it, then switch
				// without the confirmation dialog an agent cannot answer.
				if (editor.revisionDirty) await editor.createRevision({ origin: 'manual', label: 'Auto checkpoint' })
				const ok = await editor.switchRevision(payload.revisionId, { force: true, engineTurnId: payload.engineTurnId })
				return ok ? { ok: true } : { ok: false, error: 'The editor could not switch to that revision.' }
			}
			case 'upsert-assets': {
				// Sounds main generated for the agent: the store hears of them before any op can place them.
				if (!open) return { ok: false, error: 'No project is open in the editor.' }
				for (const asset of payload.assets ?? []) {
					// An agent's import ends its download card the way the user's own does.
					if (editor.urlImports[asset.id] !== undefined) {
						const next = { ...editor.urlImports }
						delete next[asset.id]
						editor.urlImports = next
					}
					editor.upsertAsset(asset)
				}
				return { ok: true }
			}
			case 'export': {
				if (!open) return { ok: false, error: 'No project is open in the editor.' }
				if (editor.isRendering) return { ok: false, error: 'An export is already running. Wait for it to finish.' }
				if (!editor.canExport) return { ok: false, error: 'Nothing to export: the timeline is empty or its media is not ready.' }
				editor.startExportBatch('original', ['h264'])
				return { ok: true, detail: 'Export started (H.264, original quality). FrameFlow shows its progress; the file lands in the project’s exports folder.' }
			}
			default:
				throw new Error(`Unknown request ${kind}`)
		}
	}

	if (api?.onMcpRequest) {
		api.onMcpRequest(async (request: { id: string; kind: string; payload: any }) => {
			try {
				api.mcpRespond({ id: request.id, ok: true, result: await answer(request.kind, request.payload) })
			} catch (error: any) {
				api.mcpRespond({ id: request.id, ok: false, error: error?.message || String(error) })
			}
		})
		api.onAgentAccessState((state: AgentAccessState) => {
			access.value = state
			const next = { ...known.value }
			for (const session of state.sessions) next[session.id] = session
			known.value = next
		})
		api.onEngineActivity?.((activity: AgentActivity) => onFocus(activity))
		api.onAgentRoundsEvent?.((event: RoundEvent) => onRoundEvent(event))
		// While an agent holds the open project, the editor's own export and revision switches wait.
		watch(mcpWorking, (held) => { useEditorStore().agentHolds = held ? held.clientName : null }, { immediate: true })
		// The chat shows the open project's rounds: read them whenever it changes.
		watch(() => useEditorStore().threadId, (id) => { void loadRounds(id) }, { immediate: true })
		api.onAgentActivity((activity: AgentActivity) => {
			onFocus(activity)
			const index = activities.value.findIndex((a) => a.id === activity.id)
			if (index === -1) activities.value = [...activities.value, activity].slice(-MAX_ACTIVITIES)
			else activities.value = activities.value.map((a, i) => (i === index ? activity : a))
		})
		setInterval(() => {
			if (sessions.value.length || focus.value || lock.value) now.value = Date.now()
		}, 1000)
		void refresh()
	}

	return {
		access, activities, sessions, liveSession, editingSession, shownSession, isLive, now,
		feedFor, baselineRevision, refresh, disconnect,
		focus, followAgent, setFollowAgent, readingAsset, lookedAt, isReading, agentActive,
		lock, rounds, mcpWorking, loadRounds, stopRound, nudges, nudgeWorking
	}
})
