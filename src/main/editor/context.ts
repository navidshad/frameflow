import type { Clip, EditorDocument, TimelineItem } from '@shared/types'
import { computeScope, type AiScope } from '@shared/ai-scope'
import { itemDuration } from '@shared/timeline'

/**
 * Builds the prompt context text for the editor AI (PRD §5.7).
 * Applies the degradation ladder so a multi-hour project always fits the
 * budget — ending, if it must, in an EXPLICIT truncation flag (never silent).
 *
 * Long-form personas get a fundamentally different deal from summarizers: to
 * assemble a full-length cut the model must be able to NAME every piece, so
 * the longform ladder shrinks descriptions all the way to nothing before it
 * drops a single scene number. Summarize keeps the original ladder.
 */

export type ContextMode = 'longform' | 'summarize'

export const MAX_SCENES_PER_ASSET = 60      // summarize ladder: 60 -> 30 -> 12
export const VISUAL_MAX_CHARS = 160
export const TEXT_MAX_CHARS = 120
export const BOTH_FIELDS_MAX_CLIPS = 400    // emit text AND visual only for small assets
export const SECONDARY_MAX_CHARS = 60
export const ITEM_SUMMARY_MAX_CHARS = 200   // per-item coverage summary (merged range items)
export const CONTEXT_CHAR_BUDGET = 120_000  // ~30k tokens
export const CONTEXT_CHAR_BUDGET_LONGFORM = 420_000 // ~130k tokens = 13% of a 1M window
export const OUTLINE_GIST_COUNT = 2

/** Gap-filler text produced by deriveClipsFromTranscript for dead air. */
export const SILENCE_TEXT = '[Silence]'

/**
 * Speech-to-text can fall into a repetition loop and emit the SAME line for
 * thousands of consecutive pieces. Listing them individually buries the real
 * content and reads to the model as "nothing happens here for 40 minutes", so
 * runs this long collapse into one row that says what actually went wrong.
 */
export const REPEAT_RUN_MIN = 8

export interface PromptContextResult {
	contextText: string
	scope: AiScope
	tokenEstimate: number
	truncated: boolean
	thinContext: boolean
}

const fmt = (n: number) => Math.round(n * 100) / 100
const fmt1 = (n: number) => Math.round(n * 10) / 10

/**
 * When the camera was rolling, as an unambiguous UTC window. Emitted so the
 * model can order material by capture time instead of guessing from filenames
 * and import order — and so it can tell consecutive segments (windows that
 * abut) from parallel camera angles (windows that overlap).
 */
function recordedWindow(asset: { metadata?: { recordedAt?: number; duration?: number } }): string | null {
	const start = asset.metadata?.recordedAt
	if (!start || !Number.isFinite(start)) return null
	const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z')
	const duration = asset.metadata?.duration
	return duration && duration > 0
		? `${iso(start)}–${iso(start + duration * 1000)}`
		: iso(start)
}

/**
 * A rung of the degradation ladder. Rung 0 is the ideal context; each later
 * rung gives up something cheaper than the rung after it.
 */
interface Rung {
	scenesCap: number
	contentCap: number
	bothFields: boolean
	dropNeighborVisuals: boolean
	dropUnusedAssetScenes: boolean
}

const rung = (over: Partial<Rung>, base: Rung): Rung => ({ ...base, ...over })

function buildLadder(mode: ContextMode): Rung[] {
	if (mode === 'summarize') {
		const base: Rung = {
			scenesCap: MAX_SCENES_PER_ASSET,
			contentCap: VISUAL_MAX_CHARS,
			bothFields: true,
			dropNeighborVisuals: false,
			dropUnusedAssetScenes: false
		}
		return [
			base,
			rung({ scenesCap: 30 }, base),
			rung({ scenesCap: 12 }, base),
			rung({ scenesCap: 12, dropNeighborVisuals: true }, base),
			rung({ scenesCap: 12, dropNeighborVisuals: true, dropUnusedAssetScenes: true }, base)
		]
	}
	// Longform: content shrinks first, scene numbers last.
	const base: Rung = {
		scenesCap: 4000,
		contentCap: TEXT_MAX_CHARS,
		bothFields: true,
		dropNeighborVisuals: false,
		dropUnusedAssetScenes: false
	}
	const rungs: Rung[] = [
		base,
		rung({ bothFields: false }, base),
		rung({ bothFields: false, contentCap: 60 }, base),
		rung({ bothFields: false, contentCap: 24 }, base),
		rung({ bothFields: false, contentCap: 0 }, base),
		rung({ bothFields: false, contentCap: 0, dropNeighborVisuals: true }, base),
		rung({ bothFields: false, contentCap: 0, dropNeighborVisuals: true, dropUnusedAssetScenes: true }, base)
	]
	// Only now do scene numbers start disappearing.
	for (const cap of [2000, 800, 300, 60]) {
		rungs.push(rung({
			scenesCap: cap, bothFields: false, contentCap: 0,
			dropNeighborVisuals: true, dropUnusedAssetScenes: true
		}, base))
	}
	return rungs
}

/** Strip pipes/newlines so a transcript line can never break the table format. */
const cell = (source: string | undefined, cap: number): string => {
	if (!source || cap <= 0) return ''
	return source.replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap)
}

export function buildPromptContext(
	doc: EditorDocument,
	prompt: string,
	opts: {
		selectedItemIds: string[]
		playheadSec: number
		widen?: 'chapter' | 'full'
		mode?: ContextMode
	}
): PromptContextResult {
	const mode: ContextMode = opts.mode || 'longform'

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

	// ---- Source-clip lookup, sorted by source time, built lazily once ----
	const clipsByAsset = new Map<string, Clip[]>()
	const clipsOfAsset = (assetId: string): Clip[] => {
		let list = clipsByAsset.get(assetId)
		if (!list) {
			list = [...(doc.media.find((a) => a.id === assetId)?.clips || [])].sort((a, b) => a.in - b.in)
			clipsByAsset.set(assetId, list)
		}
		return list
	}
	/** First position whose clip ends after `t`. */
	const firstEndingAfter = (clips: Clip[], t: number): number => {
		let lo = 0, hi = clips.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if (clips[mid].out > t) hi = mid
			else lo = mid + 1
		}
		return lo
	}
	/** First position whose clip starts at or after `t`. */
	const firstStartingAtOrAfter = (clips: Clip[], t: number): number => {
		let lo = 0, hi = clips.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if (clips[mid].in >= t) hi = mid
			else lo = mid + 1
		}
		return lo
	}

	const contentOf = (clip: Clip, contentCap: number, bothFields: boolean): string => {
		// [Silence] is 9 chars and is the single most decision-relevant fact for a
		// cleanup edit, so it survives every content rung.
		const silence = clip.text === SILENCE_TEXT && !clip.visual
		if (silence) return SILENCE_TEXT
		if (contentCap <= 0) return ''
		const primary = mode === 'longform' ? clip.text : clip.visual
		const secondary = mode === 'longform' ? clip.visual : clip.text
		const main = cell(primary || secondary, contentCap)
		if (!bothFields || !primary || !secondary) return main
		const extra = cell(secondary, Math.min(contentCap, SECONDARY_MAX_CHARS))
		return extra ? `${main} ~ ${extra}` : main
	}

	/**
	 * What a timeline item actually covers in its source, by source time.
	 * Range-expanded items are MERGED (no sourceClipId), so without this the
	 * model would see content-free rows on every follow-up turn.
	 */
	const coverageOf = (item: TimelineItem, cap: number, bothFields: boolean) => {
		const clips = clipsOfAsset(item.sourceAssetId)
		const start = firstEndingAfter(clips, item.in)
		const end = firstStartingAtOrAfter(clips, item.out)
		if (start >= end || start >= clips.length) return { span: '', content: '' }
		const span = start === end - 1
			? `#${clips[start].index}`
			: `#${clips[start].index}–#${clips[end - 1].index}`
		const parts: string[] = []
		let used = 0
		for (let i = start; i < end && used < cap; i++) {
			const piece = contentOf(clips[i], Math.min(cap - used, cap), bothFields)
			if (!piece) continue
			parts.push(piece)
			used += piece.length + 1
		}
		return { span, content: cell(parts.join(' '), cap) }
	}

	const thinContext = !scopeAssets.some((a) =>
		a.clips.some((c) => !!c.visual || (!!c.text && c.text !== SILENCE_TEXT))
	)

	const ladder = buildLadder(mode)
	const budget = mode === 'longform' ? CONTEXT_CHAR_BUDGET_LONGFORM : CONTEXT_CHAR_BUDGET
	let truncated = false

	const usedAssetIds = new Set(inScopeItems.map((i) => i.sourceAssetId))
	const selectedSet = new Set(opts.selectedItemIds)

	const build = (r: Rung): string => {
		const lines: string[] = []

		// ---- PROJECT ----
		lines.push('PROJECT')
		lines.push(`- Sequence: ${fmt(doc.timelineMeta.duration)}s, ${doc.timelineMeta.fps}fps, ${doc.timelineMeta.width}x${doc.timelineMeta.height}`)
		for (const track of [...doc.tracks].sort((a, b) => a.order - b.order)) {
			const flags = [track.locked && 'locked', track.muted && 'muted', track.hidden && 'hidden'].filter(Boolean).join(', ')
			lines.push(`- Track ${track.id} "${track.name}" (${track.kind}${flags ? ', ' + flags : ''})`)
		}
		let anyRecordedAt = false
		for (const asset of doc.media) {
			const clips = asset.clips
			const describedCount = clips.filter((c) => !!c.visual).length
			const transcribed = clips.some((c) => !!c.text && c.text !== SILENCE_TEXT)
			const range = clips.length ? ` #${clips[0].index}..#${clips[clips.length - 1].index}` : ''
			const recorded = recordedWindow(asset)
			if (recorded) anyRecordedAt = true
			// Coverage, not a yes/no: a partial describe run left most pieces
			// blank, and "yes" would have the model read those blanks as
			// "nothing on screen here" rather than "not looked at".
			const described = describedCount === 0
				? 'no'
				: describedCount >= clips.length ? 'yes' : `${describedCount}/${clips.length}`
			lines.push(`- Asset ${asset.id} "${asset.name}" ${asset.kind} ${fmt(asset.metadata?.duration || 0)}s — ${clips.length} pieces${range}, transcript: ${transcribed ? 'yes' : 'no'}, descriptions: ${described}${recorded ? `, recorded ${recorded}` : ''}`)
		}
		if (anyRecordedAt) {
			lines.push('(Assets are listed in IMPORT order, which is not necessarily the order they were')
			lines.push(' filmed. Use the "recorded" window above to place material chronologically. Two')
			lines.push(' assets whose recorded windows OVERLAP were filmed at the same time — they are')
			lines.push(' parallel camera angles of one moment, not consecutive material, so do not play')
			lines.push(' both end to end.)')
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
					.slice(0, OUTLINE_GIST_COUNT)
					.map((i) => coverageOf(i, 120, false).content)
					.filter(Boolean)
					.map((v) => `"${v}"`)
					.join(' / ')
				lines.push(`- Chapter "${b.label}" [${fmt(b.t0)}–${fmt(b.t1)}s]: ${items.length} items, ${fmt(dur)}s${gists ? `; gist: ${gists}` : ''}`)
			}
			lines.push('')
		}

		// ---- ITEMS IN SCOPE ----
		const header = scope.kind === 'full' ? 'CURRENT TIMELINE' : `ITEMS IN SCOPE (${inScopeItems.length})`
		lines.push(header)
		if (inScopeItems.length === 0) {
			lines.push('(empty — build a new cut from the available pieces)')
		}
		for (const item of inScopeItems) {
			const track = doc.tracks.find((t) => t.id === item.trackId)
			const showContent = !r.dropNeighborVisuals || selectedSet.has(item.id) || scope.kind !== 'selection'
			const { span, content } = coverageOf(item, showContent ? ITEM_SUMMARY_MAX_CHARS : 0, false)
			lines.push(
				`- ${item.id} | ${track?.name || '?'} | at ${fmt(item.timelineStart)}s | src ${fmt(item.in)}–${fmt(item.out)}s${span ? ` (${span})` : ''} | ${item.speed}x | "${item.label || ''}"${content ? ` | ${content}` : ''}`
			)
		}
		lines.push('')

		// ---- AVAILABLE SCENES ----
		lines.push('AVAILABLE SCENES (add material from here via addSceneRanges / addClips)')
		lines.push('Pipe table, one row per piece: idx|startSec|durSec|content')
		lines.push('(idx is the piece number used by addSceneRanges and addClips.sceneIndex. Times are')
		lines.push(" seconds into the SOURCE — informational only, cuts always use the piece's exact")
		lines.push(' bounds. content is the transcript line when available, else the scene description.')
		lines.push(` "${SILENCE_TEXT}" marks a gap with no speech.${r.contentCap <= 0 ? ' This project is long, so only silence markers are shown — judge the rest by duration and position.' : ''})`)
		for (const asset of scopeAssets) {
			if (r.dropUnusedAssetScenes && !usedAssetIds.has(asset.id)) {
				lines.push(`Asset ${asset.id} "${asset.name}": ${asset.clips.length} pieces omitted for brevity`)
				continue
			}
			const clips = asset.clips
			lines.push(`Asset ${asset.id} "${asset.name}" (${fmt(asset.metadata?.duration || 0)}s, ${clips.length} pieces):`)
			if (clips.length <= r.scenesCap) {
				for (let i = 0; i < clips.length; i++) {
					const clip = clips[i]
					// Collapse a transcription loop into one honest row.
					let runEnd = i
					const key = (clip.text || '').trim()
					if (key && key !== SILENCE_TEXT) {
						while (runEnd + 1 < clips.length && (clips[runEnd + 1].text || '').trim() === key) runEnd++
					}
					const runLength = runEnd - i + 1
					if (runLength >= REPEAT_RUN_MIN) {
						const last = clips[runEnd]
						const span = fmt1(last.out - clip.in)
						lines.push(
							`${clip.index}-${last.index}|${fmt1(clip.in)}|${span}|` +
							`!! ${runLength} consecutive pieces carry the SAME transcript line — speech-to-text looped here, ` +
							`so the text is unreliable, but the footage and timings are real. ` +
							`Judge this span by duration and position, do not drop it just because the text repeats. Line was: "${cell(clip.text, 60)}"`
						)
						i = runEnd
						continue
					}
					lines.push(`${clip.index}|${fmt1(clip.in)}|${fmt1(clip.duration)}|${contentOf(clip, r.contentCap, r.bothFields)}`)
				}
			} else {
				// Always include pieces already used by in-scope items, then sample evenly
				const usedSceneIds = new Set(inScopeItems.filter((i) => i.sourceAssetId === asset.id).map((i) => i.sourceClipId))
				const used = clips.filter((c) => usedSceneIds.has(c.id))
				const rest = clips.filter((c) => !usedSceneIds.has(c.id))
				const sampleBudget = Math.max(r.scenesCap - used.length, 4)
				const step = Math.max(1, Math.floor(rest.length / sampleBudget))
				const sampled = rest.filter((_, i) => i % step === 0).slice(0, sampleBudget)
				const shown = [...used, ...sampled].sort((a, b) => a.index - b.index)
				for (const clip of shown) {
					lines.push(`${clip.index}|${fmt1(clip.in)}|${fmt1(clip.duration)}|${contentOf(clip, r.contentCap, r.bothFields)}`)
				}
				lines.push(`- … +${clips.length - shown.length} more pieces between ${fmt(clips[0].in)}s and ${fmt(clips[clips.length - 1].out)}s (evenly sampled above; addSceneRanges endpoints may still name ANY piece # from ${clips[0].index} to ${clips[clips.length - 1].index})`)
			}
		}
		lines.push('')

		// ---- USER REQUEST ----
		lines.push('USER REQUEST')
		lines.push(prompt)

		return lines.join('\n')
	}

	// Degradation ladder until we fit the budget
	let text = build(ladder[0])
	for (let i = 1; i < ladder.length && text.length > budget; i++) {
		text = build(ladder[i])
	}
	if (text.length > budget) {
		// Final resort: hard-truncate — but never the ITEMS IN SCOPE section.
		// AVAILABLE SCENES comes after ITEMS, so cutting the tail (before USER
		// REQUEST) only loses piece listings.
		const requestBlock = `\nUSER REQUEST\n${prompt}`
		text = text.slice(0, budget - requestBlock.length - 64) +
			'\n[... piece listings truncated — long project ...]\n' + requestBlock
		truncated = true
	}

	return {
		contextText: text,
		scope,
		// NOTE: length/4 UNDERESTIMATES a numeric table by ~25-30% (digits tokenize
		// poorly). The char budget above is the real control; this is a display hint.
		tokenEstimate: Math.round(text.length / 4),
		truncated,
		thinContext
	}
}
