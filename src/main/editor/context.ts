import type { Clip, EditorDocument, TimelineItem } from '@shared/types'
import { computeScope, type AiScope } from '@shared/ai-scope'
import { itemDuration } from '@shared/timeline'

/**
 * Builds the prompt context text for the editor AI (PRD §5.7).
 * Applies the degradation ladder so a multi-hour project always fits the
 * budget — ending, if it must, in an EXPLICIT truncation flag (never silent).
 *
 * On top of the ladder sits source-size BANDING (see the constants below):
 * small sources show every piece as its own row; large ones get a condensed
 * survey plus a model-requested detail pass. The single condensed pass is
 * expected to handle cleanups, questions and item edits on its own — the
 * detail pass exists solely for piece-precision short cuts, which is how
 * intent stays out of the sizing logic while the model, not the ladder,
 * buys detail when it needs it.
 */

export const VISUAL_MAX_CHARS = 160
export const TEXT_MAX_CHARS = 120
export const BOTH_FIELDS_MAX_CLIPS = 400    // emit text AND visual only for small assets
export const SECONDARY_MAX_CHARS = 60
export const ITEM_SUMMARY_MAX_CHARS = 200   // per-item coverage summary (merged range items)
/**
 * ~130k tokens = 13% of a 1M window. This is a CEILING, not a floor: a short
 * project produces a short context either way, so the only case it changes is
 * long source + short intended output — and there the old 120k summarize budget
 * was actively harmful, see buildLadder.
 */
export const CONTEXT_CHAR_BUDGET = 420_000
export const OUTLINE_GIST_COUNT = 2

/**
 * ==== Source-size banding ====
 *
 * The 14-minute build-from-scratch failure on the 92-minute project was a
 * REASONING blowup, not a window overflow: 1289 transcript rows fit the char
 * budget easily (~75k chars), but "pick the best 2 minutes" makes the model
 * weigh every row, and thinking burns proportionally to candidate count.
 * So the control here is ROWS, bounded by SOURCE SIZE — never by what the
 * request asks for (sizing by intent is the bug that was already removed:
 * the context must be identical whatever the user wants, piece numbers must
 * stay nameable everywhere).
 *
 * At or below DETAIL_MAX_PIECES in-scope pieces, everything is exactly as
 * before — same rows, same ladder, byte-identical. Above it, the scenes table
 * becomes a condensed SURVEY (silence runs collapsed, speech grouped with
 * head/tail gists), and the model may answer with `expandRegions` instead of
 * ops — naming the spans it needs to read per piece. The second call then
 * shows full rows inside those spans (capped at the same DETAIL_MAX_PIECES)
 * and survey rows elsewhere. The model decides whether it needs detail; only
 * source size decides whether it is offered the choice.
 */

/**
 * At or below this many in-scope pieces the model sees every piece in full —
 * the pre-banding behavior, byte for byte. ~43 min of source at the observed
 * ~4.3s/piece. The verified failure is 1289 rows; the verified-workable scale
 * this returns to is a few hundred. The SAME constant caps the detail pass:
 * an expansion never shows more full rows than a small project would.
 */
export const DETAIL_MAX_PIECES = 600
/** Aim the survey at about this many group rows, independent of source size. */
export const SURVEY_TARGET_GROUPS = 240
/**
 * A group never covers more than this much source time: past it a row is
 * useless for placing a cut even when its piece count is still low.
 */
export const SURVEY_GROUP_MAX_SPAN_SEC = 120
/** Group size clamp — groups this small defeat the condensation... */
export const SURVEY_GROUP_MIN_PIECES = 4
/** ...and groups this large hide too much behind one gist. */
export const SURVEY_GROUP_MAX_PIECES = 30
/**
 * Silence does NOT terminate a group — real footage is ~28% silence pieces
 * (mostly isolated single ones), and one-row-per-silence would blow the row
 * count right back up. Isolated silences ride inside their group, enumerated
 * as #idx(secs) so excludeScenes can still name them. Only a run of at least
 * this many consecutive silent pieces earns its own [Silence xN] row (a run
 * that long is a topic boundary anyway).
 */
export const SILENCE_RUN_ROW_MIN = 3
export const SURVEY_GIST_HEAD_CHARS = 60
export const SURVEY_GIST_LONGEST_CHARS = 60
/** The model may request at most this many spans to read in detail. */
export const EXPAND_MAX_REGIONS = 8
/** Requested spans are widened by this many pieces each side — gist boundaries are fuzzy. */
export const REGION_PAD_PIECES = 4

/** A span of pieces the model asked to read in full (pass 2 of a survey-band turn). */
export interface ExpandRegion {
	assetId: string
	fromPiece: number
	toPiece: number
	reason?: string
}

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
	/** 'full' = every piece as its own row (pre-banding behavior); 'survey' = condensed. */
	band: 'full' | 'survey'
	/** The metric the band was chosen by: in-scope pieces. */
	pieceCount: number
	/** Pass 2 only: how many pieces the sanitized expansion actually shows in full. */
	expandedPieces?: number
	/** Pass 2 only: how many spans survived sanitation. */
	expandedRegions?: number
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

/**
 * One ladder, shrinking CONTENT first and scene numbers last.
 *
 * There used to be a second, summarize-only ladder that dropped straight to 12
 * scenes per asset. That could not survive the removal of modes, and should not
 * have existed anyway: `addClips.sceneIndex` and `excludeScenes` must name real
 * numbers from the AVAILABLE SCENES table, so capping a 92-minute lecture at
 * twelve addressable moments makes a good short cut impossible — you cannot pick
 * the best 30 seconds out of footage you cannot name.
 */
function buildLadder(): Rung[] {
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

interface SanitizedExpansion {
	/** Merged, clamped piece-index intervals per asset. */
	intervals: Map<string, { from: number; to: number }[]>
	/** What the model asked for, post-sanitation, in its priority order (for the preamble). */
	listed: { assetName: string; from: number; to: number; reason?: string }[]
	expandedPieces: number
	/** Never-silent: everything sanitation changed or refused, spelled out for the model. */
	notes: string[]
}

/**
 * Clamp, pad, merge and budget the spans the model asked to read in detail.
 * Same philosophy as addSceneRanges endpoints: CLAMP rather than drop, so an
 * over-eager span means what it obviously meant. Regions are honored in the
 * model's order until DETAIL_MAX_PIECES is spent; whatever falls off is
 * reported in `notes`, never silently.
 */
function sanitizeExpandRegions(
	regions: ExpandRegion[],
	scopeAssets: { id: string; name: string; clips: Clip[] }[]
): SanitizedExpansion {
	const intervals = new Map<string, { from: number; to: number }[]>()
	const listed: SanitizedExpansion['listed'] = []
	const notes: string[] = []
	let budget = DETAIL_MAX_PIECES

	if (regions.length > EXPAND_MAX_REGIONS) {
		notes.push(`Only the first ${EXPAND_MAX_REGIONS} of ${regions.length} requested spans were expanded.`)
	}
	const considered = regions.slice(0, EXPAND_MAX_REGIONS)
	for (let n = 0; n < considered.length; n++) {
		if (budget === 0) {
			const rest = considered.length - n
			// Followable in THIS call — pass 2 cannot ask again, so the guidance
			// must point at what the table still offers, not at a re-request.
			notes.push(`${rest} later span${rest === 1 ? '' : 's'} not expanded — the ${DETAIL_MAX_PIECES}-piece detail budget is spent. Those spans stay condensed below; judge them from their survey rows.`)
			break
		}
		const region = considered[n]
		const asset = scopeAssets.find((a) => a.id === region.assetId)
		if (!asset || !asset.clips.length) {
			notes.push(`Requested span in unknown asset ${region.assetId} was ignored.`)
			continue
		}
		// Same guard opsToDiff's range handler uses: the schema declares integers,
		// but nothing enforces that at runtime, and NaN would sail through every
		// clamp below into a "#NaN–#NaN" DETAIL VIEW entry with zero rows.
		if (!Number.isFinite(region.fromPiece) || !Number.isFinite(region.toPiece)) {
			notes.push(`Requested span in "${asset.name}" with non-numeric bounds was ignored.`)
			continue
		}
		const minIdx = asset.clips[0].index
		const maxIdx = asset.clips[asset.clips.length - 1].index
		let from = Math.round(Math.min(region.fromPiece, region.toPiece))
		let to = Math.round(Math.max(region.fromPiece, region.toPiece))
		from = Math.max(minIdx, Math.min(maxIdx, from - REGION_PAD_PIECES))
		to = Math.max(minIdx, Math.min(maxIdx, to + REGION_PAD_PIECES))

		const existing = intervals.get(asset.id) || []
		// Spend budget only on pieces no earlier (higher-priority) span covers.
		const covered = (idx: number) => existing.some((s) => idx >= s.from && idx <= s.to)
		let fresh = 0
		for (let idx = from; idx <= to; idx++) if (!covered(idx)) fresh++
		if (fresh > budget) {
			// Trim the tail so the total stays inside the budget.
			let kept = 0
			let cut = from - 1
			for (let idx = from; idx <= to; idx++) {
				if (kept === budget && !covered(idx)) break
				if (!covered(idx)) kept++
				cut = idx
			}
			notes.push(`Span #${from}–#${to} of "${asset.name}" was cut at #${cut}: the ${DETAIL_MAX_PIECES}-piece detail budget ran out. The remainder stays condensed below; judge it from the survey rows, and addSceneRanges endpoints may still name any piece # inside it.`)
			to = cut
			fresh = kept
			if (to < from) continue
		}
		budget -= fresh
		existing.push({ from, to })
		intervals.set(asset.id, existing)
		listed.push({ assetName: asset.name, from, to, reason: region.reason })
	}
	// Merge overlaps per asset for emission.
	let expandedPieces = 0
	for (const [assetId, spans] of intervals) {
		spans.sort((a, b) => a.from - b.from)
		const merged: { from: number; to: number }[] = []
		for (const span of spans) {
			const last = merged[merged.length - 1]
			if (last && span.from <= last.to + 1) last.to = Math.max(last.to, span.to)
			else merged.push({ ...span })
		}
		intervals.set(assetId, merged)
		const asset = scopeAssets.find((a) => a.id === assetId)!
		for (const span of merged) {
			expandedPieces += asset.clips.filter((c) => c.index >= span.from && c.index <= span.to).length
		}
	}
	return { intervals, listed, expandedPieces, notes }
}

export function buildPromptContext(
	doc: EditorDocument,
	prompt: string,
	opts: {
		selectedItemIds: string[]
		playheadSec: number
		widen?: 'chapter' | 'full'
		/** Pass 2 of a survey-band turn: spans the model asked to read in full. */
		expandRegions?: ExpandRegion[]
	}
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

	// ---- Source-size band ----
	// Rows are the reasoning cost, so the band is chosen by IN-SCOPE PIECES and
	// nothing else — the prompt string never enters this computation.
	const pieceCount = scopeAssets.reduce((sum, a) => sum + a.clips.length, 0)
	const band: 'full' | 'survey' = pieceCount <= DETAIL_MAX_PIECES ? 'full' : 'survey'
	const expansion = band === 'survey' && opts.expandRegions?.length
		? sanitizeExpandRegions(opts.expandRegions, scopeAssets)
		: undefined
	const groupSize = Math.min(
		SURVEY_GROUP_MAX_PIECES,
		Math.max(SURVEY_GROUP_MIN_PIECES, Math.ceil(pieceCount / SURVEY_TARGET_GROUPS))
	)

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
		// Transcript first, description second. deriveClipsFromTranscript is the
		// DEFAULT clip producer while `visual` needs the opt-in descriptions step,
		// so visual-primary would leave blank cells on the common path. Nothing is
		// lost for b-roll: the `primary || secondary` fallback below still shows
		// descriptions when there is no transcript.
		const primary = clip.text
		const secondary = clip.visual
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

	const ladder = buildLadder()
	const budget = CONTEXT_CHAR_BUDGET
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
		const isSilence = (c: Clip) => c.text === SILENCE_TEXT && !c.visual

		/** How far a transcription loop extends from position i (never past `to`). */
		const repeatRunEnd = (clips: Clip[], i: number, to: number): number => {
			const key = (clips[i].text || '').trim()
			if (!key || key === SILENCE_TEXT) return i
			let runEnd = i
			while (runEnd + 1 <= to && (clips[runEnd + 1].text || '').trim() === key) runEnd++
			return runEnd
		}

		/** Per-piece rows for clips[from..to], with the transcription-loop collapse. */
		const emitPieceRows = (clips: Clip[], from: number, to: number) => {
			for (let i = from; i <= to; i++) {
				const clip = clips[i]
				// Collapse a transcription loop into one honest row.
				const runEnd = repeatRunEnd(clips, i, to)
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
		}

		/** One survey row for a group of consecutive pieces (silences ride inside). */
		const groupRow = (group: Clip[]): string => {
			const first = group[0]
			const last = group[group.length - 1]
			if (group.length === 1) {
				return `${first.index}|${fmt1(first.in)}|${fmt1(first.duration)}|${contentOf(first, r.contentCap, false)}`
			}
			const speech = group.filter((c) => !isSilence(c))
			const head = speech.length
				? cell(speech[0].text || speech[0].visual, Math.min(SURVEY_GIST_HEAD_CHARS, r.contentCap))
				: ''
			let longestClip: Clip | null = null
			for (const c of speech.slice(1)) {
				if (!longestClip || (c.text || c.visual || '').length > (longestClip.text || longestClip.visual || '').length) {
					longestClip = c
				}
			}
			const longest = longestClip
				? cell(longestClip.text || longestClip.visual, Math.min(SURVEY_GIST_LONGEST_CHARS, r.contentCap))
				: ''
			// Silence stays decision-relevant at every rung, exactly like [Silence].
			const sil = group.filter(isSilence).map((c) => `#${c.index}(${fmt1(c.duration)}s)`).join(' ')
			let content = `${group.length}p:`
			if (head) content += ` ${head}`
			if (longest && longest !== head) content += ` ~ ${longest}`
			if (sil) content += ` [sil ${sil}]`
			return `${first.index}-${last.index}|${fmt1(first.in)}|${fmt1(last.out - first.in)}|${content}`
		}

		/** The condensed emitter: silence runs, loop rows, expanded spans, groups. */
		const emitSurveyRows = (asset: { id: string; clips: Clip[] }) => {
			const clips = asset.clips
			const spans = expansion?.intervals.get(asset.id)
			const expanded = (idx: number) => !!spans?.some((s) => idx >= s.from && idx <= s.to)
			let group: Clip[] = []
			const flush = () => {
				if (group.length) lines.push(groupRow(group))
				group = []
			}
			for (let i = 0; i < clips.length; i++) {
				const clip = clips[i]
				// A span the model asked to read: full per-piece rows.
				if (expanded(clip.index)) {
					flush()
					let j = i
					while (j + 1 < clips.length && expanded(clips[j + 1].index)) j++
					emitPieceRows(clips, i, j)
					i = j
					continue
				}
				// A transcription loop keeps its honest row at every band.
				const stop = ((): number => {
					let k = i
					while (k + 1 < clips.length && !expanded(clips[k + 1].index)) k++
					return k
				})()
				const runEnd = repeatRunEnd(clips, i, stop)
				if (runEnd - i + 1 >= REPEAT_RUN_MIN) {
					flush()
					emitPieceRows(clips, i, runEnd)
					i = runEnd
					continue
				}
				// A long silence run is a topic boundary: its own row.
				if (isSilence(clip)) {
					let j = i
					while (j + 1 <= stop && isSilence(clips[j + 1])) j++
					if (j - i + 1 >= SILENCE_RUN_ROW_MIN) {
						flush()
						const last = clips[j]
						lines.push(`${clip.index}-${last.index}|${fmt1(clip.in)}|${fmt1(last.out - clip.in)}|[Silence x${j - i + 1}]`)
						i = j
						continue
					}
				}
				// Everything else — speech and isolated silences — rides in a group.
				group.push(clip)
				const span = clip.out - group[0].in
				if (group.length >= groupSize || span >= SURVEY_GROUP_MAX_SPAN_SEC) flush()
			}
			flush()
		}

		lines.push('AVAILABLE SCENES (add material from here via addSceneRanges / addClips)')
		if (band === 'survey') {
			lines.push('CONDENSED SURVEY — pipe table, one row per GROUP of consecutive pieces:')
			lines.push('a-b|startSec|durSec|Np: first line ~ longest line [sil #idx(secs) ...]')
			lines.push('(a-b and every integer between them are REAL piece numbers for addSceneRanges,')
			lines.push(' addClips.sceneIndex and excludeScenes. Np = pieces in the group. The gist shows')
			lines.push(' the group\'s first and most substantial transcript lines — NOT everything said.')
			lines.push(' Silent pieces are enumerated in the [sil ...] tail with their seconds;')
			lines.push(` a row "a-b|...|[Silence xN]" is a run of N consecutive silent pieces. Times are`)
			lines.push(" seconds into the SOURCE — informational only, cuts always use each piece's exact bounds.)")
			if (expansion) {
				lines.push('DETAIL VIEW — you asked to read these spans; below they appear one row per piece')
				lines.push('(idx|startSec|durSec|content), everything else stays condensed:')
				for (const region of expansion.listed) {
					lines.push(`- "${region.assetName}" #${region.from}–#${region.to}${region.reason ? ` — ${cell(region.reason, 80)}` : ''}`)
				}
				for (const note of expansion.notes) lines.push(`- NOTE: ${note}`)
			}
		} else {
			lines.push('Pipe table, one row per piece: idx|startSec|durSec|content')
			lines.push('(idx is the piece number used by addSceneRanges and addClips.sceneIndex. Times are')
			lines.push(" seconds into the SOURCE — informational only, cuts always use the piece's exact")
			lines.push(' bounds. content is the transcript line when available, else the scene description.')
			lines.push(` "${SILENCE_TEXT}" marks a gap with no speech.${r.contentCap <= 0 ? ' This project is long, so only silence markers are shown — judge the rest by duration and position.' : ''})`)
		}
		for (const asset of scopeAssets) {
			if (r.dropUnusedAssetScenes && !usedAssetIds.has(asset.id)) {
				lines.push(`Asset ${asset.id} "${asset.name}": ${asset.clips.length} pieces omitted for brevity`)
				continue
			}
			const clips = asset.clips
			lines.push(`Asset ${asset.id} "${asset.name}" (${fmt(asset.metadata?.duration || 0)}s, ${clips.length} pieces):`)
			if (band === 'survey') {
				emitSurveyRows(asset)
			} else if (clips.length <= r.scenesCap) {
				emitPieceRows(clips, 0, clips.length - 1)
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
		thinContext,
		band,
		pieceCount,
		expandedPieces: expansion?.expandedPieces,
		expandedRegions: expansion ? expansion.listed.length : undefined
	}
}
