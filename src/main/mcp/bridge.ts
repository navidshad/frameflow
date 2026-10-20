import type { EditorDocument, EditorRevision, MediaAsset, PromptTurn } from '@shared/types'
import type { AudioAnalysis } from '@shared/audio'
import type { SoundRecipe } from '@shared/synth'
import type { TranscriptEntry } from '@shared/captions'
import type { AgentApplyOutcome } from '@shared/agentFeed'

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

/** What the renderer reports after it applied (or could not apply) an agent's turn. */
export type ApplyOutcome = AgentApplyOutcome

export interface TurnCommit {
	threadId: string
	turn: PromptTurn
	addMarkers?: { time: number; label: string }[]
	docSettings?: { captionsEnabled?: boolean; loudnessEnabled?: boolean }
	/** Assets the turn's diff refers to that the renderer does not have yet (rendered sounds). */
	addAssets?: MediaAsset[]
}

export interface RenderedFrame {
	/** Base64 image for the agent. */
	data: string
	mimeType: string
	/** A small data URL for the activity feed. */
	thumbnail?: string
}

/** What a sound measures, in words an agent can read, and a picture of it. */
export interface SoundReport {
	lengthSec: number
	/** The peak, in dBFS, and the loudness meter's reading. */
	truePeakDb: number | null
	lufs: number | null
	renderMs?: number
	/** A spectrogram as a base64 PNG: what the sound looks like, since an agent cannot hear it. */
	spectrogram?: string
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
	/** Render each recipe (cached by recipe) and return its asset, ready to be placed. */
	prepareSounds(project: LiveProject, recipes: SoundRecipe[]): Promise<MediaAsset[]>
	/** Measure a recipe, or a sound already in the project. */
	inspectSound(project: LiveProject, target: { recipe: SoundRecipe } | { assetId: string }): Promise<SoundReport>
	/** Waveform and loudness of media, measured once and cached. */
	audioAnalyses(project: LiveProject, assetIds: string[]): Promise<Record<string, AudioAnalysis>>
}
