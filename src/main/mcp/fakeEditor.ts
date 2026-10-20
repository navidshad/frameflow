import type { Clip, EditorDocument, MediaAsset, TimelineItem } from '@shared/types'
import { applyTimelineDiff } from '@shared/timeline'
import type { TranscriptEntry } from '@shared/captions'
import type { AudioAnalysis } from '@shared/audio'
import { normaliseRecipe, presetOf, recipeKey, soundLength, type SoundRecipe } from '@shared/synth'
import type { EditorBridge, LiveProject, RevisionSummary, SoundReport, TurnCommit } from './bridge'

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
			revisions: [...this.revisions], currentRevisionId: this.current, playheadSec: 0
		}
	}

	async commitTurn(commit: TurnCommit) {
		this.commits.push(commit)
		// The renderer upserts the sounds a turn places before it applies the diff.
		for (const asset of commit.addAssets ?? []) {
			if (!this.doc.media.some((a) => a.id === asset.id)) this.doc.media.push(asset)
		}
		const state = { tracks: this.doc.tracks, timeline: this.doc.timeline }
		const result = applyTimelineDiff(state, commit.turn.diff!, this.doc.media)
		// It replaces arrays rather than mutating them, as the store expects
		this.doc.tracks = state.tracks
		this.doc.timeline = state.timeline
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
			pruned: result.errors
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

	async startExport() {
		this.exports++
		return { ok: true as const, detail: 'Export started.' }
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
}
