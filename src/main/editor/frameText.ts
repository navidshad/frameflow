import ffmpeg from 'fluent-ffmpeg'
import fs from 'fs'
import path from 'path'
import { cuesToAss, escapeSubtitlesPath, type CaptionCue } from '@shared/captions'
import { runCommand } from './render'

/**
 * Burns cues into a single still frame, the way the export burns them into the
 * finished file (captions.ts burnCaptions). `cues` are already re-timed to the
 * clip that starts at the earliest of them (cuesAtInstant), and `at` is how far
 * into that clip the frame sits, so each cue is as far into its fade as it is
 * in the export.
 *
 * Returns the burned PNG's path, or null when libass could not run — the
 * picture without its text beats no picture, and the caller keeps the original.
 */
export async function burnFrameText(options: {
	framePath: string
	cues: CaptionCue[]
	at: number
	frame: { width: number; height: number }
	fps: number
	dir: string
}): Promise<string | null> {
	const { framePath, cues, at, frame, fps, dir } = options
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
	const assPath = path.join(dir, `text-${stamp}.ass`)
	const burned = path.join(dir, `text-${stamp}.png`)
	try {
		fs.writeFileSync(assPath, cuesToAss(cues, frame), 'utf-8')
		// The still loops just long enough to reach the instant.
		const command = ffmpeg()
			.input(framePath)
			.inputOptions(['-loop', '1', '-framerate', String(fps), '-t', (at + 2 / fps).toFixed(3)])
			.videoFilters(`subtitles=filename=${escapeSubtitlesPath(assPath)}`)
			.outputOptions(['-ss', at.toFixed(3), '-frames:v', '1'])
		await runCommand(command, burned, new AbortController().signal)
		return burned
	} catch (error) {
		console.warn('[preview] could not burn text into the exact frame:', error)
		try { fs.unlinkSync(burned) } catch { /* never written */ }
		return null
	} finally {
		try { fs.unlinkSync(assPath) } catch { /* gone */ }
	}
}
