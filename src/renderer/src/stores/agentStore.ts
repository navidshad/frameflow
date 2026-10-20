import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AgentAccessState, AgentActivity, AgentSessionInfo } from '@shared/agentFeed'
import type { EditorRevision } from '@shared/types'
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
	const baselineRevision = (sessionId: string | null | undefined): EditorRevision | null => {
		const editor = useEditorStore()
		if (!sessionId || !editor.doc) return null
		const turnIds = new Set(editor.doc.turns.filter((t) => t.agent?.sessionId === sessionId).map((t) => t.id))
		const made = editor.revisions
			.filter((r) => r.turnId && turnIds.has(r.turnId))
			.sort((a, b) => a.seq - b.seq)[0]
		return made ? editor.revisions.find((r) => r.id === made.parentId) || null : null
	}

	const refresh = async () => {
		access.value = await api.getAgentAccess()
	}

	const disconnect = async (sessionId: string) => {
		await api.disconnectAgentSession(sessionId)
	}

	// ===== Live-document bridge =====

	const editorIsOpen = () => window.location.hash.startsWith('#/editor/')

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
					revisions: editor.revisions.map(({ snapshot, ...rest }) => rest),
					currentRevisionId: doc.currentRevisionId || null,
					playheadSec: editor.playheadSec
				}))
			}
			case 'switch-revision': {
				if (!open) return { ok: false, error: 'No project is open in the editor.' }
				if (editor.promptRunning) {
					return { ok: false, error: 'FrameFlow’s own AI is in the middle of an edit. Try again when it finishes.' }
				}
				// Never strand the user's unsaved work: checkpoint it, then switch
				// without the confirmation dialog an agent cannot answer.
				if (editor.revisionDirty) await editor.createRevision({ origin: 'manual', label: 'Auto checkpoint' })
				const ok = await editor.switchRevision(payload.revisionId, { force: true })
				return ok ? { ok: true } : { ok: false, error: 'The editor could not switch to that revision.' }
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
		api.onAgentActivity((activity: AgentActivity) => {
			const index = activities.value.findIndex((a) => a.id === activity.id)
			if (index === -1) activities.value = [...activities.value, activity].slice(-MAX_ACTIVITIES)
			else activities.value = activities.value.map((a, i) => (i === index ? activity : a))
		})
		setInterval(() => {
			if (sessions.value.length) now.value = Date.now()
		}, 1000)
		void refresh()
	}

	return {
		access, activities, sessions, liveSession, editingSession, shownSession, isLive, now,
		feedFor, baselineRevision, refresh, disconnect
	}
})
