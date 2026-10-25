import type { AgentFocus } from './engines'
import type { TimelineDiff, TimelineItem, TranscriptHealth, DescriptionHealth } from './types'
import type { AgentPermissions } from './agent'

/**
 * What the user sees of an agent's work, and the read-side helpers its tools
 * share: the Agent tab's activity rows, the dashed "changed by the agent"
 * outlines, moment search, and paging under a character budget. Pure, so the
 * server and the feed agree and it is all testable without Electron.
 */

// ===== Wire types (main → renderer) =====

export type AgentChipTone = 'violet' | 'red' | 'green' | 'blue' | 'zinc'
export interface AgentChip { text: string; tone: AgentChipTone }

export type AgentActivityStatus = 'running' | 'done' | 'error' | 'refused'

/** One row of the Agent tab's feed: one tool call. */
export interface AgentActivity {
	id: string
	sessionId: string
	tool: string
	/** Tool name plus its key argument: "render_frame 0:27.5". */
	title: string
	/** The result, in a phrase: "4 clips · 2 titles · 0:40.0". */
	detail?: string
	/** The agent's own words, when it gave a reason (render_frame's note). */
	quote?: string
	chips?: AgentChip[]
	/** render_frame only: a small JPEG data URL. */
	thumbnail?: string
	status: AgentActivityStatus
	startedAt: number
	endedAt?: number
	/** Where the agent is acting: the media it reads, the time it looks at or edits. */
	focus?: AgentFocus
}

export interface AgentSessionInfo {
	id: string
	clientName: string
	clientVersion?: string
	/** The client's working folder, when it shares MCP roots. */
	root?: string
	connectedAt: number
	lastActivityAt: number
	/** Tool calls so far. */
	steps: number
	/** The project it last read, filled in by main for Settings' session list. */
	project?: string
}

export interface AgentRecentSession {
	clientName: string
	project: string
	startedAt: number
	steps: number
}

export interface AgentAccessState {
	enabled: boolean
	running: boolean
	port: number | null
	url: string | null
	/** "ff_••••••••••••3f9a" — the full token never leaves main. */
	tokenMasked: string
	/** The short form the connect snippets show. */
	tokenShort: string
	permissions: AgentPermissions
	sessions: AgentSessionInfo[]
	recent: AgentRecentSession[]
	error?: string
}

/** What the renderer reports after it applied (or could not apply) an agent's turn. */
export type AgentApplyOutcome =
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

// ===== Formatting =====

/** "0:27.5" — the monitor's own notation, so the feed and the timecode agree. */
export function clock(sec: number): string {
	const safe = Math.max(0, Number.isFinite(sec) ? sec : 0)
	const minutes = Math.floor(safe / 60)
	const rest = safe - minutes * 60
	return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// ===== Summaries =====

/**
 * "4 clips · 2 titles · 0:40.0". Counts by what an item IS, so a kind another
 * stage adds shows up as "other" until it is named here, never as a clip.
 */
export function summarizeTimeline(items: TimelineItem[]): string {
	let clips = 0, titles = 0, generated = 0, other = 0
	let end = 0
	for (const item of items) {
		end = Math.max(end, item.timelineStart + item.duration)
		if (item.text) titles++
		else if (item.generator) generated++
		else if (item.sourceAssetId) clips++
		else other++
	}
	const parts = [plural(clips, 'clip')]
	if (titles) parts.push(plural(titles, 'title'))
	if (generated) parts.push(plural(generated, 'generated layer'))
	if (other) parts.push(plural(other, 'other layer'))
	parts.push(clock(end))
	return parts.join(' · ')
}

/** "good", or the problems: an agent should know when a transcript lies. */
export function transcriptHealthLabel(health?: TranscriptHealth, hasTranscript = true): string {
	if (!hasTranscript) return 'no transcript'
	if (!health) return 'health unchecked'
	const problems: string[] = []
	if (health.looped) problems.push('looped')
	if (health.truncated) problems.push('stops early')
	if (health.hasHole) problems.push('has a gap')
	if (health.timing?.drift) problems.push('timing off')
	if (health.timing?.silentTextAtSec?.length) problems.push('text over silence')
	return problems.length ? `transcript ${problems.join(', ')}` : 'health good'
}

export function describeHealthLabel(health?: DescriptionHealth): string | null {
	if (!health) return null
	return health.coverage >= 0.999 ? null : `${Math.round(health.coverage * 100)}% described`
}

export function summarizeMedia(options: {
	words: number | null
	scenes: number
	transcriptHealth?: TranscriptHealth
	descriptionHealth?: DescriptionHealth
}): string {
	const parts: string[] = []
	parts.push(options.words === null ? 'no transcript' : `transcript ${plural(options.words, 'word')}`)
	parts.push(plural(options.scenes, 'scene'))
	if (options.words !== null) parts.push(transcriptHealthLabel(options.transcriptHealth))
	const described = describeHealthLabel(options.descriptionHealth)
	if (described) parts.push(described)
	return parts.join(' · ')
}

export const countWords = (text: string): number => (text.match(/\S+/g) || []).length

// ===== Edit chips =====

/** Noun per op, for "−1 range" / "+3 clips". Unknown ops still get a chip. */
const OP_NOUNS: Record<string, string> = {
	removeRanges: 'range', removeItemIds: 'clip', updateItems: 'change',
	addClips: 'clip', addSceneRanges: 'span', addTitles: 'title', addMarkers: 'marker',
	setTransitions: 'transition', applyLook: 'look', clearLooks: 'look cleared',
	addBackgrounds: 'background', addSounds: 'sound', setSounds: 'sound', placeAudio: 'audio', setTrackRoles: 'role'
}

/**
 * Chips for one applied edit, from what the agent ASKED for (ops), not from the
 * diff: a removed range splits clips, and "+1 clip −0 clips 2 changes" is a
 * worse description of "cut 2.4s" than "−1 range". Generic over op names, so
 * ops added later get a sensible chip with no change here.
 */
export function opChips(ops: Record<string, unknown>, revisionSeq?: number | null): AgentChip[] {
	const chips: AgentChip[] = []
	if (revisionSeq !== undefined && revisionSeq !== null) chips.push({ text: `V${revisionSeq}`, tone: 'violet' })
	for (const [key, value] of Object.entries(ops)) {
		if (key === 'rationale' || value === undefined || value === null) continue
		if (Array.isArray(value)) {
			if (!value.length) continue
			const noun = OP_NOUNS[key] || key.replace(/^(add|remove|set|apply|update|clear)/, '').toLowerCase() || key
			const label = noun.endsWith('cleared') || value.length === 1 ? noun : `${noun}s`
			if (key.startsWith('remove')) chips.push({ text: `−${value.length} ${label}`, tone: 'red' })
			else if (key.startsWith('update')) chips.push({ text: plural(value.length, noun), tone: 'blue' })
			else chips.push({ text: `+${value.length} ${label}`, tone: 'green' })
		} else if (typeof value === 'boolean') {
			if (key === 'closeGaps') { if (value) chips.push({ text: 'gaps closed', tone: 'blue' }) }
			else chips.push({ text: `${key} ${value ? 'on' : 'off'}`, tone: 'blue' })
		}
	}
	return chips
}

// ===== Changed-by-the-agent marks =====

/**
 * Badge per item the agent's latest edit touched: "AI" for something it added,
 * the signed length change ("−2.4s") when it retimed or trimmed one, "AI" for
 * any other change. Removed items are gone and need no mark.
 *
 * A cut INSIDE a clip splits it: the clip is trimmed and its remainder added
 * as a new item. Badging the trimmed piece with its own change would report a
 * 1s cut from a 39s clip as "−28.0s", so when one asset has both a trimmed
 * clip and an added piece, the trimmed one carries the NET change across all
 * of them and the added pieces read "AI".
 */
export function agentChangeBadges(forward: TimelineDiff, before: TimelineItem[]): Record<string, string> {
	const marks: Record<string, string> = {}
	const prior = new Map(before.map((item) => [item.id, item]))
	const signed = (delta: number) => `${delta < 0 ? '−' : '+'}${Math.abs(delta).toFixed(1)}s`
	const EPS = 0.01
	const added = forward.addItems || []
	for (const item of added) marks[item.id] = 'AI'

	for (const update of forward.updateItems || []) {
		const was = prior.get(update.id)
		if (!was) {
			marks[update.id] = 'AI'
			continue
		}
		const duration = typeof update.duration === 'number' ? update.duration : was.duration
		const keptIn = typeof update.in === 'number' ? update.in : was.in
		const keptOut = typeof update.out === 'number' ? update.out : was.out
		// The remainder of a split: same source, inside the original range, and
		// on the far side of what the trimmed piece kept.
		const remainder = added.filter((piece) =>
			piece.sourceAssetId === was.sourceAssetId && !!was.sourceAssetId &&
			piece.in >= was.in - EPS && piece.out <= was.out + EPS &&
			(piece.in >= keptOut - EPS || piece.out <= keptIn + EPS)
		)
		const delta = duration + remainder.reduce((sum, piece) => sum + piece.duration, 0) - was.duration
		marks[update.id] = Math.abs(delta) >= 0.05 ? signed(delta) : 'AI'
	}
	return marks
}

// ===== Moment search =====

export interface SearchSource {
	assetId: string
	assetName: string
	transcript: { start: number; end: number; text: string }[]
	scenes: { index: number; in: number; out: number; visual?: string }[]
}

export interface MomentHit {
	assetId: string
	assetName: string
	kind: 'speech' | 'scene'
	sceneIndex?: number
	sourceStart: number
	sourceEnd: number
	text: string
	/** Where this moment plays on the current timeline; empty when it is not on it. */
	timelineSec: number[]
	score: number
}

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'and', 'or', 'is', 'it', 'at', 'for', 'with', 'that', 'this'])

const tokens = (text: string): string[] =>
	text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)

/**
 * Where a source instant plays on the timeline — once per clip that contains
 * it, since the same moment can be placed twice.
 */
export function sourceToTimeline(items: TimelineItem[], assetId: string, sec: number): number[] {
	return items
		.filter((item) => item.sourceAssetId === assetId && sec >= item.in && sec < item.out)
		.map((item) => item.timelineStart + (sec - item.in) / (item.speed || 1))
		.sort((a, b) => a - b)
}

/**
 * Plain word matching over what was SAID and what was SEEN. Deliberately not
 * clever: the agent is the one with judgement, and it can search again with
 * other words. A hit needs half the query's content words (all of them for a
 * two-word query); the exact phrase scores highest.
 */
export function searchMoments(
	query: string, sources: SearchSource[], items: TimelineItem[], limit = 10
): MomentHit[] {
	const all = tokens(query)
	const wanted = all.filter((t) => !STOPWORDS.has(t))
	const terms = wanted.length ? wanted : all
	if (!terms.length) return []
	const phrase = all.join(' ')
	const needed = terms.length <= 2 ? terms.length : Math.ceil(terms.length / 2)

	const score = (text: string): number => {
		const words = tokens(text)
		const set = new Set(words)
		const matched = terms.filter((t) => set.has(t) || words.some((w) => w.startsWith(t) && t.length >= 4)).length
		if (matched < needed) return 0
		return matched / terms.length + (words.join(' ').includes(phrase) ? 1 : 0)
	}

	const hits: MomentHit[] = []
	for (const source of sources) {
		for (const entry of source.transcript) {
			const s = score(entry.text)
			if (s > 0) hits.push({
				assetId: source.assetId, assetName: source.assetName, kind: 'speech',
				sourceStart: entry.start, sourceEnd: entry.end, text: entry.text,
				timelineSec: sourceToTimeline(items, source.assetId, entry.start), score: s
			})
		}
		for (const scene of source.scenes) {
			if (!scene.visual) continue
			const s = score(scene.visual)
			if (s > 0) hits.push({
				assetId: source.assetId, assetName: source.assetName, kind: 'scene', sceneIndex: scene.index,
				sourceStart: scene.in, sourceEnd: scene.out, text: scene.visual,
				timelineSec: sourceToTimeline(items, source.assetId, scene.in),
				// A description is a paraphrase; the words someone said win a tie.
				score: s * 0.9
			})
		}
	}
	return hits
		.sort((a, b) => b.score - a.score || a.sourceStart - b.sourceStart)
		.slice(0, Math.max(1, limit))
}

/** '“how much faster” → 2 hits, best at 0:26.1' */
export function summarizeSearch(query: string, hits: MomentHit[]): string {
	if (!hits.length) return `“${query}” → no hits`
	const best = hits[0]
	const at = best.timelineSec.length ? clock(best.timelineSec[0]) : `${best.assetName} ${clock(best.sourceStart)}`
	return `“${query}” → ${plural(hits.length, 'hit')}, best at ${at}`
}

// ===== Paging under a character budget =====

export interface Page<T> {
	rows: T[]
	offset: number
	total: number
	/** Pass this as `offset` to read on; null at the end. */
	nextOffset: number | null
}

/**
 * Rows from `offset`, stopping at `limit` rows or `maxChars` of JSON, whichever
 * comes first — but always at least one row, so a single huge row cannot stall
 * a reader at the same offset forever.
 */
export function pageRows<T>(rows: T[], options: { offset?: number; limit?: number; maxChars?: number }): Page<T> {
	const offset = Math.max(0, Math.floor(options.offset || 0))
	const limit = Math.max(1, Math.floor(options.limit || rows.length || 1))
	const maxChars = options.maxChars ?? Infinity
	const out: T[] = []
	let used = 0
	for (let i = offset; i < rows.length && out.length < limit; i++) {
		const size = JSON.stringify(rows[i]).length + 1
		if (out.length > 0 && used + size > maxChars) break
		out.push(rows[i])
		used += size
	}
	const next = offset + out.length
	return { rows: out, offset, total: rows.length, nextOffset: next < rows.length ? next : null }
}
