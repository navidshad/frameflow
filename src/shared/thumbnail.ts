import type { EditorDocument, MediaAsset, TimelineItem } from './types'

/**
 * Seeding an image project from a video: the pure half.
 *
 * Everything here is deterministic and free of I/O so it can be tested with
 * fake pixels and fake documents. The main-process half (src/main/thumbnail)
 * only supplies the ffmpeg grabs and writes the project.
 */

// ===== Where to look =====

export interface SamplePoint {
	/** Position on the sequence timeline (or in the lone source, when there is no timeline). */
	timelineSec: number
	assetId: string
	/** Seconds into the SOURCE file. */
	sourceSec: number
}

const hasPicture = (asset: MediaAsset | undefined): asset is MediaAsset =>
	!!asset && asset.kind === 'video' && !!asset.originalPath

/**
 * Spread `count` points across what the film actually shows.
 *
 * Midpoints of equal slices of the picture-bearing timeline: never 0s (often
 * black) and never the exact end. Titles, generated layers, audio and hidden
 * lanes carry no footage and are skipped. A project that has media but no
 * timeline yet falls back to sampling its first video, so the button is useful
 * the moment something is imported.
 */
export function samplePoints(doc: EditorDocument, count: number): SamplePoint[] {
	if (count <= 0) return []
	const assets = new Map(doc.media.map((a) => [a.id, a]))
	const hidden = new Set(doc.tracks.filter((t) => t.hidden).map((t) => t.id))

	const items: TimelineItem[] = doc.timeline
		.filter((i) => !hidden.has(i.trackId) && i.duration > 0 && hasPicture(assets.get(i.sourceAssetId)))
		.sort((a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id))

	if (!items.length) {
		const first = doc.media.find((a) => hasPicture(a) && (a.metadata?.duration ?? 0) > 0)
		if (!first) return []
		const duration = first.metadata!.duration
		return Array.from({ length: count }, (_, i) => {
			const t = (duration * (i + 0.5)) / count
			return { timelineSec: t, assetId: first.id, sourceSec: t }
		})
	}

	const start = items[0].timelineStart
	const end = Math.max(...items.map((i) => i.timelineStart + i.duration))
	const span = end - start
	const points: SamplePoint[] = []
	for (let i = 0; i < count; i++) {
		const t = start + (span * (i + 0.5)) / count
		const item = items.find((c) => t >= c.timelineStart && t < c.timelineStart + c.duration)
		if (!item) continue // a gap between clips: nothing to show there
		const speed = item.speed > 0 ? item.speed : 1
		const sourceSec = Math.min(item.out - 0.05, Math.max(item.in, item.in + (t - item.timelineStart) * speed))
		points.push({ timelineSec: t, assetId: item.sourceAssetId, sourceSec })
	}
	return points
}

// ===== Which frame is worth keeping =====

/** A small luma image, 0..255 per pixel, row-major. */
export interface GrayFrame {
	width: number
	height: number
	data: ArrayLike<number>
}

export interface FrameStats {
	/** Average luma, 0..255. */
	mean: number
	/** Standard deviation of luma: how much picture there is. */
	contrast: number
	/** Variance of the Laplacian: high for crisp edges, low for blur and flat fields. */
	sharpness: number
}

export function frameStats(frame: GrayFrame): FrameStats {
	const { width: w, height: h, data } = frame
	const n = w * h
	if (n === 0 || data.length < n) return { mean: 0, contrast: 0, sharpness: 0 }

	let sum = 0
	for (let i = 0; i < n; i++) sum += data[i]
	const mean = sum / n
	let varSum = 0
	for (let i = 0; i < n; i++) varSum += (data[i] - mean) ** 2
	const contrast = Math.sqrt(varSum / n)

	// 4-neighbour Laplacian over the interior.
	let lapSum = 0
	let lapSq = 0
	let count = 0
	for (let y = 1; y < h - 1; y++) {
		for (let x = 1; x < w - 1; x++) {
			const i = y * w + x
			const lap = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w]
			lapSum += lap
			lapSq += lap * lap
			count++
		}
	}
	const sharpness = count ? lapSq / count - (lapSum / count) ** 2 : 0
	return { mean, contrast, sharpness }
}

/** Below these a frame is black, blown out, flat or smeared: never the thumbnail. */
export const FRAME_LIMITS = { minMean: 28, maxMean: 228, minContrast: 14, minSharpness: 12 } as const

export function isUsableFrame(s: FrameStats): boolean {
	return s.mean >= FRAME_LIMITS.minMean && s.mean <= FRAME_LIMITS.maxMean
		&& s.contrast >= FRAME_LIMITS.minContrast && s.sharpness >= FRAME_LIMITS.minSharpness
}

/**
 * One number to rank by. Sharpness leads (log-scaled so one hyper-detailed
 * frame does not drown the rest), contrast adds punch, and exposure is a
 * penalty for drifting from mid-grey rather than a reward.
 */
export function frameScore(s: FrameStats): number {
	const exposure = 1 - Math.min(1, Math.abs(s.mean - 125) / 125)
	return Math.log1p(s.sharpness) * 10 + s.contrast * 0.5 + exposure * 20
}

export interface Candidate extends SamplePoint {
	stats: FrameStats
}

/**
 * The best `n` frames, best first.
 *
 * Usable frames only, unless there are none at all (then the least bad one, so
 * a dark video still gets a project). Picks must sit at least `minGapSec` apart
 * on the timeline so the choices are different shots, not neighbouring frames
 * of one. Equal scores fall to the earlier frame, so a rerun gives the same
 * answer.
 */
export function pickFrames(candidates: Candidate[], n: number, minGapSec = 0): Candidate[] {
	const ranked = (list: Candidate[]) =>
		[...list].sort((a, b) => frameScore(b.stats) - frameScore(a.stats) || a.timelineSec - b.timelineSec)

	const usable = ranked(candidates.filter((c) => isUsableFrame(c.stats)))
	const pool = usable.length ? usable : ranked(candidates).slice(0, 1)

	const picked: Candidate[] = []
	for (const c of pool) {
		if (picked.length >= n) break
		if (picked.every((p) => Math.abs(p.timelineSec - c.timelineSec) >= minGapSec)) picked.push(c)
	}
	// Spacing is a preference: if it left us short, fill from what remains.
	for (const c of pool) {
		if (picked.length >= n) break
		if (!picked.includes(c)) picked.push(c)
	}
	return picked
}

// ===== What to say =====

/** A title that tells the viewer nothing: the default name, a camera file name. */
export function isPlaceholderTitle(title: string): boolean {
	const t = title.trim()
	if (!t) return true
	if (/^untitled/i.test(t)) return true
	const stem = t.replace(/\.[a-z0-9]{2,4}$/i, '')
	if (/^(img|vid|mov|dsc|dji|gopro|gh|clip|video|screen ?recording)[ _-]?\d*/i.test(stem) && stem.replace(/\D/g, '').length >= 3) return true
	return /^[\d\s_.-]+$/.test(stem)
}

/** "my_trip-to_rome.mp4" -> "my trip to rome". */
export function cleanTitle(title: string): string {
	return title
		.replace(/\.(mp4|mov|m4v|mkv|webm|avi)$/i, '')
		.replace(/[_]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
}

const wordsOf = (s: string): string[] => s.split(/\s+/).filter(Boolean)

export const HEADLINE_MAX_WORDS = 7

/** Words that earn a phrase a place on a thumbnail. Latin only: other scripts rank by length and digits. */
const HOOK_WORDS = /\b(secret|never|always|stop|mistake|truth|worst|best|why|how|what|finally|actually|crazy|insane|shocking|ultimate|only|free|easy|fast|changed|regret|wrong|real)\b/i
const DIGIT = /[0-9۰-۹٠-٩]/
const SENTENCE_END = /(?<=[.!?؟。])\s+/

/**
 * A short, punchy phrase from what is said, or null when nothing fits.
 *
 * Takes 3-8 word sentences and ranks them: a number, a question and a hook
 * word each score, and speech nearer the start scores a little more because
 * that is where videos state what they are about. First among equals wins.
 * It is a heuristic for a first draft, not taste: the chat is where it is
 * refined.
 */
export function hookFromTranscript(lines: string[]): string | null {
	const sentences = lines
		.join(' ')
		.split(SENTENCE_END)
		.map((s) => s.replace(/[\s,;:،]+$/g, '').trim())
		.filter(Boolean)
	let best: { text: string; score: number } | null = null
	sentences.forEach((text, index) => {
		const n = wordsOf(text).length
		if (n < 3 || n > 8) return
		let score = 0
		if (DIGIT.test(text)) score += 2
		if (/[?؟]$/.test(text)) score += 2
		if (HOOK_WORDS.test(text)) score += 1
		score += 1 - Math.min(1, index / Math.max(1, sentences.length)) // early bonus, 0..1
		if (!best || score > best.score) best = { text: text.replace(/[.!]+$/, ''), score }
	})
	return best ? (best as { text: string }).text : null
}

export interface Headline {
	/** The big text. */
	text: string
	/** Where it came from, for the brief and the PR: not shown to the viewer. */
	source: 'title' | 'transcript' | 'none'
	/** A smaller second line, when the transcript had a good one and it differs. */
	kicker?: string
}

/**
 * Headline: the video's own title when it says something and fits, else the
 * best hook in the transcript, else the title shortened. A long title is
 * clipped at a word boundary rather than ellipsised: a clipped title is a
 * phrase; "…" on a thumbnail is a bug.
 */
export function chooseHeadline(title: string, transcriptLines: string[]): Headline {
	const hook = hookFromTranscript(transcriptLines)
	const clean = cleanTitle(title)
	const titleOk = !isPlaceholderTitle(title)

	if (titleOk && wordsOf(clean).length <= HEADLINE_MAX_WORDS) {
		const kicker = hook && hook.toLowerCase() !== clean.toLowerCase() ? hook : undefined
		return { text: clean, source: 'title', ...(kicker ? { kicker } : {}) }
	}
	if (hook) return { text: hook, source: 'transcript' }
	if (titleOk) return { text: wordsOf(clean).slice(0, HEADLINE_MAX_WORDS).join(' '), source: 'title' }
	return { text: '', source: 'none' }
}

export const THUMBNAIL_SIZE = { width: 1280, height: 720 } as const

/**
 * The first chat message of the thumbnail project.
 *
 * Written for the existing image-intent phase, which only acts on an
 * UNAMBIGUOUS command and strips real names: so it says "thumbnail" outright,
 * quotes the headline verbatim, and states the one rule that matters (faces
 * stay clear, text goes on the bottom edge or the side away from the subject).
 */
export function buildThumbnailBrief(options: { headline: Headline; frameCount: number }): string {
	const { headline, frameCount } = options
	const lines = [
		`Generate a YouTube thumbnail, 16:9 (${THUMBNAIL_SIZE.width}x${THUMBNAIL_SIZE.height}), for my video.`,
		frameCount > 1
			? `Use the ${frameCount} attached frames from the video as the source; take the first one as the base and keep the people and place looking exactly as they do in it.`
			: 'Use the attached frame from the video as the base and keep the people and place looking exactly as they do in it.',
		'Make it high-impact: strong contrast, a clear subject, simple composition.'
	]
	if (headline.text) {
		lines.push(
			`Headline text, exactly as written, in its own language and script: "${headline.text}". Large, bold and easy to read at small size.`
		)
		if (headline.kicker) lines.push(`Optional smaller second line, exactly as written: "${headline.kicker}".`)
		lines.push('Add no other words, logos or watermarks.')
	} else {
		lines.push('No text: the video has no usable title yet.')
	}
	lines.push(
		'Never cover a face with text or graphics. Put the text along the bottom edge, or on the side away from the subject, and leave the faces clear.'
	)
	return lines.join('\n')
}
