import { GeminiAdapter } from './adapter'
import { settingsManager } from '../settings'
import { UsageRecord } from '../../shared/types'

export interface TranscriptItem {
	start: string
	end: string
	text: string
}

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

/**
 * Extracts or corrects a transcript from an audio file using Gemini.
 */
export async function extractTranscript(
	audioPath: string,
	audioDuration: number = 0,
	rawTranscriptText?: string,
	signal?: AbortSignal
): Promise<{ items: TranscriptItem[], rawResponseText: string, record: UsageRecord }> {
	const adapter = GeminiAdapter.create()
	const modelSettings = settingsManager.getModelSettings()

	const modelName = rawTranscriptText
		? modelSettings.selection['corrected-transcript']
		: modelSettings.selection['raw-transcript']

	const fileUri = await adapter.uploadFile(audioPath, 'audio/mpeg')

	const userPrompt = rawTranscriptText
		? `Initial Transcript:\n${rawTranscriptText}`
		: 'Generate the transcript for this audio.'

	const systemInstruction = rawTranscriptText
		? TRANSCRIPT_CORRECTION_PROMPT
		: TRANSCRIPT_PROMPT

	const { text, record } = await adapter.generateTextFromFiles(
		modelName,
		userPrompt,
		[fileUri],
		systemInstruction,
		audioDuration,
		signal
	)

	return {
		items: parseTranscript(text),
		rawResponseText: text,
		record
	}
}
