import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import type { EditorDocument, MediaAsset } from '@shared/types'
import { srtToSeconds } from '@shared/timeline'
import {
	allBurnedCues, cuesToAss, escapeSubtitlesPath,
	type CaptionCue, type TranscriptEntry
} from '@shared/captions'
import { runCommand } from './render'

/**
 * The main-process half of captions: read the transcripts off disk, and burn
 * the cues the shared mapper produces into the finished file.
 *
 * Everything about WHAT a cue says and WHEN lives in `@shared/captions`, so the
 * monitor can answer the same question without ffmpeg.
 */

/** The on-disk transcript: SRT strings, which stop here. */
interface RawEntry { start: string; end: string; text: string }

/**
 * Transcripts for every asset the document uses, in SOURCE seconds.
 *
 * A missing or unreadable file is not an error — most projects have some media
 * that was never transcribed, and captions are simply absent for it.
 */
export function transcriptsForAssets(assets: MediaAsset[]): Record<string, TranscriptEntry[]> {
	const out: Record<string, TranscriptEntry[]> = {}
	for (const asset of assets) {
		const file = asset.preprocessing?.transcriptPath
		if (!file || !fs.existsSync(file)) continue
		try {
			const raw: RawEntry[] = JSON.parse(fs.readFileSync(file, 'utf-8'))
			if (!Array.isArray(raw)) continue
			out[asset.id] = raw
				.map((e) => ({
					start: srtToSeconds(e.start),
					end: srtToSeconds(e.end),
					text: (e.text || '').trim()
				}))
				.filter((e) => Number.isFinite(e.start) && Number.isFinite(e.end) && e.end > e.start)
		} catch (error) {
			console.warn('[captions] unreadable transcript for', asset.id, error)
		}
	}
	return out
}

/** The same, narrowed to the assets a document actually places. */
export const transcriptsForDoc = (doc: EditorDocument): Record<string, TranscriptEntry[]> => {
	const used = new Set(doc.timeline.map((i) => i.sourceAssetId))
	return transcriptsForAssets(doc.media.filter((a) => used.has(a.id)))
}

/**
 * Every cue this document burns in: spoken captions when the switch is on, and
 * titles always — a title is content the user placed by hand, not a setting.
 */
export function cuesForDoc(doc: EditorDocument, frame: { width: number; height: number }): CaptionCue[] {
	return allBurnedCues(doc, transcriptsForDoc(doc), frame, {
		captions: doc.captionsEnabled === true
	})
}

/**
 * Burn `cues` into `sourcePath`, returning the path of the captioned file.
 *
 * Re-encodes: this is the one step that cannot be a stream copy, since it is
 * painting on the pixels. The export dialog says so before you press the
 * button, because it is the difference between a re-mux and a full encode.
 *
 * Writes a sibling file and hands its path back rather than replacing the
 * input, so a failure here leaves the uncaptioned render intact for the caller
 * to keep or discard.
 */
export async function burnCaptions(options: {
	sourcePath: string
	workDir: string
	cues: CaptionCue[]
	frame: { width: number; height: number }
	signal: AbortSignal
	onProgress?: (percent: number) => void
}): Promise<string> {
	const { sourcePath, workDir, cues, frame, signal, onProgress } = options
	const assPath = path.join(workDir, 'captions.ass')
	fs.writeFileSync(assPath, cuesToAss(cues, frame), 'utf-8')

	const outputPath = sourcePath.replace(/\.mp4$/, '') + '.captioned.mp4'
	const command = ffmpeg()
		.input(sourcePath)
		// The path travels through two parsers before libass sees it; a colon in
		// the user's home directory used to be enough to fail the whole export.
		.videoFilters(`subtitles=filename=${escapeSubtitlesPath(assPath)}`)
		.outputOptions([
			'-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
			'-pix_fmt', 'yuv420p',
			// The mix is already final — re-encoding it would only lose a
			// generation of quality for nothing.
			'-c:a', 'copy',
			'-movflags', '+faststart'
		])
	await runCommand(command, outputPath, signal, onProgress)
	return outputPath
}
