import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { GeminiAdapter } from './adapter'
import { settingsManager } from '../settings'
import { UsageRecord } from '../../shared/types'
import { extractAudioSegment } from '../ffmpeg'
import {
	chunkCoverage, halveChunk, mergeChunkTranscripts, MIN_CHUNK_COVERAGE, MIN_RETRY_SPAN_SEC,
	planChunks, rebaseChunkItems, sliceTranscriptForChunk,
	type AudioChunk, type TranscriptItem
} from './transcript-chunks'

export type { TranscriptItem }

/**
 * Output ceiling for one transcription call. A 15-minute window of dense
 * speech is well under this; the point is to stop inheriting a model default
 * that silently truncates.
 */
const TRANSCRIPT_MAX_OUTPUT_TOKENS = 32_768

const TRANSCRIPT_PROMPT = `Extract a detailed transcript from the provided audio file. 

Each entry must be on a SINGLE LINE and strictly follow this format:
from-timestamp , to-timestamp - Caption segment text

Example:
00:00:01,000 , 00:00:05,000 - Text content here.
00:00:05,000 , 00:00:10,000 - [Music playing]

Rules:
- Respond ONLY with the transcript content.
- Each line represents exactly one segment.
- Use HH:MM:SS,mmm format for timestamps.
- Use a single comma (with spaces around it) to separate 'from' and 'to' timestamps.
- Use a single hyphen (with spaces around it) to separate the timestamps from the text.
- Do not include any preamble, conversational text, or markdown code blocks.
- **IMPORTANT**: Transcribe significant audio events (e.g., [Music], [Applause], [Laughter], [Silence]) in brackets.`

const TRANSCRIPT_CORRECTION_PROMPT = `You are an expert transcriber. I am providing you with an audio file and an initial transcript (in custom line-based format) that was generated for it. 
Your task is to review the transcript against the audio and correct any errors (mishearings, missing words, incorrect timestamps).

Rules:
1. Respond ONLY with the FULL corrected transcript in the same format:
from-timestamp , to-timestamp - Caption segment text
2. Each entry must be on its own line.
3. Do not include any preamble, conversational text, or markdown code blocks.
4. **CRITICAL**: Preserve all audio event markers (e.g., [Music], [Applause]) unless they are clearly incorrect.
5. **REPETITION LOOPS**: the initial transcript may contain a stretch where the SAME sentence repeats
   dozens or hundreds of times. That is a transcription failure, not real speech. Ignore what the initial
   transcript claims for that stretch, listen to the audio, and write what is actually said. If the audio
   there really is non-speech, emit a single event marker (e.g. [Music], [Silence]) covering the span
   instead of repeating a line.
6. Timestamps must be strictly increasing and must never overlap the previous segment or run past the
   end of the audio.`

/**
 * Normalizes a timestamp string to HH:MM:SS,mmm format.
 */
function normalizeTimestamp(t: string): string {
	const clean = t.trim().replace('.', ',')
	const [timePart, milliPart = '000'] = clean.split(',')

	const parts = timePart.split(':').map(Number)
	let hh = 0, mm = 0, ss = 0

	if (parts.length === 3) {
		[hh, mm, ss] = parts
	} else if (parts.length === 2) {
		[mm, ss] = parts
	} else if (parts.length === 1) {
		ss = parts[0]
	}

	const pad = (n: number, z = 2) => n.toString().padStart(z, '0')
	const ms = milliPart.padEnd(3, '0').substring(0, 3)

	return `${pad(hh)}:${pad(mm)}:${pad(ss)},${ms}`
}

/**
 * Parses custom line-based transcript text into TranscriptItem array.
 * Format: from-timestamp , to-timestamp - Caption segment text
 */
export function parseTranscript(text: string): TranscriptItem[] {
	const items: TranscriptItem[] = []
	let cleanText = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim()
	const allLines = cleanText.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')

	// Regex to match: TIMESTAMP , TIMESTAMP - TEXT
	// Groups: 1=start, 2=end, 3=text
	const lineRegex = /^((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*,\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-\s*(.*)$/

	for (const line of allLines) {
		const match = line.match(lineRegex)
		if (match) {
			const start = normalizeTimestamp(match[1])
			const end = normalizeTimestamp(match[2])
			const segmentText = match[3].trim()
			items.push({ start, end, text: segmentText })
		}
	}
	return items
}

/**
 * Generates custom line-based transcript text from TranscriptItem array.
 * Format: from-timestamp , to-timestamp - Caption segment text
 */
export function formatTranscript(items: TranscriptItem[]): string {
	return items.map((item) => {
		const start = normalizeTimestamp(item.start)
		const end = normalizeTimestamp(item.end)
		return `${start} , ${end} - ${item.text}`
	}).join('\n')
}

/** One transcription call over one audio file (whole file or a single window). */
async function transcribeOne(
	adapter: GeminiAdapter,
	modelName: string,
	audioPath: string,
	audioDuration: number,
	priorTranscriptText: string | undefined,
	signal?: AbortSignal
): Promise<{ items: TranscriptItem[]; text: string; record: UsageRecord; finishReason?: string }> {
	const fileUri = await adapter.uploadFile(audioPath, 'audio/mpeg')

	const userPrompt = priorTranscriptText
		? `Initial Transcript:\n${priorTranscriptText}`
		: 'Generate the transcript for this audio.'
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

	return { items: parseTranscript(text), text, record, finishReason }
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

/**
 * Extracts or corrects a transcript from an audio file using Gemini.
 *
 * Audio longer than one window is transcribed in sequential windows and
 * stitched back together: a single call over an hour of speech hits the
 * model's output ceiling and returns a transcript that stops partway through
 * (or degenerates into one repeated line) with no error to notice.
 */
export async function extractTranscript(
	audioPath: string,
	audioDuration: number = 0,
	rawTranscriptText?: string,
	signal?: AbortSignal,
	onProgress?: (done: number, total: number) => void
): Promise<{ items: TranscriptItem[], rawResponseText: string, record: UsageRecord }> {
	const adapter = GeminiAdapter.create()
	const modelSettings = settingsManager.getModelSettings()

	const modelName = rawTranscriptText
		? modelSettings.selection['corrected-transcript']
		: modelSettings.selection['raw-transcript']

	const chunks = planChunks(audioDuration)

	// Short audio (or unknown duration): exactly one call, as before.
	if (chunks.length <= 1) {
		onProgress?.(0, 1)
		const single = await transcribeOne(adapter, modelName, audioPath, audioDuration, rawTranscriptText, signal)
		onProgress?.(1, 1)
		return { items: single.items, rawResponseText: single.text, record: single.record }
	}

	const priorItems = rawTranscriptText ? parseTranscript(rawTranscriptText) : []
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameflow-transcript-'))
	const perChunk: TranscriptItem[][] = []
	const responses: string[] = []
	const records: UsageRecord[] = []

	let segmentCounter = 0

	/**
	 * Transcribe one window. If it comes back short — empty, cut off by the
	 * output ceiling, or reaching only part way through — split it and retry.
	 * A window that silently returns half its audio is how minutes go missing
	 * from the MIDDLE of a transcript, where a trailing-coverage check can
	 * never see them.
	 */
	const runWindow = async (chunk: AudioChunk, canRetry: boolean): Promise<void> => {
		if (signal?.aborted) throw new Error('Aborted')
		const span = chunk.end - chunk.start
		const segmentPath = path.join(workDir, `chunk-${segmentCounter++}.mp3`)
		await extractAudioSegment(audioPath, chunk.start, span, segmentPath, signal)

		const prior = priorItems.length
			? formatTranscript(sliceTranscriptForChunk(priorItems, chunk))
			: undefined

		const result = await transcribeOne(adapter, modelName, segmentPath, span, prior, signal)
		try { fs.unlinkSync(segmentPath) } catch { /* best effort */ }

		// The call is paid for either way — always bank the usage.
		records.push(result.record)
		responses.push(`# window ${chunk.start}s-${chunk.end}s\n${result.text}`)

		const cutOff = !!result.finishReason && result.finishReason !== 'STOP'
		const coverage = chunkCoverage(result.items, span)
		const short = result.items.length === 0 || cutOff || coverage < MIN_CHUNK_COVERAGE

		if (short && canRetry && span > MIN_RETRY_SPAN_SEC) {
			console.warn(
				`[transcript] window ${Math.round(chunk.start)}s-${Math.round(chunk.end)}s came back ` +
				`${Math.round(coverage * 100)}% covered${cutOff ? ` (${result.finishReason})` : ''} — splitting and retrying`
			)
			const [first, second] = halveChunk(chunk)
			await runWindow(first, false)
			await runWindow(second, false)
			return
		}

		if (short) {
			console.warn(
				`[transcript] window ${Math.round(chunk.start)}s-${Math.round(chunk.end)}s is still incomplete ` +
				`(${Math.round(coverage * 100)}% covered) — that span will read as silence`
			)
		}
		perChunk.push(rebaseChunkItems(result.items, chunk))
	}

	try {
		for (const chunk of chunks) {
			onProgress?.(chunk.index, chunks.length)
			await runWindow(chunk, true)
		}
	} finally {
		try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* best effort */ }
	}

	onProgress?.(chunks.length, chunks.length)
	return {
		items: mergeChunkTranscripts(perChunk),
		rawResponseText: responses.join('\n\n'),
		record: sumRecords(records)
	}
}
