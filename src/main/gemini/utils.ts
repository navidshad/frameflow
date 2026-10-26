import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { GeminiAdapter } from './adapter'
import { settingsManager } from '../settings'
import { UsageRecord } from '../../shared/types'
import { extractAudioSegment, measureLoudness } from '../ffmpeg'
import type { TranscriptTiming } from '../../shared/types'
import {
	chunkCoverage, halveChunk, MIN_CHUNK_COVERAGE, MIN_RETRY_SPAN_SEC,
	secondsToTimestamp, sliceTranscriptForChunk, timestampToSeconds,
	type AudioChunk, type TranscriptItem
} from './transcript-chunks'
import { runPool } from './transcript-pool'
import type { TranscriptProgress, WindowPhase } from './transcript-progress'
import {
	assessTiming, findPauses, groupWordsIntoSegments, planWindowsAtPauses, snapStartsToOnsets, stitchWindows,
	type Pause, type TimedItem
} from './transcript-timing'

export type { TranscriptItem }

/**
 * Output ceiling for one transcription call. A 15-minute window of dense
 * speech is well under this; the point is to stop inheriting a model default
 * that silently truncates.
 */
const TRANSCRIPT_MAX_OUTPUT_TOKENS = 32_768

export {
	formatTranscript, parseLanguageLine, parseTranscript
} from './transcript-format'
import {
	applyWordFixes, buildMixedScriptRequest, findMixedScriptWords, formatTranscript, MIXED_SCRIPT_FIX_PROMPT,
	parseLanguageLine, parseMixedScriptFixes, parseTranscript, TRANSCRIPT_CORRECTION_PROMPT, TRANSCRIPT_PROMPT
} from './transcript-format'

/** Model ids served as dedicated speech-to-text (Interactions API, word timestamps). */
export function isTranscribeModel(model: string | undefined): boolean {
	return /transcribe/i.test(model || '')
}

/** Word-timestamp windows: well under the 30-minute limit with timestamps on. */
const WORD_WINDOW_TARGET_SEC = 20 * 60
const WORD_WINDOW_MAX_SEC = 25 * 60
/**
 * Word-model windows in flight at once. Each is its own upload and call, so a
 * long file takes about 1/N of the time; three stays inside the free tier's
 * request rate (the adapter waits out a named "retry in Ns" when it is hit).
 */
export const WORD_WINDOW_CONCURRENCY = 3
/**
 * Model-written timestamps drift with window length, so general models get
 * short windows. Each window restarts the clock at a known pause.
 */
const SEGMENT_WINDOW_TARGET_SEC = 120
const SEGMENT_WINDOW_MAX_SEC = 180
/** How far a start may move to reach an onset. Word times are measured, so barely. */
const SNAP_WINDOW_WORDS_SEC = 0.3
const SNAP_WINDOW_SEGMENTS_SEC = 1.5

/** One transcription call over one audio file (whole file or a single window). */
async function transcribeOne(
	adapter: GeminiAdapter,
	modelName: string,
	audioPath: string,
	audioDuration: number,
	priorTranscriptText: string | undefined,
	signal?: AbortSignal,
	languageHint?: string
): Promise<{ items: TranscriptItem[]; text: string; record: UsageRecord; finishReason?: string; language?: string }> {
	const fileUri = await adapter.uploadFile(audioPath, 'audio/mpeg')

	const hint = languageHint
		? `\nThe speech is in "${languageHint}". Write it in that language's own script.`
		: ''
	const userPrompt = priorTranscriptText
		? `Initial Transcript:\n${priorTranscriptText}${hint}`
		: `Generate the transcript for this audio.${hint}`
	const systemInstruction = priorTranscriptText
		? TRANSCRIPT_CORRECTION_PROMPT
		: TRANSCRIPT_PROMPT

	const { text, record, finishReason } = await adapter.generateTextFromFiles(
		modelName,
		userPrompt,
		[fileUri],
		systemInstruction,
		audioDuration,
		signal,
		{ maxOutputTokens: TRANSCRIPT_MAX_OUTPUT_TOKENS }
	)

	return { items: parseTranscript(text), text, record, finishReason, language: parseLanguageLine(text) }
}

const sumRecords = (records: UsageRecord[]): UsageRecord => ({
	usage: {
		promptTokens: records.reduce((s, r) => s + (r.usage?.promptTokens || 0), 0),
		candidatesTokens: records.reduce((s, r) => s + (r.usage?.candidatesTokens || 0), 0),
		thinkingTokens: records.reduce((s, r) => s + (r.usage?.thinkingTokens || 0), 0),
		totalTokens: records.reduce((s, r) => s + (r.usage?.totalTokens || 0), 0)
	},
	cost: records.reduce((s, r) => s + (r.cost || 0), 0)
})

const toTimed = (items: TranscriptItem[]): TimedItem[] =>
	items.map((it) => ({ start: timestampToSeconds(it.start), end: timestampToSeconds(it.end), text: it.text }))

const fromTimed = (items: TimedItem[]): TranscriptItem[] =>
	items.map((it) => ({
		start: secondsToTimestamp(it.start),
		end: secondsToTimestamp(it.end),
		text: it.text,
		...(it.words?.length ? { words: it.words } : {})
	}))

/** More than this and the transcript is romanised wholesale — a repair call is not the fix. */
const MAX_MIXED_SCRIPT_REPAIRS = 200

/**
 * Words that came back half in Latin letters ("می‌خam") are rewritten in the
 * script of their sentence by the clean-up model: one small text call, only
 * when there is something to fix. Word timings are kept. Any failure leaves
 * the words as they were.
 */
async function repairMixedScript(
	adapter: GeminiAdapter,
	items: TimedItem[],
	records: UsageRecord[],
	signal?: AbortSignal
): Promise<TimedItem[]> {
	const broken = findMixedScriptWords(items)
	if (!broken.length || broken.length > MAX_MIXED_SCRIPT_REPAIRS) return items
	const model = settingsManager.getModelSettings().selection['corrected-transcript']
	if (!model || isTranscribeModel(model)) return items
	try {
		// Instructions ride in the prompt: generateText's systemInstruction sits where
		// the SDK does not read it.
		const { text, record } = await adapter.generateText(
			model, `${MIXED_SCRIPT_FIX_PROMPT}\n\n${buildMixedScriptRequest(broken)}`, undefined, signal
		)
		records.push(record)
		const fixes = parseMixedScriptFixes(text, broken)
		if (!fixes) {
			console.warn(`[transcript] could not read the script repair for ${broken.length} word(s) — left as they were: ${text.slice(0, 160)}`)
			return items
		}
		console.log(`[transcript] rewrote ${fixes.size} of ${broken.length} half-romanised word(s) in their own script`)
		return applyWordFixes(items, fixes)
	} catch (error: any) {
		if (signal?.aborted) throw error
		console.warn('[transcript] script repair failed — words left as they were:', error?.message || error)
		return items
	}
}

/** Pauses measured from the audio. A failure only costs the snapping and the check. */
async function measurePauses(audioPath: string, signal?: AbortSignal): Promise<Pause[]> {
	try {
		return findPauses(await measureLoudness(audioPath, signal))
	} catch (error: any) {
		if (signal?.aborted) throw error
		console.warn('[transcript] could not measure pauses — timing will not be checked:', error?.message || error)
		return []
	}
}

/**
 * Extracts or corrects a transcript from an audio file using Gemini.
 *
 * With a transcribe model (the default) the words come back with measured
 * timestamps and segments are built from them. With a general model the model
 * writes segment times itself; those are kept honest by short windows cut at
 * pauses and by snapping starts to speech onsets. Either way the result is
 * scored against the pauses (see gemini/transcript-timing.ts).
 */
export async function extractTranscript(
	audioPath: string,
	audioDuration: number = 0,
	rawTranscriptText?: string,
	signal?: AbortSignal,
	onProgress?: (progress: TranscriptProgress) => void
): Promise<{ items: TranscriptItem[], rawResponseText: string, record: UsageRecord, timing: TranscriptTiming, model: string }> {
	const adapter = GeminiAdapter.create()
	const modelSettings = settingsManager.getModelSettings()

	const modelName = rawTranscriptText
		? modelSettings.selection['corrected-transcript']
		: modelSettings.selection['raw-transcript']

	const pauses = await measurePauses(audioPath, signal)
	const words = isTranscribeModel(modelName)
	const windows = planWindowsAtPauses(audioDuration, pauses, words
		? { targetSec: WORD_WINDOW_TARGET_SEC, maxSec: WORD_WINDOW_MAX_SEC }
		: { targetSec: SEGMENT_WINDOW_TARGET_SEC, maxSec: SEGMENT_WINDOW_MAX_SEC })
	// Unknown duration: one call over the whole file.
	if (!windows.length) windows.push({ index: 0, start: 0, end: audioDuration > 0 ? audioDuration : Infinity })

	const priorItems = rawTranscriptText && !words ? parseTranscript(rawTranscriptText) : []
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameflow-transcript-'))
	const perWindow: { chunk: AudioChunk; items: TimedItem[] }[] = []
	const responses: { start: number; text: string }[] = []
	const records: UsageRecord[] = []
	let language: string | undefined
	let segmentCounter = 0

	/** The window's own audio file: the source itself when there is one window. */
	const windowAudio = async (chunk: AudioChunk): Promise<{ file: string; temp: boolean }> => {
		if (windows.length === 1 && chunk.start === 0 && chunk.end >= (audioDuration || Infinity)) {
			return { file: audioPath, temp: false }
		}
		const file = path.join(workDir, `chunk-${segmentCounter++}.mp3`)
		await extractAudioSegment(audioPath, chunk.start, chunk.end - chunk.start, file, signal)
		return { file, temp: true }
	}

	// Where each window is, so the row can say what is happening, not just that something is.
	const activeWindows = new Map<number, WindowPhase>()
	let windowsDone = 0
	const report = (finishing = false) => onProgress?.({
		done: windowsDone, total: windows.length, active: [...activeWindows.values()], ...(finishing ? { finishing } : {})
	})
	const enter = (chunk: AudioChunk, phase: WindowPhase) => { activeWindows.set(chunk.index, phase); report() }
	const leave = (chunk: AudioChunk, finished: boolean) => {
		activeWindows.delete(chunk.index)
		if (finished) windowsDone++
		report()
	}

	// One window failing (a quota error, say) cancels the others through this,
	// so they stop their calls instead of spending them on a run that is lost.
	const runAbort = new AbortController()
	const onOuterAbort = () => runAbort.abort()
	if (signal?.aborted) runAbort.abort()
	else signal?.addEventListener('abort', onOuterAbort, { once: true })

	const runWordWindow = async (chunk: AudioChunk): Promise<void> => {
		if (runAbort.signal.aborted) throw new Error('Aborted')
		const span = chunk.end - chunk.start
		let finished = false
		enter(chunk, 'cutting')
		try {
			const { file, temp } = await windowAudio(chunk)
			try {
				enter(chunk, 'uploading')
				const uri = await adapter.uploadFile(file, 'audio/mpeg')
				enter(chunk, 'transcribing')
				const result = await adapter.transcribeWords(modelName, uri, Number.isFinite(span) ? span : 0, runAbort.signal)
				records.push(result.record)
				responses.push({ start: chunk.start, text: `# window ${chunk.start}s-${chunk.end}s\n${result.text}` })
				if (!result.words.length && result.text.trim()) {
					console.warn(`[transcript] window ${Math.round(chunk.start)}s came back with text but no word times`)
				}
				perWindow.push({ chunk, items: groupWordsIntoSegments(result.words) })
				finished = true
			} finally {
				if (temp) try { fs.unlinkSync(file) } catch { /* best effort */ }
			}
		} finally {
			leave(chunk, finished)
		}
	}

	/**
	 * Transcribe one window with a general model. If it comes back short —
	 * empty, cut off by the output ceiling, or reaching only part way through —
	 * split it and retry: a window that silently returns half its audio is how
	 * minutes go missing from the MIDDLE of a transcript.
	 */
	const runSegmentWindow = async (chunk: AudioChunk, canRetry: boolean): Promise<void> => {
		if (signal?.aborted) throw new Error('Aborted')
		const span = chunk.end - chunk.start
		const { file, temp } = await windowAudio(chunk)
		const prior = priorItems.length
			? formatTranscript(sliceTranscriptForChunk(priorItems, chunk))
			: undefined
		let result: Awaited<ReturnType<typeof transcribeOne>>
		try {
			result = await transcribeOne(adapter, modelName, file, Number.isFinite(span) ? span : 0, prior, signal, language)
		} finally {
			if (temp) try { fs.unlinkSync(file) } catch { /* best effort */ }
		}

		// The call is paid for either way — always bank the usage.
		records.push(result.record)
		responses.push({ start: chunk.start, text: `# window ${chunk.start}s-${chunk.end}s\n${result.text}` })
		language = language || result.language

		const cutOff = !!result.finishReason && result.finishReason !== 'STOP'
		const coverage = Number.isFinite(span) ? chunkCoverage(result.items, span) : 1
		const short = result.items.length === 0 || cutOff || coverage < MIN_CHUNK_COVERAGE

		if (short && canRetry && span > MIN_RETRY_SPAN_SEC) {
			console.warn(
				`[transcript] window ${Math.round(chunk.start)}s-${Math.round(chunk.end)}s came back ` +
				`${Math.round(coverage * 100)}% covered${cutOff ? ` (${result.finishReason})` : ''} — splitting and retrying`
			)
			const [first, second] = halveChunk(chunk)
			await runSegmentWindow(first, false)
			await runSegmentWindow(second, false)
			return
		}
		if (short) {
			console.warn(
				`[transcript] window ${Math.round(chunk.start)}s-${Math.round(chunk.end)}s is still incomplete ` +
				`(${Math.round(coverage * 100)}% covered) — that span will read as silence`
			)
		}
		perWindow.push({ chunk, items: toTimed(result.items) })
	}

	try {
		report()
		if (words) {
			await runPool(windows, WORD_WINDOW_CONCURRENCY, runWordWindow, () => runAbort.abort())
		} else {
			// General models carry the language forward from window to window: one at a time.
			for (const chunk of windows) {
				enter(chunk, 'transcribing')
				await runSegmentWindow(chunk, true)
				leave(chunk, true)
			}
		}
	} catch (error: any) {
		// Name the model that failed: settings may have changed since the run began.
		if (error && typeof error === 'object' && !error.model) error.model = modelName
		throw error
	} finally {
		signal?.removeEventListener('abort', onOuterAbort)
		try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* best effort */ }
	}
	report(true)

	const stitched = await repairMixedScript(adapter, stitchWindows(perWindow), records, signal)
	const { items, snapped } = snapStartsToOnsets(stitched, pauses, {
		windowSec: words ? SNAP_WINDOW_WORDS_SEC : SNAP_WINDOW_SEGMENTS_SEC,
		durationSec: audioDuration || undefined
	})
	// Scored on the engine's own times: snapped starts sit on onsets by construction.
	const timing = assessTiming(stitched, pauses, {
		durationSec: audioDuration || undefined,
		engine: words ? 'words' : 'segments',
		language,
		snapped,
		windows
	})
	if (timing.drift) {
		console.warn(
			`[transcript] timing does not follow the speech: ${Math.round(timing.alignedRatio * 100)}% of ` +
			`${timing.phraseStartsChecked} phrase starts sit on an onset (median offset ${timing.medianOnsetOffsetSec}s)`
		)
	}
	if (timing.silentTextAtSec.length) {
		console.warn(`[transcript] ${timing.silentTextAtSec.length} segment(s) have text over silence — likely invented`)
	}

	return {
		items: fromTimed(items),
		rawResponseText: responses.sort((a, b) => a.start - b.start).map((r) => r.text).join('\n\n'),
		record: sumRecords(records),
		timing,
		model: modelName
	}
}
