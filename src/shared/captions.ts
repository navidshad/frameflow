import type { EditorDocument, TimelineItem, Track } from './types'

/**
 * Captions: transcript → cues on the timeline → an ASS file ffmpeg burns in.
 *
 * Pure and shared, because two places have to agree about every cue: the export
 * burns them with libass, and the monitor draws them in HTML. Both call
 * `captionsFromTimeline`.
 *
 * ## Where the words come from
 *
 * The transcript JSON on disk, NOT `Clip.text`. Clips are transcript segments
 * only on a fresh import; `mergeTranscriptIntoClips` later joins every
 * overlapping entry into one blob and throws the per-entry timings away, so
 * captioning from it would put a wall of text on screen per clip.
 *
 * ## Where the timings come from
 *
 * The transcriber returns PHRASES — a few seconds each, no word timings. Short
 * form wants two or three words at a time, so this apportions a phrase's
 * duration across its own chunks by character count. That is an estimate, and
 * says so: it is right at the phrase boundaries, which are measured, and
 * approximate in between. Swapping in a word-level ASR source later means
 * feeding finer entries to the same mapper — nothing here changes.
 */

/** A transcript entry in SOURCE seconds — one phrase, as transcribed. */
export interface TranscriptEntry {
	start: number
	end: number
	text: string
}

/** One line of burned-in text, in TIMELINE seconds. */
export interface CaptionCue {
	start: number
	end: number
	text: string
	/**
	 * ASS override tags for this line alone — position, size, colour.
	 *
	 * Captions leave this empty and inherit the file's Default style, which is
	 * what makes them consistent. A title sets it, because a title is placed.
	 */
	override?: string
}

export interface CaptionOptions {
	/** Words per caption. Short form reads best at two or three. */
	maxWords?: number
	/** Characters per caption, so long words do not overflow the frame. */
	maxChars?: number
	/** No caption flashes for less than this, even if the maths asks for it. */
	minCueSec?: number
}

const DEFAULTS = { maxWords: 3, maxChars: 24, minCueSec: 0.45 }

/** The transcriber's stand-in for a gap; it is not speech and never a caption. */
const SILENCE = '[Silence]'

const TIME_EPS = 1e-6

// ===== Phrase → chunks =====

/** Split into words, dropping the whitespace the model may have left behind. */
const words = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean)

/** Greedy grouping: fill a chunk until the next word breaks a limit. */
function group(all: string[], maxWords: number, maxChars: number): string[][] {
	const chunks: string[][] = []
	let current: string[] = []
	let chars = 0
	for (const word of all) {
		const cost = current.length ? word.length + 1 : word.length
		if (current.length && (current.length >= maxWords || chars + cost > maxChars)) {
			chunks.push(current)
			current = []
			chars = 0
		}
		current.push(word)
		chars += current.length > 1 ? word.length + 1 : word.length
	}
	if (current.length) chunks.push(current)
	return chunks
}

/** Even redistribution, used when a phrase is too short to hold its chunks. */
function regroup(all: string[], count: number): string[][] {
	const chunks: string[][] = []
	let taken = 0
	for (let i = 0; i < count; i++) {
		const size = Math.round((all.length - taken) / (count - i))
		chunks.push(all.slice(taken, taken + Math.max(1, size)))
		taken += Math.max(1, size)
		if (taken >= all.length) break
	}
	return chunks.filter((c) => c.length)
}

/**
 * One phrase → several cues, still in SOURCE seconds.
 *
 * Duration is apportioned by character count: longer text takes longer to say.
 * Every cue stays inside the phrase's own measured bounds, so the estimate can
 * never drift away from the speech — the error is bounded by one phrase.
 */
export function chunkPhrase(entry: TranscriptEntry, options: CaptionOptions = {}): CaptionCue[] {
	const { maxWords, maxChars, minCueSec } = { ...DEFAULTS, ...options }
	const text = (entry.text || '').trim()
	const span = entry.end - entry.start
	if (!text || text === SILENCE || !(span > TIME_EPS)) return []

	const all = words(text)
	if (!all.length) return []

	let chunks = group(all, maxWords, maxChars)
	// A phrase can be too short to give every chunk a readable moment on screen.
	// Fewer, longer captions beat a flicker of unreadable ones.
	const cap = Math.max(1, Math.floor(span / minCueSec))
	if (chunks.length > cap) chunks = regroup(all, cap)

	const lengths = chunks.map((c) => c.join(' ').length)
	const total = lengths.reduce((sum, n) => sum + n, 0) || 1
	const cues: CaptionCue[] = []
	let cursor = entry.start
	chunks.forEach((chunk, i) => {
		// The last cue ends exactly on the phrase's end, never on accumulated
		// rounding — the boundary is measured and the split is not.
		const end = i === chunks.length - 1 ? entry.end : cursor + (span * lengths[i]) / total
		cues.push({ start: cursor, end, text: chunk.join(' ') })
		cursor = end
	})
	return cues
}

// ===== Timeline mapping =====

/** Whether a track's items can be heard, and so should be captioned. */
const trackAudible = (track: Track | undefined): boolean =>
	!!track && !track.hidden && !track.muted

/**
 * Every cue the sequence should show, in timeline order.
 *
 * `transcripts` is keyed by asset id, in SOURCE seconds — parsing the SRT
 * strings on disk happens at the boundary, per the note in types.ts.
 *
 * What this has to survive, all of it reachable from the timeline UI:
 *
 * | Trim      | cues outside `[in, out]` are gone, the straddling one is clipped |
 * | Move      | offset by `timelineStart`                                        |
 * | Duplicate | one source range yields cues under every copy                    |
 * | Retime    | durations divided by `speed`                                     |
 * | Gap       | nothing — a gap renders black and says nothing                   |
 * | Muted     | skipped, item or track, because you cannot hear it               |
 *
 * Transitions need no special case: items never overlap on the timeline (the
 * render rejects that outright), so two clips' cues cannot collide. A window
 * blends the pictures either side of a cut; the words still change at the cut.
 */
export function captionsFromTimeline(
	doc: Pick<EditorDocument, 'timeline' | 'tracks'>,
	transcripts: Record<string, TranscriptEntry[]>,
	options: CaptionOptions = {}
): CaptionCue[] {
	const trackById = new Map(doc.tracks.map((t) => [t.id, t]))
	const cues: CaptionCue[] = []

	for (const item of doc.timeline) {
		if (item.muted) continue
		// A title or a generated layer carries no speech to caption. The kind of
		// the track it sits on used to answer this; now that anything visible can
		// share a video track, the ITEM has to.
		if (item.text || item.generator || item.motion) continue
		if (!trackAudible(trackById.get(item.trackId))) continue
		const entries = transcripts[item.sourceAssetId]
		if (!entries?.length) continue
		cues.push(...cuesForItem(item, entries, options))
	}

	return cues.sort((a, b) => a.start - b.start || a.end - b.end)
}

function cuesForItem(
	item: TimelineItem,
	entries: TranscriptEntry[],
	options: CaptionOptions
): CaptionCue[] {
	const speed = item.speed || 1
	// The same formula as sourceTimeToTimeline in the editor store, which cannot
	// be reused: it returns only the FIRST item matching a source time, and a
	// duplicated clip has to caption under both copies.
	const toTimeline = (t: number) => item.timelineStart + (t - item.in) / speed
	const out: CaptionCue[] = []

	for (const entry of entries) {
		// Overlap test before chunking, so a long transcript costs one comparison
		// per entry rather than a split.
		if (!(entry.start < item.out - TIME_EPS && entry.end > item.in + TIME_EPS)) continue
		for (const cue of chunkPhrase(entry, options)) {
			// Trimming cuts words, not just time: a chunk wholly outside the item's
			// range was never on the timeline, and one that straddles the edge is
			// clipped to what is actually heard.
			const start = Math.max(cue.start, item.in)
			const end = Math.min(cue.end, item.out)
			if (!(end - start > TIME_EPS)) continue
			out.push({ start: toTimeline(start), end: toTimeline(end), text: cue.text })
		}
	}
	return out
}

// ===== Titles =====

/** '#RRGGBB' to ASS's '&HBBGGRR&'. ASS colours are BGR, and they surprise everyone. */
export function assColour(hex: string | undefined, fallback: string): string {
	const match = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim())
	if (!match) return fallback
	const [r, g, b] = [0, 2, 4].map((i) => match[1].slice(i, i + 2).toUpperCase())
	return `&H00${b}${g}${r}&`
}

const TITLE_DEFAULTS = { x: 0.5, y: 0.85, size: 0.07, color: '#FFFFFF', outline: '#000000' }

/**
 * Titles as cues, so they burn in through the very same pass captions do.
 *
 * There is no second text pipeline: Phase 1 already put arbitrary positioned
 * text on the frame through libass and already drew it in the monitor. A title
 * is a cue that carries its own placement, which is exactly what `override` is.
 *
 * `\an5` anchors on the text's CENTRE, so the stored x/y is the middle of the
 * title rather than a corner — the only anchor that behaves sanely when the
 * text grows or the sequence changes shape.
 */
export function titleCues(
	doc: Pick<EditorDocument, 'timeline' | 'tracks'>,
	frame: { width: number; height: number }
): CaptionCue[] {
	const trackById = new Map(doc.tracks.map((t) => [t.id, t]))
	const cues: CaptionCue[] = []

	for (const item of doc.timeline) {
		const spec = item.text
		if (!spec?.content?.trim()) continue
		const track = trackById.get(item.trackId)
		// Hidden means hidden, whatever kind of thing is on the track.
		if (track?.hidden) continue
		const end = item.timelineStart + item.duration
		if (!(end - item.timelineStart > TIME_EPS)) continue

		const x = Math.round(clamp01(spec.x ?? TITLE_DEFAULTS.x) * frame.width)
		const y = Math.round(clamp01(spec.y ?? TITLE_DEFAULTS.y) * frame.height)
		const size = Math.max(8, Math.round(
			Math.max(0.01, Math.min(0.5, spec.size ?? TITLE_DEFAULTS.size)) * frame.height
		))
		const tags = [
			'\\an5',
			`\\pos(${x},${y})`,
			`\\fs${size}`,
			`\\1c${assColour(spec.color, '&H00FFFFFF&')}`,
			`\\3c${assColour(spec.outline, '&H00000000&')}`,
			`\\bord${Math.max(1, Math.round(size * 0.06))}`,
			`\\b${spec.bold === false ? 0 : 1}`
		]
		// Negated because `\frz` turns anticlockwise while every rotation the user
		// touches — the canvas handle, a clip's transform — turns clockwise.
		// `\an5` with `\pos` already puts the origin on the text's centre, so this
		// spins about the same point the monitor's `rotate()` does.
		const rotation = Number.isFinite(spec.rotation) ? Number(spec.rotation) : 0
		if (rotation) tags.push(`\\frz${(-rotation).toFixed(2).replace(/\.?0+$/, '')}`)

		cues.push({
			start: item.timelineStart,
			end,
			text: spec.content.trim(),
			override: `{${tags.join('')}}`
		})
	}

	return cues
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5)

/**
 * Everything that burns into the picture: spoken captions and placed titles,
 * in one list and therefore in one `subtitles=` pass.
 */
export function allBurnedCues(
	doc: Pick<EditorDocument, 'timeline' | 'tracks'>,
	transcripts: Record<string, TranscriptEntry[]>,
	frame: { width: number; height: number },
	options: { captions?: boolean; titles?: boolean } = {}
): CaptionCue[] {
	const cues: CaptionCue[] = []
	if (options.captions !== false) cues.push(...captionsFromTimeline(doc, transcripts))
	if (options.titles !== false) cues.push(...titleCues(doc, frame))
	return cues.sort((a, b) => a.start - b.start || a.end - b.end)
}

// ===== ASS =====

export interface CaptionStyle {
	/** Resolved by fontconfig/coretext at burn time; a missing one substitutes. */
	fontName?: string
	/** Cap height as a fraction of the frame, so it scales with the sequence. */
	fontScale?: number
	/** Distance from the bottom of the frame, as a fraction of its height. */
	marginScale?: number
	/** &HBBGGRR — ASS colours are BGR, not RGB. */
	primaryColour?: string
	outlineColour?: string
	bold?: boolean
}

const STYLE_DEFAULTS: Required<CaptionStyle> = {
	fontName: 'Arial',
	fontScale: 0.055,
	marginScale: 0.09,
	primaryColour: '&H00FFFFFF',
	outlineColour: '&H00000000',
	bold: true
}

/** Where the caption sits and how big it is, in pixels of a given frame. */
export interface CaptionMetrics {
	fontSize: number
	marginV: number
	marginH: number
	outline: number
}

/**
 * The caption's geometry for a frame of this size.
 *
 * The ASS writer calls it with the SEQUENCE's frame; the monitor calls it with
 * however many pixels that frame currently occupies on screen. Everything is a
 * fraction of the frame, so both get the same picture at different scales —
 * which is the only way a preview can honestly claim to show the export.
 */
export function captionMetrics(
	frame: { width: number; height: number },
	style: CaptionStyle = {}
): CaptionMetrics {
	const s = { ...STYLE_DEFAULTS, ...style }
	const fontSize = Math.max(8, Math.round(frame.height * s.fontScale))
	return {
		fontSize,
		marginV: Math.max(0, Math.round(frame.height * s.marginScale)),
		marginH: Math.round(frame.width * 0.06),
		outline: Math.max(1, Math.round(fontSize * 0.09))
	}
}

/**
 * The caption showing at time `t`, if any. Cues never overlap — one clip's
 * words end where the next clip's begin — so the first match is the answer.
 */
export function cueAt(cues: CaptionCue[], t: number): CaptionCue | null {
	return cues.find((c) => t >= c.start && t < c.end) || null
}

/** ASS wants H:MM:SS.cc, centiseconds, and no negative times. */
export function assTime(seconds: number): string {
	const clamped = Math.max(0, seconds)
	const centis = Math.round(clamped * 100)
	const h = Math.floor(centis / 360000)
	const m = Math.floor((centis % 360000) / 6000)
	const s = Math.floor((centis % 6000) / 100)
	return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(centis % 100).padStart(2, '0')}`
}

/**
 * Braces open an override block in ASS, so text containing them would be read as
 * formatting — or silently swallowed — and they are the only characters that
 * can break the parse. A real newline becomes the explicit break.
 *
 * Backslashes pass through: libass renders one literally unless it leads a
 * known control, and a transcript containing `\N` almost certainly does mean a
 * line break.
 */
export function escapeAssText(text: string): string {
	return text
		.replace(/[{]/g, '(')
		.replace(/[}]/g, ')')
		.replace(/\r?\n/g, '\\N')
}

/**
 * A complete ASS file for `cues`, sized to the frame it will be burned into.
 *
 * PlayResX/Y are the sequence's own dimensions, so libass lays out in the same
 * coordinates the video is encoded in and the text scales with the frame rather
 * than with whatever resolution was exported.
 */
export function cuesToAss(
	cues: CaptionCue[],
	frame: { width: number; height: number },
	style: CaptionStyle = {}
): string {
	const s = { ...STYLE_DEFAULTS, ...style }
	const { fontSize, marginV, marginH, outline } = captionMetrics(frame, style)

	const lines = [
		'[Script Info]',
		'ScriptType: v4.00+',
		`PlayResX: ${Math.round(frame.width)}`,
		`PlayResY: ${Math.round(frame.height)}`,
		'WrapStyle: 0',
		'ScaledBorderAndShadow: yes',
		'YCbCr Matrix: None',
		'',
		'[V4+ Styles]',
		'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour,' +
		' BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle,' +
		' BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
		`Style: Default,${s.fontName},${fontSize},${s.primaryColour},&H000000FF,` +
		`${s.outlineColour},&H80000000,${s.bold ? -1 : 0},0,0,0,100,100,0,0,1,` +
		`${outline},0,2,${marginH},${marginH},${marginV},1`,
		'',
		'[Events]',
		'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
	]

	for (const cue of cues) {
		if (!(cue.end - cue.start > TIME_EPS)) continue
		const text = escapeAssText(cue.text).trim()
		if (!text) continue
		// A title's own tags go in front of its text; a caption has none and takes
		// the Default style, which is what keeps captions looking consistent.
		lines.push(
			`Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${cue.override ?? ''}${text}`
		)
	}

	return `${lines.join('\n')}\n`
}

/**
 * Escape a path for use as the `subtitles=` filter argument.
 *
 * Two parsers read this string, and each one strips a layer of escaping:
 * the filtergraph splits on `,` `;` `[` `]`, then the filter's own option
 * parser splits on `:`. A single `\\:` is therefore not enough — the graph
 * consumes the backslash and the option parser still sees a separator, which
 * is exactly how a colon in the path used to fail the export with a message
 * about `original_size`. So each level gets its own pass, outermost last.
 *
 * Verified against the bundled binary with a directory named `weird: dir,
 * [x]'y` — see the round-trip test in renderPipeline.test.ts.
 */
/**
 * The cues on screen at one instant, re-timed so a short clip of a still
 * frame can burn them: the clip starts at the earliest of their starts, so
 * each cue keeps its own timing (its fade is as far along as in the export),
 * and the frame to grab sits `at` seconds into the clip.
 */
export function cuesAtInstant(cues: CaptionCue[], timeSec: number): { cues: CaptionCue[]; at: number } {
	const active = cues.filter((c) => c.start <= timeSec && timeSec < c.end)
	if (!active.length) return { cues: [], at: 0 }
	const offset = Math.min(...active.map((c) => c.start))
	return {
		cues: active.map((c) => ({ ...c, start: c.start - offset, end: c.end - offset })),
		at: timeSec - offset
	}
}

export function escapeSubtitlesPath(filePath: string): string {
	// ffmpeg wants forward slashes on Windows, where a backslash inside a filter
	// argument is an escape character. Only touched for a `C:\...` path, so a
	// POSIX filename that genuinely contains a backslash survives.
	const normalized = /^[A-Za-z]:[\\/]/.test(filePath)
		? filePath.replace(/\\/g, '/')
		: filePath
	const option = normalized.replace(/([\\':])/g, '\\$1')
	return option.replace(/([\\'[\],;])/g, '\\$1')
}
