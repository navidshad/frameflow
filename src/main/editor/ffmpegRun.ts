import type ffmpeg from 'fluent-ffmpeg'
import process from 'node:process'

/**
 * Runs one export ffmpeg call so that it can never hang an export silently.
 *
 * - `-nostdin`: fluent-ffmpeg spawns with a stdin pipe nobody writes; ffmpeg
 *   would otherwise poll it as a keyboard every loop.
 * - A stall watchdog: ffmpeg prints a stats line about twice a second while it
 *   works. Nothing on stderr for `stallMs` means it is stuck (the hang seen in
 *   tests was a region ffmpeg asleep at 0% CPU), so it is killed.
 * - An overall deadline, `timeoutMs`, which callers scale to the media length.
 * - SIGKILL, not SIGTERM: a stuck encoder can sit in its graceful-exit path.
 *   ffmpeg starts no children, so killing its pid kills the whole tree.
 * - Every live call is tracked, so an aborted export or a dying process
 *   (app quit, a test worker torn down) leaves no ffmpeg behind.
 */

export interface RunLimits {
	/** Kill the call if it runs longer than this in total. */
	timeoutMs?: number
	/** Kill the call if ffmpeg prints nothing for this long. */
	stallMs?: number
	/** What the call renders, named in the error: e.g. `region 12 (24.58–25.13 s)`. */
	label?: string
}

export const DEFAULT_STALL_MS = 120_000

/** Region renders run ~2× realtime; allow far worse before calling one stuck. */
export const regionTimeoutMs = (seconds: number): number => 60_000 + Math.ceil(Math.max(0, seconds) * 30_000)

const secs = (ms: number): string => `${+(ms / 1000).toFixed(1)} s`

const live = new Set<ffmpeg.FfmpegCommand>()

/** Kills every export ffmpeg still running. Safe to call at any time. */
export function killAllFfmpeg(): number {
	const n = live.size
	for (const command of live) {
		try { command.kill('SIGKILL') } catch { /* already gone */ }
	}
	live.clear()
	return n
}

export const liveFfmpegCount = (): number => live.size

// 'exit' handlers must be synchronous; kill() is.
process.once('exit', () => { killAllFfmpeg() })

export function runCommand(
	command: ffmpeg.FfmpegCommand,
	outputPath: string,
	signal: AbortSignal,
	onProgress?: (percent: number) => void,
	limits: RunLimits = {}
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error('aborted'))
		const stallMs = limits.stallMs ?? DEFAULT_STALL_MS
		const what = limits.label ? ` while rendering ${limits.label}` : ''
		let stopped: string | null = null
		let settled = false
		let stallTimer: NodeJS.Timeout | undefined
		let deadline: NodeJS.Timeout | undefined

		const stop = (reason: string) => {
			if (settled || stopped) return
			stopped = reason
			try { command.kill('SIGKILL') } catch { /* already gone */ }
		}
		const onAbort = () => stop('aborted')
		const armStall = () => {
			clearTimeout(stallTimer)
			stallTimer = setTimeout(
				() => stop(`ffmpeg made no progress for ${secs(stallMs)}${what} and was stopped`),
				stallMs
			)
		}
		const finish = (error: Error | null) => {
			if (settled) return
			settled = true
			clearTimeout(stallTimer)
			clearTimeout(deadline)
			signal.removeEventListener('abort', onAbort)
			live.delete(command)
			if (error) reject(error)
			else resolve()
		}

		signal.addEventListener('abort', onAbort, { once: true })
		command
			.output(outputPath)
			.outputOptions(['-nostdin'])
			.on('start', (cmd) => {
				console.log('[render] ffmpeg:', cmd)
				armStall()
				if (limits.timeoutMs) {
					deadline = setTimeout(
						() => stop(`ffmpeg took longer than ${secs(limits.timeoutMs!)}${what} and was stopped`),
						limits.timeoutMs
					)
				}
			})
			.on('stderr', armStall)
			.on('progress', (progress) => {
				if (onProgress && progress.percent) onProgress(Math.min(100, Math.round(progress.percent)))
			})
			.on('end', () => finish(null))
			.on('error', (err, _stdout, stderr) => {
				if (stopped === 'aborted' || signal.aborted) return finish(new Error('aborted'))
				if (stopped) {
					console.error(`[render] ${stopped}:`, stderr?.slice(-800))
					return finish(new Error(`Render step failed: ${stopped}. Try exporting again.`))
				}
				console.error('[render] ffmpeg failed:', err?.message, stderr?.slice(-800))
				finish(new Error(`Render step failed: ${err?.message || 'ffmpeg error'}`))
			})
		live.add(command)
		command.run()
	})
}
