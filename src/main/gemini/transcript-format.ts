/**
 * Prompts and the line format for model-written transcripts. Pure, so tests
 * and scripts can use it without Electron or the Gemini client.
 */
import type { TranscriptItem } from './transcript-chunks'

/**
 * Language and script rules shared by both prompts. Without them a model
 * hearing Persian answers in romanised "Finglish", which no on-screen text
 * can be lifted from.
 */
export const SCRIPT_RULES = `- Write every word in the spoken language's own writing system: Persian, Arabic and Urdu in Arabic
  script, Russian in Cyrillic, Hindi in Devanagari, Chinese in Chinese characters, and so on.
  NEVER romanise or transliterate, and never translate. Loanwords keep the script the speaker's
  language normally uses for them.`

export const TIMING_RULES = `- Timestamps are measured from the start of THIS audio file. A line starts when its first word is
  spoken and ends when its last word ends — not when the previous line ends.
- Keep lines short: one sentence or less, at most about 10 seconds.
- Only write what is actually said. If you cannot make out a stretch, leave it out rather than guess.`

export const TRANSCRIPT_PROMPT = `Extract a detailed transcript from the provided audio file. 

The FIRST line of your answer is the main spoken language as a BCP-47 code, like this:
LANGUAGE: fa

Every other entry must be on a SINGLE LINE and strictly follow this format:
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
- **IMPORTANT**: Transcribe significant audio events (e.g., [Music], [Applause], [Laughter], [Silence]) in brackets.
${SCRIPT_RULES}
${TIMING_RULES}`

export const TRANSCRIPT_CORRECTION_PROMPT = `You are an expert transcriber. I am providing you with an audio file and an initial transcript (in custom line-based format) that was generated for it. 
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
   end of the audio.
7. Keep the text in the spoken language's own script — if the initial transcript is romanised
   (e.g. Persian written in Latin letters), rewrite it in the native script.
${SCRIPT_RULES}
${TIMING_RULES}`

/**
 * Normalizes a timestamp string to HH:MM:SS,mmm format.
 */
export function normalizeTimestamp(t: string): string {
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

/** The `LANGUAGE: xx` line the prompt asks for, if the model gave one. */
export function parseLanguageLine(text: string): string | undefined {
	const m = (text || '').match(/^\s*LANGUAGE:\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\s*$/m)
	return m ? m[1] : undefined
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


/** A letter of some script other than Latin (Arabic, Cyrillic, Devanagari…). */
const isOtherScriptLetter = (ch: string) => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)
const isLatinLetter = (ch: string) => /\p{Script=Latin}/u.test(ch)

/**
 * Words that mix Latin letters into another script — "می‌خam", "ترکیه‌am".
 * Speech-to-text sometimes romanises a suffix halfway through a Persian word;
 * no reader can use the result, and it never happens in real writing.
 * Returns each distinct broken word once, with the line it came from.
 */
export function findMixedScriptWords(items: { text: string }[]): { word: string; sentence: string }[] {
	const seen = new Map<string, string>()
	for (const item of items) {
		for (const word of (item.text || '').split(/\s+/)) {
			if (!word || seen.has(word)) continue
			const chars = [...word]
			if (chars.some(isOtherScriptLetter) && chars.some(isLatinLetter)) seen.set(word, item.text)
		}
	}
	return [...seen].map(([word, sentence]) => ({ word, sentence }))
}

export const MIXED_SCRIPT_FIX_PROMPT = `You repair speech-to-text output. Each numbered word below came out partly in Latin
letters inside a word of another script (for example Persian "می‌خam" for "می‌خوام"). Using the sentence it
came from, rewrite each word entirely in the script of its sentence, spelled the way the speaker said it.
Keep any punctuation attached to the word. Do not translate and do not change other words.
Reply with ONLY a JSON array of strings: the repaired words, in the same order, one per numbered word.`

export function buildMixedScriptRequest(broken: { word: string; sentence: string }[]): string {
	return broken.map((b, i) => `${i + 1}. word: ${b.word}\n   sentence: ${b.sentence}`).join('\n')
}

/** The model's repaired words, or null when the reply is unusable. A repair must itself be clean. */
export function parseMixedScriptFixes(text: string, broken: { word: string }[]): Map<string, string> | null {
	const body = (text || '').replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim()
	let parsed: unknown
	try { parsed = JSON.parse(body.slice(body.indexOf('['), body.lastIndexOf(']') + 1)) } catch { return null }
	if (!Array.isArray(parsed) || parsed.length !== broken.length) return null
	const fixes = new Map<string, string>()
	parsed.forEach((value, i) => {
		const fixed = typeof value === 'string' ? value.trim() : ''
		if (!fixed || /\s/.test(fixed)) return
		if (findMixedScriptWords([{ text: fixed }]).length) return
		fixes.set(broken[i].word, fixed)
	})
	return fixes
}

/** Swap repaired words into the text, and into the word timings when there are any. */
export function applyWordFixes<T extends { text: string; words?: { text: string }[] }>(items: T[], fixes: Map<string, string>): T[] {
	if (!fixes.size) return items
	return items.map((item) => {
		const text = (item.text || '').split(/(\s+)/).map((part) => fixes.get(part) ?? part).join('')
		const words = item.words?.map((w) => (fixes.has(w.text) ? { ...w, text: fixes.get(w.text)! } : w))
		return text === item.text && words === item.words ? item : { ...item, text, ...(words ? { words } : {}) }
	})
}
