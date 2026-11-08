import path from 'path'
import type { Message, Thread } from '@shared/types'
import {
	buildThumbnailBrief, chooseHeadline, frameStats, pickFrames, samplePoints, transcriptLinesForCut,
	type Candidate, type GrayFrame, type Headline
} from '@shared/thumbnail'

/**
 * "Generate thumbnail" for a video project, minus everything with a side effect.
 *
 * What this decides: which frames, what headline, what the first message says.
 * What it is handed: the ffmpeg grabs, the transcripts, the thread store. That
 * split is what lets the tests run it with fakes: no ffmpeg, no disk, no key.
 */

/** Tiny frames scored for choice; only the winners are extracted at full size. */
export const CANDIDATE_COUNT = 12
export const PICK_COUNT = 3
/** Picks sit at least this share of the cut apart: different shots, not neighbours. */
export const MIN_GAP_SHARE = 0.1

export interface ThumbnailDeps {
	getThread(id: string): Thread | null
	/** Transcripts per asset id, in SOURCE seconds. */
	transcripts(thread: Thread): Record<string, { start: number; end: number; text: string }[]>
	/** A small luma image of the frame, or null when ffmpeg could not read it. */
	grabGray(sourcePath: string, sec: number): Promise<GrayFrame | null>
	/** A full-size still written to `outPath`. */
	grabStill(sourcePath: string, sec: number, outPath: string): Promise<void>
	/** A folder for the stills; the image project copies them in. */
	stagingDir(thread: Thread): string
	createImageProject(title: string, imagePaths: string[]): Promise<Thread>
	addUserMessage(threadId: string, text: string): Promise<Message | null>
	hasGeminiKey(): boolean
	/** Starts the image project's own analysis (describes the frames). Fire and forget. */
	startAnalysis(threadId: string): void
}

export interface ThumbnailResult {
	thread: Thread
	/** The brief, already in the project as the first user message. */
	userMessageId: string
	headline: Headline
	frames: { sourceSec: number; assetId: string }[]
	/** The renderer runs the generation only when this is true; otherwise the message waits behind Retry. */
	hasGeminiKey: boolean
}

/** What the person sees before anything is made: the suggested prompt, to keep or rewrite. */
export interface ThumbnailBriefPreview {
	brief: string
	headline: Headline
	/** How many frames the suggested prompt assumes; the real count can be lower if a frame cannot be read. */
	frameCount: number
}

/**
 * The suggested prompt for a video, with nothing made yet: no frame is read and
 * nothing is written. The headline comes from the title or the cut's transcript,
 * the same way the real run chooses it.
 */
export function previewThumbnailBrief(
	videoThreadId: string,
	deps: Pick<ThumbnailDeps, 'getThread' | 'transcripts'>
): ThumbnailBriefPreview {
	const video = deps.getThread(videoThreadId)
	if (!video || video.type !== 'editor' || !video.editor) throw new Error('That is not a video project.')
	const doc = video.editor
	const points = samplePoints(doc, CANDIDATE_COUNT)
	if (!points.length) throw new Error('Add a video to the project first: there is no picture to take a frame from.')
	const headline = chooseHeadline(video.title, transcriptLinesForCut(doc, deps.transcripts(video)))
	const frameCount = Math.min(PICK_COUNT, points.length)
	return { brief: buildThumbnailBrief({ headline, frameCount }), headline, frameCount }
}

export interface ThumbnailOptions {
	/** The whole first message, as the person left it. Absent: the suggested prompt. */
	prompt?: string
	/** The frame count the suggested prompt that the person saw assumed (see `previewThumbnailBrief`). */
	expectedFrameCount?: number
}

export const thumbnailTitle = (videoTitle: string): string => `${videoTitle.trim() || 'Untitled Project'} – Thumbnail`

export async function createThumbnailProject(
	videoThreadId: string,
	deps: ThumbnailDeps,
	options: ThumbnailOptions = {}
): Promise<ThumbnailResult> {
	const video = deps.getThread(videoThreadId)
	if (!video || video.type !== 'editor' || !video.editor) throw new Error('That is not a video project.')
	// Before any frame is read: an empty prompt would start a paid run with nothing to say.
	if (options.prompt !== undefined && !options.prompt.trim()) {
		throw new Error('The prompt is empty. Write what the thumbnail should be, or reset it to the suggested one.')
	}
	const doc = video.editor

	const points = samplePoints(doc, CANDIDATE_COUNT)
	if (!points.length) throw new Error('Add a video to the project first: there is no picture to take a frame from.')

	const assets = new Map(doc.media.map((a) => [a.id, a]))

	// One cheap look at every point. A failed grab is just a point we cannot judge.
	const candidates: Candidate[] = []
	for (const p of points) {
		const src = assets.get(p.assetId)?.originalPath
		if (!src) continue
		const gray = await deps.grabGray(src, p.sourceSec).catch(() => null)
		if (gray) candidates.push({ ...p, stats: frameStats(gray) })
	}
	if (!candidates.length) throw new Error('Could not read any frames from the video. Is the file still where it was imported from?')

	const span = Math.max(...points.map((p) => p.timelineSec)) - Math.min(...points.map((p) => p.timelineSec))
	const picks = pickFrames(candidates, PICK_COUNT, span * MIN_GAP_SHARE)

	// Full-size stills for the winners only, best first.
	const dir = deps.stagingDir(video)
	const stills: string[] = []
	const used: ThumbnailResult['frames'] = []
	for (const [i, pick] of picks.entries()) {
		const src = assets.get(pick.assetId)!.originalPath
		const out = path.join(dir, `frame-${i + 1}-${pick.sourceSec.toFixed(1)}s.jpg`)
		try {
			await deps.grabStill(src, pick.sourceSec, out)
			stills.push(out)
			used.push({ sourceSec: pick.sourceSec, assetId: pick.assetId })
		} catch (e) {
			console.warn('[thumbnail] full-size frame failed at', pick.sourceSec, e)
		}
	}
	if (!stills.length) throw new Error('Could not save a frame from the video.')

	const headline = chooseHeadline(video.title, transcriptLinesForCut(doc, deps.transcripts(video)))
	// The suggested prompt names how many frames it uses. If the person left it as suggested and fewer
	// frames could be read than it assumed, it is rewritten to the real count; a prompt they changed
	// is theirs and goes as written.
	const suggested = buildThumbnailBrief({ headline, frameCount: stills.length })
	const shown = options.expectedFrameCount ? buildThumbnailBrief({ headline, frameCount: options.expectedFrameCount }) : suggested
	const brief = options.prompt === undefined || options.prompt.trim() === shown.trim() ? suggested : options.prompt.trim()

	const thread = await deps.createImageProject(thumbnailTitle(video.title), stills)
	const message = await deps.addUserMessage(thread.id, brief)
	if (!message) throw new Error('Could not write the first message of the thumbnail project.')
	deps.startAnalysis(thread.id)

	return {
		thread,
		userMessageId: message.id,
		headline,
		frames: used,
		hasGeminiKey: deps.hasGeminiKey()
	}
}
