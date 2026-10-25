import type { Clip, EditorDocument, MediaAsset, TimelineItem } from '@shared/types'
import { applyTimelineDiff, repairOverlapsReporting } from '@shared/timeline'
import type { TranscriptEntry } from '@shared/captions'
import type { AudioAnalysis } from '@shared/audio'
import { normaliseRecipe, presetOf, recipeKey, soundLength, type SoundRecipe } from '@shared/synth'
import type { AudioProvenance, GenerateRequest, ProviderId, SpendPolicy } from '@shared/audioProviders'
import type {
	EditorBridge, ExportStatus, InspectOptions, InspectReport, LiveProject, MediaSource, ProjectSummary, RevisionSummary,
	SoundReport, TurnCommit
} from './bridge'

/**
 * A fake editor for tests: a document in memory that applies diffs the way the
 * renderer does. Used by the server test and by the CLI-engine tests that
 * point a real Claude Code / Codex at a real server.
 */

export const TOKEN = 'ff_test0123456789abcdef0123456789ab'

export function makeAsset(): MediaAsset {
	const clips: Clip[] = [0, 1, 2].map((i) => ({
		id: `team-c${i + 1}`, sourceAssetId: 'team', index: i + 1,
		in: i * 10, out: i * 10 + 10, duration: 10,
		visual: i === 2 ? 'A bar chart showing triage three times faster' : 'Two people talking',
		text: `line ${i + 1}`, selected: false
	}))
	return {
		id: 'team', kind: 'video', name: 'greeting_team.mp4', originalPath: '/tmp/greeting_team.mp4',
		metadata: { duration: 30 } as MediaAsset['metadata'],
		preprocessing: { transcriptPath: '/tmp/team.json' } as MediaAsset['preprocessing'],
		clips, createdAt: 0
	}
}

export function makeDoc(): EditorDocument {
	const item: TimelineItem = {
		id: 'i1', trackId: 'v1', sourceAssetId: 'team', timelineStart: 0,
		in: 0, out: 30, speed: 1, preservePitch: true, duration: 30, label: 'greeting_team'
	}
	return {
		schemaVersion: 2,
		media: [makeAsset()],
		tracks: [{ id: 'v1', kind: 'video', name: 'V1', order: 0, muted: false, locked: false, hidden: false, height: 64 }],
		timeline: [item],
		timelineMeta: { fps: 30, width: 1920, height: 1080, duration: 30 },
		activePersonaId: 'podcast-editor',
		turns: [],
		historyRef: { currentStepId: 'step-0', stepCount: 0 }
	}
}

/** A 1×1 PNG, enough to prove an image travels. */
export const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

export class FakeEditor implements EditorBridge {
	doc = makeDoc()
	open = true
	revisions: RevisionSummary[] = [{ id: 'r0', seq: 0, label: 'Original', origin: 'init', parentId: null, createdAt: 0 }]
	current = 'r0'
	commits: TurnCommit[] = []
	exports = 0

	async getLiveProject(): Promise<LiveProject | null> {
		if (!this.open) return null
		return {
			threadId: 't1', title: 'BytePets pre-pitch', doc: JSON.parse(JSON.stringify(this.doc)),
			revisions: [...this.revisions], currentRevisionId: this.current, playheadSec: 0, chatBusy: this.chatBusy
		}
	}

	async commitTurn(commit: TurnCommit) {
		this.commits.push(commit)
		// The renderer upserts the sounds a turn places before it applies the diff.
		for (const asset of commit.addAssets ?? []) {
			if (!this.doc.media.some((a) => a.id === asset.id)) this.doc.media.push(asset)
		}
		const state = { tracks: this.doc.tracks, timeline: this.doc.timeline, motionKits: this.doc.motionKits ?? [] }
		const result = applyTimelineDiff(state, commit.turn.diff!, this.doc.media)
		// As the store's dry run does: overlaps are pushed right, and said.
		const shifted = repairOverlapsReporting(state)
		// It replaces arrays rather than mutating them, as the store expects
		this.doc.tracks = state.tracks
		this.doc.timeline = state.timeline
		this.doc.motionKits = state.motionKits
		const seq = this.revisions.length
		const rev = { id: `r${seq}`, seq, label: commit.turn.agent!.name, origin: 'ai' as const, parentId: this.current, createdAt: Date.now() }
		this.revisions.push(rev)
		const parent = this.current
		this.current = rev.id
		return {
			ok: true as const, revisionId: rev.id, revisionSeq: seq, parentRevisionId: parent,
			counts: {
				added: commit.turn.diff!.addItems?.length || 0,
				removed: commit.turn.diff!.removeItemIds?.length || 0,
				updated: commit.turn.diff!.updateItems?.length || 0,
				markers: commit.addMarkers?.length || 0
			},
			pruned: result.errors,
			shifted: shifted.length ? shifted : undefined
		}
	}

	async readTranscripts(_project: LiveProject, ids: string[]): Promise<Record<string, TranscriptEntry[]>> {
		return ids.includes('team')
			? { team: [{ start: 21, end: 24, text: 'How much faster is triage now?' }, { start: 24, end: 27, text: 'Three times faster.' }] }
			: {}
	}

	async renderFrame() {
		return { data: PIXEL, mimeType: 'image/png', thumbnail: `data:image/png;base64,${PIXEL}` }
	}

	async switchRevision(id: string) {
		this.current = id
		return { ok: true as const }
	}

	/** Projects the fake knows; t1 is the one open. */
	projects: ProjectSummary[] = [
		{ id: 't1', title: 'BytePets pre-pitch', createdAt: 1, updatedAt: 2, mediaCount: 1, durationSec: 30, open: true },
		{ id: 't2', title: 'Old cut', createdAt: 0, mediaCount: 0, durationSec: 0, open: false }
	]
	chatBusy = false
	imported: MediaSource[] = []
	exportPhase: ExportStatus['phase'] = 'done'

	async startExport(_project: LiveProject, options: { quality: 'original' | 'preview' }) {
		this.exports++
		this.lastQuality = options.quality
		return { ok: true as const, renderId: `render-${this.exports}` }
	}
	lastQuality: 'original' | 'preview' | null = null

	exportStatus(query: { renderId?: string; threadId: string }): ExportStatus | null {
		if (!this.exports) return null
		const renderId = query.renderId ?? `render-${this.exports}`
		return {
			renderId, phase: this.exportPhase, percent: this.exportPhase === 'done' ? 100 : 40,
			outputPath: this.exportPhase === 'done' ? '/tmp/export.mp4' : undefined, startedAt: 0, updatedAt: 1000
		}
	}

	async inspectExport(file: string, options: InspectOptions): Promise<InspectReport> {
		return {
			facts: {
				file, bytes: 1_000_000, durationSec: 30, width: 1920, height: 1080, fps: 30, videoCodec: 'h264',
				videoFrames: 900, audioCodec: 'aac', sampleRate: 48000, channels: 2
			},
			sheet: options.times && !options.times.length ? undefined : { data: PIXEL, mimeType: 'image/png', times: options.times ?? [0, 15], columns: 2, rows: 1 },
			loudness: options.loudness ? { lufs: -14.2, truePeakDb: -1.1 } : undefined
		}
	}

	async mediaSheet(_project: LiveProject, _assetId: string, options: InspectOptions) {
		const times = options.times ?? [0, 10, 20]
		return { sheet: { data: PIXEL, mimeType: 'image/png', times, columns: times.length, rows: 1 }, durationSec: 30 }
	}

	async findSilences() {
		return [{ start: 9.5, end: 10.4 }, { start: 19.2, end: 20.1 }]
	}

	sheetTimes: number[][] = []
	async timelineSheet(_project: LiveProject, times: number[]) {
		this.sheetTimes.push(times)
		return { sheet: { data: PIXEL, mimeType: 'image/png', times, columns: times.length, rows: 1 }, notes: times.map(() => null) }
	}

	async listProjects(): Promise<ProjectSummary[]> {
		return this.projects.map((p) => ({ ...p, open: this.open && p.id === 't1' }))
	}

	async createProject(title: string) {
		const id = `t${this.projects.length + 1}`
		this.projects.push({ id, title, createdAt: Date.now(), mediaCount: 0, durationSec: 0, open: false })
		return { id, title }
	}

	opened: string[] = []
	async openProject(threadId: string) {
		this.opened.push(threadId)
		return { ok: true as const }
	}

	async importMedia(_project: LiveProject, source: MediaSource, onProgress?: (percent: number) => void): Promise<MediaAsset> {
		this.imported.push(source)
		onProgress?.(50)
		onProgress?.(100)
		const asset: MediaAsset = {
			id: `m${this.imported.length}`, kind: 'video', name: 'url' in source ? 'Episode 1.mp4' : source.name || 'file.mp4',
			originalPath: '/tmp/x.mp4', metadata: { duration: 566, width: 1920, height: 1080 } as MediaAsset['metadata'],
			preprocessing: {}, preprocessState: 'pending', clips: [], createdAt: 0
		}
		this.doc.media.push(asset)
		return asset
	}

	/** Sounds "rendered" so far, in the order asked. */
	renderedSounds: SoundRecipe[] = []

	async prepareSounds(_project: LiveProject, recipes: SoundRecipe[]): Promise<MediaAsset[]> {
		this.renderedSounds.push(...recipes)
		return recipes.map((r) => {
			const synth = normaliseRecipe(r)
			const preset = presetOf(r.kind)
			return {
				id: `synth-${recipeKey(r).replace(/[^a-z0-9]/gi, '')}`, kind: 'audio' as const,
				name: preset.variants > 1 ? `${preset.label} ${synth.variant + 1}` : preset.label,
				originalPath: '/tmp/sound.wav', metadata: { duration: soundLength(r) } as MediaAsset['metadata'],
				preprocessing: {}, preprocessState: 'completed' as const, clips: [], createdAt: 0, synth
			}
		})
	}

	async inspectSound(_project: LiveProject, target: { recipe: SoundRecipe } | { assetId: string }): Promise<SoundReport> {
		const recipe = 'recipe' in target ? target.recipe : this.doc.media.find((a) => a.id === target.assetId)?.synth
		if (!recipe) throw new Error('No such sound')
		const n = normaliseRecipe(recipe)
		return { lengthSec: soundLength(recipe), truePeakDb: n.levelDb, lufs: n.levelDb - 12, renderMs: 40, spectrogram: PIXEL }
	}

	async audioAnalyses(_project: LiveProject, assetIds: string[]): Promise<Record<string, AudioAnalysis>> {
		return Object.fromEntries(assetIds.map((id) => {
			const asset = this.doc.media.find((a) => a.id === id)
			const sound = asset?.synth
			return [id, {
				v: 1 as const, hasAudio: true, durationSec: asset?.metadata?.duration ?? 0, peakRate: 50, peaks: [],
				lufs: sound ? sound.levelDb - 12 : -16, truePeakDb: sound ? sound.levelDb : -3, lra: null
			}]
		}))
	}

	/** Providers the fake pretends are connected; the cap an agent may spend. */
	connected: ProviderId[] = ['elevenlabs']
	spend: SpendPolicy = { maxGenerationsPerTurn: 2, maxUsdPerTurn: 1 }
	generated: GenerateRequest[] = []

	audioStatus() {
		return { connected: this.connected, spend: this.spend }
	}

	estimateAudio(req: GenerateRequest): number | null {
		return req.capability === 'music' ? 0.6 : 0.05
	}

	async generateAudio(_project: LiveProject, req: GenerateRequest): Promise<{ asset: MediaAsset; provenance: AudioProvenance }> {
		this.generated.push(req)
		const provenance: AudioProvenance = {
			provider: req.provider, capability: req.capability, prompt: req.prompt, voice: req.voice,
			costUsd: this.estimateAudio(req), madeAt: 0
		}
		const asset: MediaAsset = {
			id: `gen-${this.generated.length}`, kind: 'audio', name: `${req.capability}: ${req.prompt}`.slice(0, 40),
			originalPath: '/tmp/generated.mp3', metadata: { duration: req.durationSec ?? 4 } as MediaAsset['metadata'],
			preprocessing: {}, preprocessState: 'completed', clips: [], createdAt: 0, generated: provenance
		}
		this.doc.media.push(asset)
		return { asset, provenance }
	}
}
