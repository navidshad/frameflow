import type { EditorDocument, MediaAsset, TimelineItem } from '@shared/types'
import { computeScope, type AiScope } from '@shared/ai-scope'
import { itemDuration } from '@shared/timeline'

/**
 * Builds the prompt context text for the editor AI (PRD §5.7).
 * Applies the degradation ladder so a multi-hour project always fits the
 * budget — ending, if it must, in an EXPLICIT truncation flag (never silent).
 */

export const MAX_SCENES_PER_ASSET = 60      // ladder: 60 -> 30 -> 12
export const VISUAL_MAX_CHARS = 160
export const CONTEXT_CHAR_BUDGET = 120_000  // ~30k tokens
export const OUTLINE_GIST_COUNT = 2

export interface PromptContextResult {
	contextText: string
	scope: AiScope
	tokenEstimate: number
	truncated: boolean
	thinContext: boolean
}

const fmt = (n: number) => Math.round(n * 100) / 100

export function buildPromptContext(
	doc: EditorDocument,
	prompt: string,
	opts: { selectedItemIds: string[]; playheadSec: number; widen?: 'chapter' | 'full' }
): PromptContextResult {
	const scope = computeScope({
		timeline: doc.timeline,
		markers: doc.markers || [],
		selectedItemIds: opts.selectedItemIds,
		playheadSec: opts.playheadSec,
		mediaIds: doc.media.map((a) => a.id),
		widen: opts.widen
	})

	const inScopeIds = new Set(scope.itemIds)
	const inScopeItems = doc.timeline
		.filter((i) => inScopeIds.has(i.id))
		.sort((a, b) => a.timelineStart - b.timelineStart)
	const scopeAssets = doc.media.filter((a) => scope.assetIds.includes(a.id))

	const clipOf = (item: TimelineItem) =>
		doc.media.find((a) => a.id === item.sourceAssetId)?.clips.find((c) => c.id === item.sourceClipId)

	const thinContext = !scopeAssets.some((a) => a.clips.some((c) => !!c.visual))

	// Degradation ladder state
	let scenesCap = MAX_SCENES_PER_ASSET
	let dropNeighborVisuals = false
	let dropUnusedAssetScenes = false
	let truncated = false

	const usedAssetIds = new Set(inScopeItems.map((i) => i.sourceAssetId))
	const selectedSet = new Set(opts.selectedItemIds)

	const build = (): string => {
		const lines: string[] = []

		// ---- PROJECT ----
		lines.push('PROJECT')
		lines.push(`- Sequence: ${fmt(doc.timelineMeta.duration)}s, ${doc.timelineMeta.fps}fps, ${doc.timelineMeta.width}x${doc.timelineMeta.height}`)
		for (const track of [...doc.tracks].sort((a, b) => a.order - b.order)) {
			const flags = [track.locked && 'locked', track.muted && 'muted', track.hidden && 'hidden'].filter(Boolean).join(', ')
			lines.push(`- Track ${track.id} "${track.name}" (${track.kind}${flags ? ', ' + flags : ''})`)
		}
		for (const asset of doc.media) {
			const described = asset.clips.some((c) => !!c.visual)
			lines.push(`- Asset ${asset.id} "${asset.name}" ${asset.kind} ${fmt(asset.metadata?.duration || 0)}s — ${asset.clips.length} scenes, descriptions: ${described ? 'yes' : 'no'}`)
		}
		lines.push('')

		// ---- SCOPE ----
		lines.push(`SCOPE: ${scope.label}`)
		lines.push('')

		// ---- TIMELINE OUTLINE (only when scoped narrower than full) ----
		if (scope.kind !== 'full' && doc.timeline.length > 0) {
			lines.push('TIMELINE OUTLINE')
			const markers = [...(doc.markers || [])].sort((a, b) => a.time - b.time)
			const totalEnd = doc.timelineMeta.duration || 0
			const bounds: { t0: number; t1: number; label: string }[] = []
			if (markers.length > 0) {
				const cuts = [0, ...markers.map((m) => m.time), totalEnd]
				for (let k = 0; k < cuts.length - 1; k++) {
					if (cuts[k + 1] - cuts[k] < 0.5) continue
					const label = k === 0 ? 'Intro' : markers[k - 1]?.label || `#${k}`
					bounds.push({ t0: cuts[k], t1: cuts[k + 1], label })
				}
			} else {
				for (let t = 0; t < totalEnd; t += 600) {
					bounds.push({ t0: t, t1: Math.min(t + 600, totalEnd), label: `#${bounds.length + 1}` })
				}
			}
			for (const b of bounds) {
				const items = doc.timeline.filter((i) => i.timelineStart >= b.t0 && i.timelineStart < b.t1)
				if (!items.length) continue
				const dur = items.reduce((sum, i) => sum + itemDuration(i), 0)
				const gists = items
					.map((i) => clipOf(i)?.visual)
					.filter(Boolean)
					.slice(0, OUTLINE_GIST_COUNT)
					.map((v) => `"${v!.slice(0, 120)}"`)
					.join(' / ')
				lines.push(`- Chapter "${b.label}" [${fmt(b.t0)}–${fmt(b.t1)}s]: ${items.length} items, ${fmt(dur)}s${gists ? `; gist: ${gists}` : ''}`)
			}
			lines.push('')
		}

		// ---- ITEMS IN SCOPE ----
		const header = scope.kind === 'full' ? 'CURRENT TIMELINE' : `ITEMS IN SCOPE (${inScopeItems.length})`
		lines.push(header)
		if (inScopeItems.length === 0) {
			lines.push('(empty — build a new cut from the available scenes)')
		}
		for (const item of inScopeItems) {
			const track = doc.tracks.find((t) => t.id === item.trackId)
			const clip = clipOf(item)
			const showVisual = clip?.visual && (!dropNeighborVisuals || selectedSet.has(item.id) || scope.kind !== 'selection')
			const visual = showVisual ? ` | ${clip!.visual!.slice(0, VISUAL_MAX_CHARS)}` : ''
			lines.push(
				`- ${item.id} | ${track?.name || '?'} | at ${fmt(item.timelineStart)}s | src ${fmt(item.in)}–${fmt(item.out)}s | ${item.speed}x | "${item.label || ''}"${visual}`
			)
		}
		lines.push('')

		// ---- AVAILABLE SCENES ----
		lines.push('AVAILABLE SCENES (add material from here via addClips)')
		for (const asset of scopeAssets) {
			if (dropUnusedAssetScenes && !usedAssetIds.has(asset.id)) {
				lines.push(`Asset ${asset.id} "${asset.name}": ${asset.clips.length} scenes omitted for brevity`)
				continue
			}
			lines.push(`Asset ${asset.id} "${asset.name}" (${fmt(asset.metadata?.duration || 0)}s):`)
			const clips = asset.clips
			if (clips.length <= scenesCap) {
				for (const clip of clips) {
					const visual = clip.visual ? ` "${clip.visual.slice(0, VISUAL_MAX_CHARS)}"` : ''
					lines.push(`- #${clip.index} [${fmt(clip.in)}–${fmt(clip.out)}s, ${fmt(clip.duration)}s]${visual}`)
				}
			} else {
				// Always include scenes already used by in-scope items, then sample evenly
				const usedSceneIds = new Set(inScopeItems.filter((i) => i.sourceAssetId === asset.id).map((i) => i.sourceClipId))
				const used = clips.filter((c) => usedSceneIds.has(c.id))
				const rest = clips.filter((c) => !usedSceneIds.has(c.id))
				const budget = Math.max(scenesCap - used.length, 4)
				const step = Math.max(1, Math.floor(rest.length / budget))
				const sampled = rest.filter((_, i) => i % step === 0).slice(0, budget)
				const shown = [...used, ...sampled].sort((a, b) => a.index - b.index)
				for (const clip of shown) {
					const visual = clip.visual ? ` "${clip.visual.slice(0, VISUAL_MAX_CHARS)}"` : ''
					lines.push(`- #${clip.index} [${fmt(clip.in)}–${fmt(clip.out)}s, ${fmt(clip.duration)}s]${visual}`)
				}
				lines.push(`- … +${clips.length - shown.length} more scenes between ${fmt(clips[0].in)}s and ${fmt(clips[clips.length - 1].out)}s (evenly sampled above)`)
			}
		}
		lines.push('')

		// ---- USER REQUEST ----
		lines.push('USER REQUEST')
		lines.push(prompt)

		return lines.join('\n')
	}

	// Degradation ladder until we fit the budget
	let text = build()
	if (text.length > CONTEXT_CHAR_BUDGET) { scenesCap = 30; text = build() }
	if (text.length > CONTEXT_CHAR_BUDGET) { scenesCap = 12; text = build() }
	if (text.length > CONTEXT_CHAR_BUDGET) { dropNeighborVisuals = true; text = build() }
	if (text.length > CONTEXT_CHAR_BUDGET) { dropUnusedAssetScenes = true; text = build() }
	if (text.length > CONTEXT_CHAR_BUDGET) {
		// Final resort: hard-truncate — but never the ITEMS IN SCOPE section.
		// AVAILABLE SCENES comes after ITEMS, so cutting the tail (before USER
		// REQUEST) only loses scene listings.
		const requestBlock = `\nUSER REQUEST\n${prompt}`
		text = text.slice(0, CONTEXT_CHAR_BUDGET - requestBlock.length - 64) +
			'\n[... scene listings truncated — long project ...]\n' + requestBlock
		truncated = true
	}

	return {
		contextText: text,
		scope,
		tokenEstimate: Math.round(text.length / 4),
		truncated,
		thinContext
	}
}
