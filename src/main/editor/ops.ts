import { v4 as uuidv4 } from 'uuid'
import type { Clip, EditorDocument, EditorOps, EditorPersona, TimelineDiff, TimelineItem } from '@shared/types'
import {
	clampSpeed, closeTimelineGaps, computeContentEnd, itemDuration, itemEnd,
	rippleAfterRemoval, TIMELINE_DIFF_SCHEMA_VERSION
} from '@shared/timeline'

/**
 * The editor's AI contract: the ops schema the model fills in, the system
 * instruction that explains it, and the pure mapping from ops to a TimelineDiff.
 *
 * Deliberately free of Electron/Node imports so it can be unit-tested — the
 * turn lifecycle that calls it lives in prompt.ts.
 */

// ===== Ops schema (constrained on purpose — see EditorOps in shared/types) =====
export const EDITOR_OPS_SCHEMA = {
	type: 'object',
	properties: {
		answer: {
			type: 'string',
			description: 'Only when the request is a question — answer it and propose no operations'
		},
		rationale: {
			type: 'string',
			description: 'Plain-language explanation of the proposed edit, citing what is in the pieces'
		},
		removeItemIds: { type: 'array', items: { type: 'string' } },
		closeGaps: {
			type: 'boolean',
			description: 'Pull every clip left so each track runs back to back with no gaps. Use when the user reports a gap or empty space in the timeline.'
		},
		updateItems: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					timelineStart: { type: 'number' },
					in: { type: 'number' },
					out: { type: 'number' },
					speed: { type: 'number' },
					label: { type: 'string' },
					gain: { type: 'number' },
					fadeInSec: { type: 'number' },
					fadeOutSec: { type: 'number' }
				},
				required: ['id']
			}
		},
		addSceneRanges: {
			type: 'array',
			description: 'Bulk-add whole spans of pieces. This is how you build a full-length cut.',
			items: {
				type: 'object',
				properties: {
					assetId: { type: 'string' },
					fromScene: { type: 'integer', description: 'First piece # to include (inclusive)' },
					toScene: { type: 'integer', description: 'Last piece # to include (inclusive)' },
					excludeScenes: {
						type: 'array',
						items: { type: 'integer' },
						description: 'Piece #s inside the span to SKIP (dead air, false starts, retakes)'
					},
					speed: { type: 'number', description: 'Playback rate 0.25-4.0 for the whole span (default 1)' },
					merge: { type: 'boolean', description: 'Default true: adjacent kept pieces become one clip' },
					atSec: { type: 'number' },
					afterItemId: { type: 'string' },
					label: { type: 'string' }
				},
				required: ['assetId', 'fromScene', 'toScene']
			}
		},
		addClips: {
			type: 'array',
			description: 'Add a few individual pieces. For long spans use addSceneRanges instead.',
			items: {
				type: 'object',
				properties: {
					assetId: { type: 'string' },
					sceneIndex: { type: 'integer', description: "A piece # from that asset's AVAILABLE SCENES table" },
					in: { type: 'number' },
					out: { type: 'number' },
					atSec: { type: 'number' },
					afterItemId: { type: 'string' },
					label: { type: 'string' }
				},
				required: ['assetId']
			}
		},
		addMarkers: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					atSec: { type: 'number', description: 'Timeline seconds. Use for material already on the timeline.' },
					atScene: {
						type: 'object',
						description: 'Anchor to a source piece instead — resolved to timeline time after your clips are placed. Use this when you are ADDING the material in this same response.',
						properties: {
							assetId: { type: 'string' },
							sceneIndex: { type: 'integer' }
						},
						required: ['assetId', 'sceneIndex']
					},
					label: { type: 'string' }
				},
				required: ['label']
			}
		}
	}
}

// ===== System instruction composition =====

/** Project facts the contract quotes back at the model so it knows what "full length" means. */
export interface PromptStats {
	timelineItemCount: number
	timelineDurationSec: number
	sourceDurationSec: number   // 0 when unknown
	sourceClipCount: number
	mode: 'longform' | 'summarize'
}

const clock = (seconds: number): string => {
	const total = Math.max(0, Math.round(seconds))
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function durationLines(stats: PromptStats, persona: EditorPersona): string[] {
	const target = persona.defaults?.targetDurationSec
	const haveSource = stats.sourceDurationSec > 0

	// Summarize: keep the original line byte-identical, add source context only.
	if (target != null) {
		const lines = [`Target output duration: about ${target} seconds. Cut toward this target.`]
		if (haveSource) {
			lines.push(`Source available: ${clock(stats.sourceDurationSec)} across ${stats.sourceClipCount} pieces — select from it; you are not expected to cover all of it.`)
		}
		return lines
	}

	// Longform, empty timeline: there is no runtime to "preserve" — it must be BUILT.
	if (stats.timelineItemCount === 0) {
		if (!haveSource) {
			return [
				'No length target. The timeline is EMPTY, so BUILD a full-length cut that covers the',
				'available source material end to end in chronological order, removing only dead air,',
				'silence, false starts and duplicated takes. Do not produce a highlights selection.'
			]
		}
		return [
			`No length target. The timeline is EMPTY, so your job is to BUILD THE FULL-LENGTH cut from`,
			`the source: about ${clock(stats.sourceDurationSec)} of footage across ${stats.sourceClipCount} detected pieces.`,
			'- Cover the source end to end in chronological order. The result should be roughly as long',
			'  as the source, minus only what you deliberately remove.',
			'- Removing dead air, silence, false starts and duplicated takes should take out a MINORITY',
			`  of the runtime — typically 5-20%. If your cut comes to less than 70% of ${clock(stats.sourceDurationSec)}, you have`,
			'  cut too much: go back and include the material you skipped.',
			'- Build it with `addSceneRanges` over whole spans of piece numbers, using `excludeScenes`',
			'  for the pieces you are dropping. Do NOT list kept pieces one by one — you will run out of',
			'  response length long before the end of the footage.'
		]
	}

	// Longform, existing cut: preserve what is there.
	const lines = [
		`No length target — PRESERVE the full runtime of the current cut (${stats.timelineItemCount} items, ${clock(stats.timelineDurationSec)}).`,
		'Make editorial improvements (remove dead air, tighten with retime, reorder, chapter) without',
		'shrinking the substantive content. Edit the items that are already there; do not rebuild the',
		'timeline from scratch.'
	]
	if (haveSource && stats.timelineDurationSec < 0.7 * stats.sourceDurationSec) {
		lines.push(
			`The current cut (${clock(stats.timelineDurationSec)}) is far shorter than the source available to you`,
			`(${clock(stats.sourceDurationSec)}). If the user asks you to extend, lengthen, continue or complete it,`,
			'APPEND the missing material with `addSceneRanges` — do not re-cut what is already there.'
		)
	}
	return lines
}

export function composeSystemInstruction(persona: EditorPersona, stats: PromptStats): string {
	const defaults = persona.defaults || {}

	return [
		persona.systemPrompt,
		'',
		'=== EDITOR CONTRACT (always applies) ===',
		'You are proposing an edit to a video timeline in a non-linear editor. You receive the',
		"current timeline items (each with a stable id), the project's media assets with their",
		'detected pieces, and a user request.',
		'- If the request is a QUESTION about the project, put the answer in `answer` and',
		'  propose no operations.',
		'- Otherwise propose ONE coherent edit:',
		'  - Reference existing timeline items ONLY by their exact `id` from the items list.',
		'  - Add new material with `addSceneRanges` (bulk, preferred) or `addClips` (a few',
		'    individual pieces). `addClips` entries are placed BEFORE `addSceneRanges` entries;',
		'    to build one ordered assembly put EVERYTHING in `addSceneRanges` and use',
		'    fromScene === toScene for a single piece.',
		'  - `addSceneRanges` adds every piece from `fromScene` to `toScene` of one asset minus',
		'    `excludeScenes`, and merges adjacent kept pieces into as few clips as possible. ONE',
		'    range can add thousands of pieces — this is how you build a full-length cut without',
		'    listing every piece.',
		'  - Ranges never duplicate footage: any part of a piece already on the timeline is trimmed',
		'    out automatically, so it is safe to give a generous span when continuing a cut. To',
		'    deliberately repeat a moment, use `addClips`.',
		'  - Piece numbers: `addClips.sceneIndex` must be a real # from the AVAILABLE SCENES table.',
		'    `addSceneRanges` endpoints are the ONE exception — fromScene / toScene are CLAMPED to',
		"    the asset's real range, so \"fromScene: 1, toScene: 99999\" safely means \"to the end\".",
		'    `excludeScenes` entries outside the span are ignored. Never invent item ids, asset ids,',
		'    or `addClips` piece numbers.',
		'  - Placement: omit `atSec` and clips append in order with no gaps. Set `atSec` only for a',
		'    deliberate absolute position — a large `atSec` pushes every later append after it.',
		'    `afterItemId` may name only an item that ALREADY exists on the timeline, never one you',
		'    are adding in this same response.',
		'  - `updateItems` may change timelineStart, in, out, speed (0.25-4.0), label,',
		'    gain (0-2, audio mix level), and fadeInSec / fadeOutSec (audio fade lengths, seconds).',
		'    Never set durations — they are derived from (out - in) / speed.',
		'  - Only modify items listed in the items section.',
		'  - Gaps: removing items ALREADY pulls the rest left, so you never need to rewrite',
		'    timelineStart to close the hole a removal leaves. If the user reports a gap or',
		'    empty space that is already on the timeline, set `closeGaps: true` — do not try',
		'    to fix it by editing timelineStart one item at a time.',
		'  - Chapter markers: use `atScene` when the material is being added in this response',
		'    (you cannot know its timeline time yet), `atSec` when it is already on the timeline.',
		'  - Order material by the `recorded` window in the asset list when one is shown, not by',
		'    the order the assets happen to be listed in. Fall back to filenames only when no',
		'    recorded window is given.',
		'- Always include a short `rationale` describing what you changed and why, citing what is',
		'  actually in the pieces.',
		'',
		'=== ACTIVE PERSONA DEFAULTS ===',
		`Tone: ${persona.tone || 'neutral'}. Pacing: ${defaults.pacing || 'balanced'}.`,
		...durationLines(stats, persona),
		defaults.aspectRatio ? `Target aspect ratio: ${defaults.aspectRatio}.` : ''
	].filter(Boolean).join('\n')
}

// ===== Ops -> TimelineDiff mapping =====

/**
 * Coalescing tolerances. The DEFAULT clip producer is the transcript
 * (deriveClipsFromTranscript), which only gap-fills gaps larger than
 * MIN_GAP_SEC = 0.5s and can emit slightly overlapping pieces, so the
 * detected-scene epsilon (CLIP_ADJACENCY_EPSILON = 0.1) is far too tight here.
 */
export const MERGE_GAP_TOL_SEC = 0.75
export const MERGE_OVERLAP_TOL_SEC = 0.25
/** Close a merged run past this much source so single items stay reviewable. */
export const MAX_MERGED_SOURCE_SEC = 300
/** Above this many expanded items, tell the user — but never drop content. */
export const EXPANSION_ADVISORY = 400
/** Runaway backstop. */
export const MAX_EXPANDED_ITEMS = 2000
export const MARKER_DEDUPE_SEC = 0.25

/** A trimmed piece is discarded below this, to avoid frame-sized slivers. */
export const MIN_TRIMMED_PIECE_SEC = 0.15

interface Placement {
	assetId: string
	srcIn: number
	srcOut: number
	tStart: number
	speed: number
}

/**
 * Which source seconds of each asset are already spoken for — by the existing
 * timeline and by everything added earlier in this same response.
 *
 * This is what keeps an assembly free of duplicated footage. It matters twice:
 * a continuation turn that re-adds material it already placed, and assets whose
 * transcript timestamps overlap (a Whisper repetition loop can emit pieces that
 * overlap their predecessor by seconds), which would otherwise put the same
 * audio on the timeline back to back.
 */
class SourceCoverage {
	private byAsset = new Map<string, { in: number; out: number }[]>()

	add(assetId: string, inSec: number, outSec: number): void {
		if (!(outSec > inSec)) return
		const spans = this.byAsset.get(assetId) || []
		spans.push({ in: inSec, out: outSec })
		spans.sort((a, b) => a.in - b.in)
		const merged: { in: number; out: number }[] = []
		for (const span of spans) {
			const last = merged[merged.length - 1]
			if (last && span.in <= last.out) last.out = Math.max(last.out, span.out)
			else merged.push({ ...span })
		}
		this.byAsset.set(assetId, merged)
	}

	/** The longest still-uncovered slice of [inSec, outSec), or null. */
	uncovered(assetId: string, inSec: number, outSec: number): { in: number; out: number } | null {
		const spans = this.byAsset.get(assetId)
		if (!spans?.length) return outSec > inSec ? { in: inSec, out: outSec } : null
		let best: { in: number; out: number } | null = null
		let cursor = inSec
		for (const span of spans) {
			if (span.out <= cursor) continue
			if (span.in >= outSec) break
			if (span.in > cursor) {
				const gap = { in: cursor, out: Math.min(span.in, outSec) }
				if (!best || gap.out - gap.in > best.out - best.in) best = gap
			}
			cursor = Math.max(cursor, span.out)
			if (cursor >= outSec) break
		}
		if (cursor < outSec) {
			const tail = { in: cursor, out: outSec }
			if (!best || tail.out - tail.in > best.out - best.in) best = tail
		}
		return best && best.out - best.in >= MIN_TRIMMED_PIECE_SEC ? best : null
	}
}

interface Run {
	in: number
	out: number
	first: Clip
	firstIdx: number
	lastIdx: number
	count: number
}

export interface OpsToDiffResult {
	diff: TimelineDiff
	addMarkers: { time: number; label: string }[]
	droppedOps: string[]
	notes: string[]
}

const labelFrom = (clip: Clip): string =>
	(clip.visual || clip.text)?.replace(/\s+/g, ' ').trim().slice(0, 40) || `Piece #${clip.index}`

export function opsToDiff(ops: EditorOps, doc: EditorDocument): OpsToDiffResult {
	const droppedOps: string[] = []
	const notes: string[] = []
	const diff: TimelineDiff = { schemaVersion: TIMELINE_DIFF_SCHEMA_VERSION }
	const itemIds = new Set(doc.timeline.map((i) => i.id))

	// Removals
	if (ops.removeItemIds?.length) {
		const known = ops.removeItemIds.filter((id) => itemIds.has(id))
		for (const id of ops.removeItemIds) {
			if (!itemIds.has(id)) droppedOps.push(`remove: unknown item ${id}`)
		}
		if (known.length) diff.removeItemIds = known
	}

	// Updates (whitelist fields; validation happens in applyTimelineDiff)
	if (ops.updateItems?.length) {
		const updates: NonNullable<TimelineDiff['updateItems']> = []
		for (const update of ops.updateItems) {
			if (!itemIds.has(update.id)) {
				droppedOps.push(`update: unknown item ${update.id}`)
				continue
			}
			const clean: { id: string } & Partial<TimelineItem> = { id: update.id }
			if (typeof update.timelineStart === 'number') clean.timelineStart = update.timelineStart
			if (typeof update.in === 'number') clean.in = update.in
			if (typeof update.out === 'number') clean.out = update.out
			if (typeof update.speed === 'number') clean.speed = update.speed
			if (typeof update.label === 'string') clean.label = update.label
			// Audio adjustments — clamped again in applyTimelineDiff's normalize
			if (typeof update.gain === 'number') clean.gain = Math.max(0, Math.min(2, update.gain))
			if (typeof update.fadeInSec === 'number') clean.fadeInSec = Math.max(0, update.fadeInSec)
			if (typeof update.fadeOutSec === 'number') clean.fadeOutSec = Math.max(0, update.fadeOutSec)
			if (Object.keys(clean).length > 1) updates.push(clean)
		}
		if (updates.length) diff.updateItems = updates
	}

	// ===== Adds: one phase, one cursor, ids generated HERE and never by the model =====
	const adds: TimelineItem[] = []
	const placements: Placement[] = []
	// Source already on the timeline, minus anything this edit removes.
	const removed = new Set(diff.removeItemIds || [])
	const coverage = new SourceCoverage()
	for (const item of doc.timeline) {
		if (!removed.has(item.id)) coverage.add(item.sourceAssetId, item.in, item.out)
	}
	// Sequential placement cursor for adds without explicit position
	let appendCursor = computeContentEnd(doc.timeline)
	const targetTrack = [...doc.tracks]
		.sort((a, b) => a.order - b.order)
		.find((t) => t.kind === 'video' && !t.locked && !t.hidden)

	/** Explicit atSec > after a known item > append at end. */
	const positionFor = (add: { atSec?: number; afterItemId?: string }): number => {
		if (typeof add.atSec === 'number' && add.atSec >= 0) return add.atSec
		if (add.afterItemId && itemIds.has(add.afterItemId)) {
			return itemEnd(doc.timeline.find((i) => i.id === add.afterItemId)!)
		}
		return appendCursor
	}

	const pushItem = (item: TimelineItem) => {
		adds.push(item)
		coverage.add(item.sourceAssetId, item.in, item.out)
		placements.push({
			assetId: item.sourceAssetId,
			srcIn: item.in,
			srcOut: item.out,
			tStart: item.timelineStart,
			speed: item.speed || 1
		})
		// Keep the Math.max semantics: the cursor never moves backwards, so a stray
		// atSec pushes later appends after it rather than creating overlaps.
		appendCursor = Math.max(appendCursor, item.timelineStart + item.duration)
	}

	// --- addClips: individual pieces / explicit source ranges ---
	for (const add of ops.addClips || []) {
		const asset = doc.media.find((a) => a.id === add.assetId)
		if (!asset) {
			droppedOps.push(`add: unknown asset ${add.assetId}`)
			continue
		}
		if (!targetTrack) {
			droppedOps.push('add: no unlocked video track available')
			break
		}

		let sourceIn: number | undefined
		let sourceOut: number | undefined
		let sourceClipId: string | undefined
		let masterSegmentIndex: number | undefined
		let label = add.label

		if (typeof add.sceneIndex === 'number') {
			const clip = asset.clips.find((c) => c.index === add.sceneIndex)
			if (!clip) {
				droppedOps.push(`add: unknown piece #${add.sceneIndex} of ${asset.name}`)
				continue
			}
			sourceIn = clip.in
			sourceOut = clip.out
			sourceClipId = clip.id
			masterSegmentIndex = clip.masterSegmentIndex
			label = label || labelFrom(clip)
		} else if (typeof add.in === 'number' && typeof add.out === 'number') {
			const assetDuration = asset.metadata?.duration ?? Number.POSITIVE_INFINITY
			if (!(add.in >= 0 && add.out > add.in && add.out <= assetDuration + 0.01)) {
				droppedOps.push(`add: invalid range ${add.in}-${add.out} for ${asset.name}`)
				continue
			}
			sourceIn = add.in
			sourceOut = add.out
			label = label || asset.name
		} else {
			droppedOps.push(`add: neither sceneIndex nor in/out given for ${asset.name}`)
			continue
		}

		pushItem({
			id: uuidv4(),
			trackId: targetTrack.id,
			sourceAssetId: asset.id,
			sourceClipId,
			masterSegmentIndex,
			timelineStart: positionFor(add),
			in: sourceIn!,
			out: sourceOut!,
			speed: 1.0,
			preservePitch: true,
			duration: sourceOut! - sourceIn!,
			label
		})
	}

	// --- addSceneRanges: bulk spans, expanded into merged contiguous runs ---
	for (const range of ops.addSceneRanges || []) {
		const asset = doc.media.find((a) => a.id === range.assetId)
		if (!asset) {
			droppedOps.push(`range: unknown asset ${range.assetId}`)
			continue
		}
		if (!targetTrack) {
			droppedOps.push('range: no unlocked video track available')
			break
		}
		const clips = [...(asset.clips || [])].sort((a, b) => a.index - b.index)
		if (!clips.length) {
			droppedOps.push(`range: ${asset.name} has no detected pieces`)
			continue
		}

		let from = Math.round(range.fromScene)
		let to = Math.round(range.toScene)
		if (!Number.isFinite(from) || !Number.isFinite(to)) {
			droppedOps.push(`range: fromScene/toScene missing for ${asset.name}`)
			continue
		}
		if (from > to) [from, to] = [to, from]

		// CLAMP rather than drop: a dropped 1400-piece range would silently lose
		// most of the edit, while a clamped one is exactly what was meant.
		const minIdx = clips[0].index
		const maxIdx = clips[clips.length - 1].index
		const fromIdx = Math.max(minIdx, Math.min(maxIdx, from))
		const toIdx = Math.max(minIdx, Math.min(maxIdx, to))
		if (fromIdx !== from || toIdx !== to) {
			notes.push(`Range #${from}–#${to} of "${asset.name}" clamped to #${fromIdx}–#${toIdx}.`)
		}

		const excluded = new Set((range.excludeScenes || []).map((n) => Math.round(n)))
		// Filter by index VALUE, never by array slicing.
		const selected = clips.filter((c) => c.index >= fromIdx && c.index <= toIdx && !excluded.has(c.index))
		if (!selected.length) {
			droppedOps.push(`range: every piece in #${fromIdx}–#${toIdx} of ${asset.name} was excluded`)
			continue
		}

		// Trim every piece to the part of the source that is not already on the
		// timeline. Fully-covered pieces vanish; partially-covered ones shrink.
		// Done in index order so a piece also yields to its own predecessors.
		let alreadyCovered = 0
		const trimmed: { clip: Clip; in: number; out: number }[] = []
		for (const clip of selected) {
			const free = coverage.uncovered(asset.id, clip.in, clip.out)
			if (!free) {
				alreadyCovered++
				continue
			}
			coverage.add(asset.id, free.in, free.out)
			trimmed.push({ clip, in: free.in, out: free.out })
		}
		if (alreadyCovered) {
			notes.push(`Skipped ${alreadyCovered} piece${alreadyCovered === 1 ? '' : 's'} of "${asset.name}" already on the timeline.`)
		}
		if (!trimmed.length) {
			droppedOps.push(`range: all of #${fromIdx}–#${toIdx} of ${asset.name} is already on the timeline`)
			continue
		}

		const runs: Run[] = []
		for (const { clip, in: clipIn, out: clipOut } of trimmed) {
			const last = runs[runs.length - 1]
			const delta = last ? clipIn - last.out : Number.POSITIVE_INFINITY
			// Index adjacency is MANDATORY and not implied by the time test: an
			// excluded piece shorter than MERGE_GAP_TOL_SEC would otherwise be
			// silently swallowed back into the merged item's [in, out].
			const adjacent = !!last &&
				clip.index === last.lastIdx + 1 &&
				delta <= MERGE_GAP_TOL_SEC &&
				delta >= -MERGE_OVERLAP_TOL_SEC &&
				(last.out - last.in) < MAX_MERGED_SOURCE_SEC
			if (range.merge !== false && adjacent) {
				last.out = Math.max(last.out, clipOut)
				last.lastIdx = clip.index
				last.count++
			} else {
				runs.push({ in: clipIn, out: clipOut, first: clip, firstIdx: clip.index, lastIdx: clip.index, count: 1 })
			}
		}

		const speed = clampSpeed(range.speed ?? 1)
		let cursor = positionFor(range)
		let capped = false
		for (let k = 0; k < runs.length; k++) {
			if (adds.length >= MAX_EXPANDED_ITEMS) {
				capped = true
				break
			}
			const run = runs[k]
			// Only an untrimmed single piece still IS that piece — a trimmed span
			// must not claim its id, or the clip UI shows the wrong thumbnail.
			const single = run.count === 1 && run.in === run.first.in && run.out === run.first.out
			const duration = (run.out - run.in) / speed
			const label = range.label
				? (runs.length === 1 ? range.label : `${range.label} ${k + 1}/${runs.length}`)
				: single
					? labelFrom(run.first)
					: run.count === 1
						? labelFrom(run.first)
						: `#${run.firstIdx}–#${run.lastIdx} (${run.count} pieces)`
			pushItem({
				id: uuidv4(),
				trackId: targetTrack.id,
				sourceAssetId: asset.id,
				// A merged run no longer maps to one detected piece — same rule the
				// razor split and the silence carve already follow. Never fake these:
				// the clip UI resolves sourceClipId to show that piece's thumbnail.
				sourceClipId: single ? run.first.id : undefined,
				masterSegmentIndex: single ? run.first.masterSegmentIndex : undefined,
				timelineStart: cursor,
				in: run.in,
				out: run.out,
				speed,
				preservePitch: true,
				duration,
				label
			})
			cursor += duration
		}
		if (capped) {
			droppedOps.push(`range #${fromIdx}–#${toIdx} of ${asset.name}: stopped at the ${MAX_EXPANDED_ITEMS}-clip limit for one edit`)
		}
	}

	if (adds.length) diff.addItems = adds
	if (adds.length > EXPANSION_ADVISORY) {
		notes.push(`This edit expands to ${adds.length} clips — fewer, larger ranges would keep the timeline easier to work with.`)
	}

	// ===== Leave no holes =====
	// Removing items without pulling the rest left leaves a gap on the timeline.
	// Manual delete has always rippled (editorStore.deleteItems); AI removals
	// used to not, which is where stray gaps came from.
	const removedIds = new Set(diff.removeItemIds || [])
	const removedItems = doc.timeline.filter((i) => removedIds.has(i.id))
	// If the model positioned items itself, respect that rather than shifting
	// its work a second time.
	const modelMovedItems = (diff.updateItems || []).some((u) => typeof u.timelineStart === 'number')
	const wantsCloseGaps = ops.closeGaps === true

	if (wantsCloseGaps || (removedItems.length > 0 && !modelMovedItems)) {
		const updateById = new Map((diff.updateItems || []).map((u) => [u.id, u]))
		const survivors = doc.timeline
			.filter((i) => !removedIds.has(i.id))
			.map((i) => {
				const merged = { ...i, ...(updateById.get(i.id) || {}) } as TimelineItem
				merged.duration = itemDuration(merged)
				return merged
			})
		// `adds` are the real objects, so the helpers reposition them in place.
		const working = [...survivors, ...adds]

		const moved = wantsCloseGaps
			? closeTimelineGaps({ tracks: doc.tracks, timeline: working })
			: rippleAfterRemoval(working, removedItems)

		if (moved) {
			const updates = diff.updateItems ? [...diff.updateItems] : []
			const byId = new Map(updates.map((u, index) => [u.id, index]))
			const originalStart = new Map(doc.timeline.map((i) => [i.id, i.timelineStart]))
			let shifted = 0
			for (const item of survivors) {
				if (Math.abs(item.timelineStart - (originalStart.get(item.id) ?? 0)) < 1e-6) continue
				shifted++
				const index = byId.get(item.id)
				if (index != null) updates[index] = { ...updates[index], timelineStart: item.timelineStart }
				else updates.push({ id: item.id, timelineStart: item.timelineStart })
			}
			if (updates.length) diff.updateItems = updates
			if (wantsCloseGaps && shifted) {
				notes.push(`Closed the gaps — ${shifted} clip${shifted === 1 ? '' : 's'} moved up.`)
			}
		}
	}

	// ===== Markers: atSec directly, atScene resolved against final placements =====
	const allPlacements: Placement[] = [
		...doc.timeline.map((i) => ({
			assetId: i.sourceAssetId,
			srcIn: i.in,
			srcOut: i.out,
			tStart: i.timelineStart,
			speed: i.speed || 1
		})),
		...placements
	]

	const resolved: { time: number; label: string }[] = []
	for (const marker of ops.addMarkers || []) {
		if (!marker?.label) continue
		if (typeof marker.atSec === 'number' && marker.atSec >= 0) {
			if (marker.atScene) notes.push(`Marker "${marker.label}" gave both atSec and atScene — used atSec.`)
			resolved.push({ time: marker.atSec, label: marker.label })
			continue
		}
		const anchor = marker.atScene
		if (!anchor) {
			droppedOps.push(`marker "${marker.label}": no position given`)
			continue
		}
		const asset = doc.media.find((a) => a.id === anchor.assetId)
		const clip = asset?.clips.find((c) => c.index === Math.round(anchor.sceneIndex))
		if (!clip) {
			droppedOps.push(`marker "${marker.label}": unknown piece #${anchor.sceneIndex} of ${asset?.name || anchor.assetId}`)
			continue
		}
		const candidates = allPlacements.filter((p) =>
			p.assetId === anchor.assetId && clip.in >= p.srcIn - 0.05 && clip.in < p.srcOut + 0.05
		)
		if (!candidates.length) {
			droppedOps.push(`marker "${marker.label}": piece #${clip.index} of ${asset!.name} is not on the timeline`)
			continue
		}
		// Same source used twice -> earliest placement, deterministically.
		const best = candidates.reduce((a, b) => (b.tStart < a.tStart ? b : a))
		// Exact: a merged run is a single linear source -> timeline mapping.
		resolved.push({
			time: Math.max(0, best.tStart + (clip.in - best.srcIn) / (best.speed || 1)),
			label: marker.label
		})
	}

	const addMarkers: { time: number; label: string }[] = []
	for (const marker of resolved.sort((a, b) => a.time - b.time)) {
		const previous = addMarkers[addMarkers.length - 1]
		if (previous && marker.time - previous.time < MARKER_DEDUPE_SEC) continue
		addMarkers.push(marker)
	}

	return { diff, addMarkers, droppedOps, notes }
}
