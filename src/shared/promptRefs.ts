import { itemEnd } from './timeline'
import type { EditorMarker, MediaAsset, PromptAttachment, TimelineItem, Track } from './types'

/**
 * References in a chat prompt: `@0:53.1` names a moment on the timeline, and a
 * frame attachment is a still of one. The composer shows them as chips; the
 * agent gets them spelled out (timeline seconds, the clip under that moment,
 * the source time it plays), because "@0:53.1" alone leaves the agent to guess
 * which of several stacked clips the user meant and where in the footage it is.
 *
 * Everything here is pure: the composer, the chat history and main (which
 * writes what the agent reads) all use the same parser, so a chip in the
 * composer is exactly a reference the agent receives.
 */

// ===== Timecodes =====

/**
 * Seconds from a timecode the user typed: `83.5`, `1:23`, `1:23.4`, `1:02:03`,
 * `1:02:03.5`, with or without a leading `@`. Null for anything else.
 *
 * Seconds after a colon must be two digits and under 60 (so `1:75` and `1:5`
 * are refused rather than guessed at); a bare number of seconds may be any size.
 */
export function parseTimecode(input: string): number | null {
	const text = String(input ?? '').trim().replace(/^@/, '')
	const match = /^(?:(\d+):(?:(\d{2}):)?)?(\d+(?:\.\d+)?)$/.exec(text)
	if (!match) return null
	const [, first, second, last] = match
	const seconds = Number(last)
	if (first === undefined) return Number.isFinite(seconds) ? seconds : null
	// With a colon, the last field is seconds of a minute: two digits, under 60.
	if (!/^\d{2}(?:\.\d+)?$/.test(last) || seconds >= 60) return null
	if (second === undefined) return Number(first) * 60 + seconds
	const minutes = Number(second)
	if (minutes >= 60) return null
	return Number(first) * 3600 + minutes * 60 + seconds
}

/**
 * `0:53.1`, `12:04.0`, `1:02:03.5`: tenths, the precision the composer shows.
 * Rounded once, up front, so 59.96 reads `1:00.0` and never `0:60.0`.
 */
export function formatTimecode(sec: number): string {
	const tenths = Math.round(Math.max(0, Number.isFinite(sec) ? sec : 0) * 10)
	const hours = Math.floor(tenths / 36000)
	const minutes = Math.floor((tenths % 36000) / 600)
	const rest = (tenths % 600) / 10
	const ss = rest.toFixed(1).padStart(4, '0')
	return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`
}

/** What the picker inserts and the parser finds: `@0:53.1`. */
export const timeRefToken = (sec: number): string => `@${formatTimecode(sec)}`

// ===== Finding references in text =====

export interface TimeRefMatch {
	/** Index of the `@`. */
	start: number
	/** Index just past the timecode. */
	end: number
	raw: string
	sec: number
}

/**
 * An `@` that starts a word (so `name@1:00` in an address is not one), then a
 * timecode, then something that ends it. A sentence's full stop after it is
 * fine (`at @1:23.`); `@1:2` and `@1:23x` are not references.
 */
const REF = /(^|[\s([{"'“‘])@(\d+(?::\d{2}){0,2}(?:\.\d+)?)(?![\w:@]|\.\d)/g

export function findTimeRefs(text: string): TimeRefMatch[] {
	const found: TimeRefMatch[] = []
	for (const m of String(text ?? '').matchAll(REF)) {
		const sec = parseTimecode(m[2])
		if (sec === null) continue
		const start = (m.index ?? 0) + m[1].length
		found.push({ start, end: start + 1 + m[2].length, raw: `@${m[2]}`, sec })
	}
	return found
}

/** Text split into plain runs and references, for drawing chips. */
export type RefSegment = { kind: 'text'; text: string } | { kind: 'ref'; text: string; sec: number }

export function splitTimeRefs(text: string): RefSegment[] {
	const segments: RefSegment[] = []
	let at = 0
	for (const ref of findTimeRefs(text)) {
		if (ref.start > at) segments.push({ kind: 'text', text: text.slice(at, ref.start) })
		segments.push({ kind: 'ref', text: ref.raw, sec: ref.sec })
		at = ref.end
	}
	if (at < text.length) segments.push({ kind: 'text', text: text.slice(at) })
	return segments
}

/**
 * The `@…` being typed right before the caret, which the picker filters by.
 * Null when the caret is not in one. Letters are allowed so `@mark` can filter
 * the list; a space ends it.
 */
export function atQuery(text: string, caret: number): { start: number; query: string } | null {
	const before = String(text ?? '').slice(0, Math.max(0, caret))
	const m = /(^|[\s([{"'“‘])@([\w:.]{0,16})$/.exec(before)
	if (!m) return null
	return { start: before.length - m[2].length - 1, query: m[2] }
}

// ===== What a moment is =====

export interface RefContext {
	timeline: TimelineItem[]
	tracks: Track[]
	media: Pick<MediaAsset, 'id' | 'name'>[]
	markers?: EditorMarker[]
}

/** The end of the last clip: past it nothing plays. */
export const timelineEnd = (ctx: Pick<RefContext, 'timeline'>): number =>
	ctx.timeline.reduce((end, item) => Math.max(end, itemEnd(item)), 0)

/** A clip's name as the user knows it: its label, or its file's. */
export function clipName(item: TimelineItem, ctx: Pick<RefContext, 'media'>): string {
	return item.label?.trim() || ctx.media.find((m) => m.id === item.sourceAssetId)?.name || 'clip'
}

/**
 * The clips playing at `sec`, the one on top first (picture over sound, then
 * the higher video lane), which is the one a person looking at the monitor
 * means. A clip's end is exclusive: at a cut, the incoming clip is the one shown.
 */
export function clipsAt(sec: number, ctx: Pick<RefContext, 'timeline' | 'tracks'>): TimelineItem[] {
	const track = new Map(ctx.tracks.map((t) => [t.id, t]))
	const rank = (item: TimelineItem) => {
		const t = track.get(item.trackId)
		return (t?.kind === 'video' ? 1_000_000 : 0) + (t?.order ?? 0)
	}
	return ctx.timeline
		.filter((item) => sec >= item.timelineStart && sec < itemEnd(item))
		.sort((a, b) => rank(b) - rank(a))
}

const secs = (sec: number) => `${sec.toFixed(3)}s`

/**
 * One moment, spelled out for the agent: the exact timeline seconds and what
 * plays there, each clip with its id and the time in its source file.
 * Clips with no media (titles, motion layers, generated layers) are named
 * without a source time, which they do not have.
 */
export function describeMoment(sec: number, ctx: RefContext): string {
	const end = timelineEnd(ctx)
	const head = `timeline ${secs(sec)}`
	if (sec >= end) return `${head}, past the end of the timeline (it ends at ${formatTimecode(end)}), so nothing plays there`
	const under = clipsAt(sec, ctx)
	if (!under.length) return `${head}, a gap: nothing plays there`
	const parts = under.slice(0, 3).map((item) => {
		const media = ctx.media.find((m) => m.id === item.sourceAssetId)
		const name = `"${clipName(item, ctx)}" (item ${item.id})`
		if (!media) return name
		const source = item.in + (sec - item.timelineStart) * (item.speed || 1)
		return `${name} at ${secs(source)} into ${media.name}`
	})
	const more = under.length > 3 ? ` and ${under.length - 3} more` : ''
	return `${head}, on ${parts.join('; over ')}${more}`
}

/**
 * The note main adds under the user's words: every reference once, in order,
 * then every attached frame with its note. Empty when there is nothing to add.
 */
export function describeReferences(
	text: string,
	attachments: Pick<PromptAttachment, 'timeSec' | 'note' | 'marked' | 'labels'>[],
	ctx: RefContext
): string {
	const lines: string[] = []
	const seen = new Set<string>()
	for (const ref of findTimeRefs(text)) {
		if (seen.has(ref.raw)) continue
		seen.add(ref.raw)
		lines.push(`- ${ref.raw} = ${describeMoment(ref.sec, ctx)}.`)
	}
	if (attachments.length) {
		if (lines.length) lines.push('')
		lines.push(`Attached frame${attachments.length === 1 ? '' : 's'} (the image${attachments.length === 1 ? '' : 's'} with this message, in this order), each the exact frame the monitor showed:`)
		attachments.forEach((a, i) => {
			const note = a.note?.trim() ? ` The user's note on it: "${a.note.trim()}".` : ''
			const marked = a.marked ? ' The user drew marks on it (arrows, boxes, rings, lines or text) to point at something; the marks are not in the video.' : ''
			const labels = a.labels?.length ? ` Text the user wrote on it: ${a.labels.map((l) => `"${l}"`).join(', ')}.` : ''
			lines.push(`${i + 1}. Frame at ${timeRefToken(a.timeSec)} = ${describeMoment(a.timeSec, ctx)}.${note}${marked}${labels}`)
		})
	}
	return lines.length ? `References in this message:\n${lines.join('\n')}` : ''
}

// ===== The @ picker =====

export interface TimeRefOption {
	id: string
	/** "Playhead", "Start of Intro", "Marker: Hook". */
	label: string
	sec: number
	/** A frame capture rather than a time: the composer attaches the still. */
	frame?: boolean
	/** Past the end of the timeline: still insertable, but worth a warning. */
	pastEnd?: boolean
}

/**
 * The picker's rows for what follows the `@`. A timecode the user typed comes
 * first (and alone, unless other rows share its digits); words filter by label.
 */
export function timeRefOptions(
	query: string,
	ctx: RefContext & { playheadSec: number; selected: TimelineItem[]; canCapture?: boolean }
): TimeRefOption[] {
	const end = timelineEnd(ctx)
	const rows: TimeRefOption[] = []
	if (ctx.canCapture) rows.push({ id: 'frame', label: 'Frame at the playhead', sec: ctx.playheadSec, frame: true })
	rows.push({ id: 'playhead', label: 'Playhead', sec: ctx.playheadSec })
	for (const item of ctx.selected.slice(0, 3)) {
		const name = clipName(item, ctx)
		rows.push({ id: `start-${item.id}`, label: `Start of ${name}`, sec: item.timelineStart })
		// A hair before the end: the end itself is the next clip's first frame.
		rows.push({ id: `end-${item.id}`, label: `End of ${name}`, sec: Math.max(item.timelineStart, itemEnd(item) - 0.05) })
	}
	for (const marker of [...(ctx.markers ?? [])].sort((a, b) => a.time - b.time)) {
		rows.push({ id: `marker-${marker.id}`, label: `Marker${marker.label ? `: ${marker.label}` : ''}`, sec: marker.time })
	}
	const q = query.trim().toLowerCase()
	const marked = (row: TimeRefOption): TimeRefOption => (row.sec >= end && !row.frame ? { ...row, pastEnd: true } : row)
	if (!q) return rows.map(marked)
	// Digits being typed: `@0:1` is not a time yet, but it narrows the list to
	// the rows it could become; once it parses (`@0:12`) it is a row itself.
	if (/^[\d:.]+$/.test(q)) {
		const typed = parseTimecode(q)
		const digits = rows.filter((r) => !r.frame && formatTimecode(r.sec).startsWith(q))
		return [...(typed === null ? [] : [{ id: 'typed', label: 'Time', sec: typed }]), ...digits].map(marked)
	}
	return rows.filter((r) => r.label.toLowerCase().includes(q)).map(marked)
}
