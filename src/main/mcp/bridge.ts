import type { EditorDocument, EditorRevision, PromptTurn } from '@shared/types'
import type { TranscriptEntry } from '@shared/captions'

/**
 * What the MCP tools need from the rest of the app, as an interface.
 *
 * The renderer's store owns the timeline (its 800ms autosave overwrites main's
 * copy), so every read asks it for the LIVE document and every write goes down
 * the same `editor-turn-update` path FrameFlow's own AI uses. The Electron
 * implementation lives in rendererBridge.ts; the integration test supplies a
 * fake, which is why nothing here imports Electron.
 */

export type RevisionSummary = Pick<EditorRevision, 'id' | 'seq' | 'label' | 'origin' | 'parentId' | 'createdAt' | 'turnId'>

export interface LiveProject {
	threadId: string
	title: string
	doc: EditorDocument
	revisions: RevisionSummary[]
	currentRevisionId: string | null
	playheadSec: number
}

/** What the renderer reports after it applied (or could not apply) an agent turn. */
export type ApplyOutcome =
	| {
		ok: true
		revisionId: string
		revisionSeq: number
		parentRevisionId: string | null
		counts: { added: number; removed: number; updated: number; markers: number }
		/** Ops the live doc rejected when the diff was dry-run against it. */
		pruned: string[]
	}
	| { ok: false; error: string }

export interface TurnCommit {
	threadId: string
	turn: PromptTurn
	addMarkers?: { time: number; label: string }[]
	docSettings?: { captionsEnabled?: boolean; loudnessEnabled?: boolean }
}

export interface RenderedFrame {
	/** Base64 image for the agent. */
	data: string
	mimeType: string
	/** A small data URL for the activity feed. */
	thumbnail?: string
}

export interface EditorBridge {
	/** Null when no project is open in the editor. */
	getLiveProject(): Promise<LiveProject | null>
	/** Persist the turn and apply it in the renderer; resolves once it is a revision. */
	commitTurn(commit: TurnCommit): Promise<ApplyOutcome>
	readTranscripts(project: LiveProject, assetIds: string[]): Promise<Record<string, TranscriptEntry[]>>
	renderFrame(project: LiveProject, timeSec: number): Promise<RenderedFrame>
	switchRevision(revisionId: string): Promise<{ ok: true } | { ok: false; error: string }>
	startExport(): Promise<{ ok: true; detail: string } | { ok: false; error: string }>
}
