import type { EditorDocument, EditorRevision, MediaAsset, PromptTurn } from '@shared/types'
import type { AudioAnalysis } from '@shared/audio'
import type { SoundRecipe } from '@shared/synth'
import type { TranscriptEntry } from '@shared/captions'
import type { AgentApplyOutcome } from '@shared/agentFeed'
import type { AudioProvenance, GenerateRequest, ProviderId, SpendPolicy } from '@shared/audioProviders'

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
	/**
	 * FrameFlow's own chat is running a prompt on this project. One agent at a
	 * time: an outside agent may not begin a round (or edit) until it ends.
	 */
	chatBusy?: boolean
}

/** A project in the user's FrameFlow, for list_projects. */
export interface ProjectSummary {
	id: string
	title: string
	createdAt: number
	updatedAt?: number
	mediaCount: number
	durationSec: number
	/** The editor is showing it now. */
	open: boolean
}

/** Where an export stands. */
export interface ExportStatus {
	renderId: string
	phase: 'rendering' | 'stitching' | 'done' | 'error'
	percent: number
	outputPath?: string
	error?: string
	startedAt: number
	updatedAt: number
}

export interface InspectOptions {
	times?: number[]
	fromSec?: number
	toSec?: number
	everySec?: number
	columns?: number
	tileWidth?: number
	loudness?: boolean
}

export interface InspectReport {
	facts: import('../editor/exportInspect').ExportFacts
	sheet?: { data: string; mimeType: string; times: number[]; columns: number; rows: number }
	loudness?: { lufs: number | null; truePeakDb: number | null }
}

export type MediaSource = { url: string } | { path: string; name?: string }

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
	/**
	 * The motion layers in the frame and the state of each (still being checked,
	 * showing an older version, drawing nothing), plus how many of the export's
	 * motion clips are rendered. Absent when the timeline has no motion.
	 */
	motionNote?: string
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
	/** Start an export of the live timeline; FrameFlow shows its progress like any other. */
	startExport(project: LiveProject, options: { quality: 'original' | 'preview' }): Promise<{ ok: true; renderId: string } | { ok: false; error: string }>
	/** The latest progress of a render, or of the project's newest one. */
	exportStatus(query: { renderId?: string; threadId: string }): ExportStatus | null
	/** What an exported file is, and contact sheets of its frames. */
	inspectExport(file: string, options: InspectOptions): Promise<InspectReport>
	/** Every editor project in the user's FrameFlow. */
	listProjects(): Promise<ProjectSummary[]>
	createProject(title: string): Promise<{ id: string; title: string }>
	/** Show a project in the editor, and resolve once it has loaded. */
	openProject(threadId: string): Promise<{ ok: true } | { ok: false; error: string }>
	/** Import a link or a file into the project; resolves once the asset exists (its preprocessing runs on). */
	importMedia(project: LiveProject, source: MediaSource, onProgress?: (percent: number, phase?: string) => void): Promise<MediaAsset>

	/** Render each recipe (cached by recipe) and return its asset, ready to be placed. */
	prepareSounds(project: LiveProject, recipes: SoundRecipe[]): Promise<MediaAsset[]>
	/** Measure a recipe, or a sound already in the project. */
	inspectSound(project: LiveProject, target: { recipe: SoundRecipe } | { assetId: string }): Promise<SoundReport>
	/** Waveform and loudness of media, measured once and cached. */
	audioAnalyses(project: LiveProject, assetIds: string[]): Promise<Record<string, AudioAnalysis>>
	/** Which audio providers are connected, and what an agent may spend on them. */
	audioStatus(): { connected: ProviderId[]; spend: SpendPolicy }
	/** What a request would cost in USD before it is made; null when the provider bills in credits. */
	estimateAudio(req: GenerateRequest): number | null
	/** Make a voice, effect or music with a provider, keep it as an asset in the project and hand it to the editor. */
	generateAudio(project: LiveProject, req: GenerateRequest): Promise<{ asset: MediaAsset; provenance: AudioProvenance }>
}
