/**
 * What the transcript is doing right now, in numbers a progress bar and a
 * status line can show. A long file is several windows, each cut, uploaded
 * and sent to the model; a single call can run for minutes, so the line also
 * carries how long the whole run has taken. A line whose clock moves is how a
 * person tells "working" from "stuck".
 */

/** Where one window is: its audio being cut, the upload, or the model call. */
export type WindowPhase = 'cutting' | 'uploading' | 'transcribing'

export interface TranscriptProgress {
	/** Windows finished. */
	done: number
	/** Windows in this run (1 when the file is sent whole). */
	total: number
	/** Phase of every window that has started and not finished. */
	active: WindowPhase[]
	/** After the windows: stitching and the script repair call. */
	finishing?: boolean
}

/** Share of a window already behind it, by phase. A call in flight is never counted as nearly done. */
const PHASE_CREDIT: Record<WindowPhase, number> = { cutting: 0.03, uploading: 0.1, transcribing: 0.2 }

/** The bar runs between these two while the windows are going; the step sets the ends. */
export const TRANSCRIPT_BAR_START = 10
export const TRANSCRIPT_BAR_END = 85

const PHASE_WORD: Record<WindowPhase, string> = {
	cutting: 'cutting', uploading: 'uploading', transcribing: 'transcribing'
}

/** "7 min", "45 s" — coarse on purpose; the line changes at most every few seconds. */
export function formatElapsed(seconds: number): string {
	const s = Math.max(0, Math.round(seconds))
	if (s < 90) return `${s} s`
	return `${Math.round(s / 60)} min`
}

/** Bar position for a progress report: finished windows plus a small credit for each one in flight. */
export function transcriptPercent(p: TranscriptProgress): number {
	if (p.total <= 0) return TRANSCRIPT_BAR_START
	const credit = p.active.reduce((sum, phase) => sum + PHASE_CREDIT[phase], 0)
	const fraction = Math.min(1, (Math.min(p.done, p.total) + credit) / p.total)
	return Math.round(TRANSCRIPT_BAR_START + (TRANSCRIPT_BAR_END - TRANSCRIPT_BAR_START) * fraction)
}

/** The row's status line for a progress report. */
export function describeTranscriptProgress(p: TranscriptProgress, elapsedSec: number): { status: string; percent: number } {
	const percent = transcriptPercent(p)
	const clock = formatElapsed(elapsedSec)
	if (p.finishing) return { status: `Joining the parts · ${clock}`, percent }

	const parts = p.total > 1 ? `${p.done} of ${p.total} parts done` : 'Sending the audio'
	const counts = new Map<WindowPhase, number>()
	for (const phase of p.active) counts.set(phase, (counts.get(phase) || 0) + 1)
	const doing = (['cutting', 'uploading', 'transcribing'] as WindowPhase[])
		.filter((phase) => counts.has(phase))
		.map((phase) => (p.total > 1 ? `${PHASE_WORD[phase]} ${counts.get(phase)}` : PHASE_WORD[phase]))
		.join(', ')
	return { status: `Transcribing: ${parts}${doing ? ` · ${doing}` : ''} · ${clock}`, percent }
}

/** How often the status line is refreshed with no news, so its clock keeps moving through a long call. */
export const TRANSCRIPT_HEARTBEAT_MS = 15_000

/**
 * Turns the transcript's progress reports into the step's status line and
 * bar. A long call reports nothing for minutes, so the last report is
 * repeated on a timer: the elapsed time on the line is what shows the
 * difference between a slow call and a stuck one. Call `stop` when done.
 */
export function trackTranscriptProgress(
	context: { updateStatus: (status: string, progress?: number) => Promise<void> | void },
	now: () => number = Date.now
): { onProgress: (progress: TranscriptProgress) => void; stop: () => void } {
	const startedAt = now()
	let last: TranscriptProgress | undefined
	const show = () => {
		if (!last) return
		const { status, percent } = describeTranscriptProgress(last, (now() - startedAt) / 1000)
		void context.updateStatus(status, percent)
	}
	const timer = setInterval(show, TRANSCRIPT_HEARTBEAT_MS)
	return {
		onProgress: (progress) => { last = progress; show() },
		stop: () => clearInterval(timer)
	}
}
