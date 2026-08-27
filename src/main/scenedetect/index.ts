import ffmpeg from 'fluent-ffmpeg'
import { getVideoDuration } from '../ffmpeg'
import { sensitivityToScdetThreshold } from '@shared/scene-sensitivity'
import type { Scene } from './types'

export type { Scene } from './types'

/**
 * Scene detection via FFmpeg's native `scdet` filter, using the binary already
 * bundled with the app. This replaced a shell-out to the PySceneDetect CLI,
 * which was the last dependency requiring Python on the host and the only thing
 * blocking a self-contained installer.
 *
 * One behavioural difference worth knowing: `scdet` scores on the luma plane
 * only, whereas PySceneDetect's `detect-content` compared HSV. A cut between two
 * shots of equal brightness but different colour scores zero here where it
 * previously registered. That is inherent to FFmpeg — `select='gt(scene,…)'`
 * is luma-based too — and rare in real footage, where colour changes almost
 * always move brightness as well.
 */

/**
 * `scdet` logs one line per detected cut to stderr at info level:
 *   [scdet @ 0x1356044d0] lavfi.scd.score: 15.625, lavfi.scd.time: 4
 */
const SCD_REPORT = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/

/**
 * Cuts nearer than this to the previous boundary, or to the end of the media,
 * are folded away. Guards against a flash frame or a fade producing a run of
 * scenes too short to be useful as clips.
 */
const MIN_SCENE_SEC = 0.25

/**
 * `HH:MM:SS.mm` as reported by ffmpeg's progress lines, in seconds.
 * Returns null for the `N/A` ffmpeg emits before the first frame lands.
 */
function timemarkToSeconds(timemark: string | undefined): number | null {
	if (!timemark) return null
	const parts = timemark.split(':')
	if (parts.length !== 3) return null
	const hours = Number(parts[0])
	const minutes = Number(parts[1])
	const seconds = Number(parts[2])
	if (![hours, minutes, seconds].every(Number.isFinite)) return null
	return hours * 3600 + minutes * 60 + seconds
}

/**
 * Turn detected cut times into contiguous, non-overlapping scenes covering the
 * whole media. Cuts are the points at which a new scene begins, so the first
 * scene always starts at 0 and the last always ends at `duration`.
 */
export function toScenes(cuts: number[], duration: number): Scene[] {
	if (!Number.isFinite(duration) || duration <= 0) return []

	const bounds = [0]
	for (const cut of [...cuts].sort((a, b) => a - b)) {
		if (!Number.isFinite(cut)) continue
		if (cut <= bounds[bounds.length - 1] + MIN_SCENE_SEC) continue
		if (cut >= duration - MIN_SCENE_SEC) continue
		bounds.push(cut)
	}

	return bounds.map((startTime, i) => {
		const endTime = i + 1 < bounds.length ? bounds[i + 1] : duration
		return { startTime, endTime, duration: endTime - startTime }
	})
}

export class SceneDetector {
	/**
	 * Detect scenes in a video.
	 *
	 * @param videoPath  Absolute path to the input file.
	 * @param signal     Aborts the underlying FFmpeg process.
	 * @param sensitivity 1..10 (see `@shared/scene-sensitivity`); omitted uses the default.
	 * @param onProgress Called with 0..100 as FFmpeg walks the file.
	 * @returns Scenes covering the whole media, in order. A cut-less video
	 *          yields a single scene spanning it.
	 */
	async detectScenes(
		videoPath: string,
		signal?: AbortSignal,
		sensitivity?: number,
		onProgress?: (percent: number) => void
	): Promise<Scene[]> {
		if (signal?.aborted) {
			throw new Error('Scene detection aborted before start')
		}

		const duration = await getVideoDuration(videoPath)
		const cuts = await this.findCuts(videoPath, duration, sensitivity, signal, onProgress)
		return toScenes(cuts, duration)
	}

	/** Run `scdet` over the file and collect the timestamp of every reported cut. */
	private findCuts(
		videoPath: string,
		duration: number,
		sensitivity: number | undefined,
		signal?: AbortSignal,
		onProgress?: (percent: number) => void
	): Promise<number[]> {
		const threshold = sensitivityToScdetThreshold(sensitivity)

		return new Promise((resolve, reject) => {
			// The duration probe above is async, so the signal may have fired while
			// it was in flight — don't spawn ffmpeg just to kill it.
			if (signal?.aborted) {
				return reject(new Error('Scene detection aborted by user'))
			}

			const cuts: number[] = []

			const command = ffmpeg(videoPath)
				.videoFilters(`scdet=threshold=${threshold}`)
				// Decode video only and discard the output — we want the filter's
				// side effects on stderr, not a file.
				.outputOptions(['-an', '-f', 'null'])
				.output(process.platform === 'win32' ? 'NUL' : '/dev/null')
				.on('progress', (progress) => {
					if (!onProgress) return
					// `progress.percent` is null for a `-f null` output until ffmpeg has
					// parsed the input duration, which can take until the final tick.
					// We already know the duration, so derive it from the timemark.
					const elapsed = timemarkToSeconds(progress.timemark)
					const percent =
						elapsed !== null && duration > 0
							? (elapsed / duration) * 100
							: (progress.percent ?? null)
					if (percent === null || !Number.isFinite(percent)) return
					onProgress(Math.min(100, Math.max(0, Math.round(percent))))
				})
				.on('stderr', (line: string) => {
					const match = line.match(SCD_REPORT)
					if (!match) return
					const time = parseFloat(match[2])
					if (Number.isFinite(time)) cuts.push(time)
				})
				.on('end', () => resolve(cuts))
				.on('error', (err) => {
					if (signal?.aborted) {
						return reject(new Error('Scene detection aborted by user'))
					}
					console.error(`Scene detection failed for "${videoPath}":`, err)
					reject(err)
				})

			if (signal) {
				signal.addEventListener('abort', () => command.kill('SIGKILL'))
			}

			command.run()
		})
	}
}
