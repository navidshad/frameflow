/**
 * Chunking math for transcribing long audio.
 *
 * One Gemini call cannot transcribe an hour of speech: the response runs into
 * the model's output ceiling and simply stops, leaving a transcript that looks
 * well-formed but covers only the first N minutes (or, in the worse failure
 * mode, degenerates into a repeated line). So long audio is cut into windows,
 * transcribed separately, and stitched back with the timestamps re-based.
 *
 * Pure and dependency-free — no ffmpeg, no Gemini, no Electron — so the
 * arithmetic that decides where cuts land can be tested directly.
 */

export interface TranscriptItem {
	start: string
	end: string
	text: string
}

export interface AudioChunk {
	index: number
	/** Seconds into the ORIGINAL audio. */
	start: number
	end: number
}

/** Beyond this, one call is not reliable. */
export const CHUNK_TARGET_SEC = 900        // 15 min
/** Never leave a final sliver shorter than this — fold it into the previous chunk. */
export const CHUNK_MIN_TAIL_SEC = 120
/** Boundary items closer together than this are treated as the same line. */
export const BOUNDARY_DEDUPE_SEC = 1.5

export function timestampToSeconds(timestamp: string): number {
	const clean = (timestamp || '').trim().replace('.', ',')
	const [timePart, milliPart = '0'] = clean.split(',')
	const parts = timePart.split(':').map((p) => Number(p) || 0)
	let hh = 0, mm = 0, ss = 0
	if (parts.length === 3) [hh, mm, ss] = parts
	else if (parts.length === 2) [mm, ss] = parts
	else if (parts.length === 1) [ss] = parts
	const ms = Number(String(milliPart).padEnd(3, '0').slice(0, 3)) || 0
	return hh * 3600 + mm * 60 + ss + ms / 1000
}

export function secondsToTimestamp(seconds: number): string {
	const total = Math.max(0, seconds)
	const hh = Math.floor(total / 3600)
	const mm = Math.floor((total % 3600) / 60)
	const ss = Math.floor(total % 60)
	const ms = Math.round((total - Math.floor(total)) * 1000)
	const pad = (n: number, width = 2) => String(n).padStart(width, '0')
	// Rounding can carry to the next second; normalize rather than emit ",1000".
	if (ms === 1000) return secondsToTimestamp(Math.floor(total) + 1)
	return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(ms, 3)}`
}

/**
 * Windows covering [0, durationSec). Returns a single window for short audio so
 * the common case stays exactly one API call.
 */
export function planChunks(durationSec: number, chunkSec = CHUNK_TARGET_SEC): AudioChunk[] {
	if (!(durationSec > 0)) return []
	if (durationSec <= chunkSec) return [{ index: 0, start: 0, end: durationSec }]

	const chunks: AudioChunk[] = []
	let start = 0
	while (start < durationSec) {
		let end = Math.min(start + chunkSec, durationSec)
		// Absorb a too-short tail instead of making a chunk out of it.
		if (durationSec - end < CHUNK_MIN_TAIL_SEC) end = durationSec
		chunks.push({ index: chunks.length, start, end })
		start = end
	}
	return chunks
}

/**
 * Re-base one chunk's items onto the original timeline and discard anything
 * outside its window — models sometimes keep numbering past the audio they
 * were given, which would otherwise collide with the next chunk.
 */
export function rebaseChunkItems(items: TranscriptItem[], chunk: AudioChunk): TranscriptItem[] {
	const span = chunk.end - chunk.start
	const out: TranscriptItem[] = []
	for (const item of items) {
		const start = timestampToSeconds(item.start)
		const end = timestampToSeconds(item.end)
		if (!(end > start)) continue
		if (start > span + 1) continue
		out.push({
			start: secondsToTimestamp(chunk.start + start),
			end: secondsToTimestamp(chunk.start + Math.min(end, span)),
			text: item.text
		})
	}
	return out
}

const normalize = (text: string) => (text || '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Stitch per-chunk results: order by time and drop a line repeated across a
 * chunk seam (the same words re-transcribed at nearly the same moment).
 */
export function mergeChunkTranscripts(perChunk: TranscriptItem[][]): TranscriptItem[] {
	const all = perChunk.flat().sort((a, b) => timestampToSeconds(a.start) - timestampToSeconds(b.start))
	const merged: TranscriptItem[] = []
	for (const item of all) {
		const previous = merged[merged.length - 1]
		if (
			previous &&
			normalize(previous.text) === normalize(item.text) &&
			Math.abs(timestampToSeconds(previous.start) - timestampToSeconds(item.start)) <= BOUNDARY_DEDUPE_SEC
		) continue
		merged.push(item)
	}
	return merged
}

/**
 * The slice of an existing transcript that covers one chunk, re-based to
 * chunk-relative time — what the correction pass needs as its starting point.
 */
export function sliceTranscriptForChunk(items: TranscriptItem[], chunk: AudioChunk): TranscriptItem[] {
	const out: TranscriptItem[] = []
	for (const item of items) {
		const start = timestampToSeconds(item.start)
		const end = timestampToSeconds(item.end)
		if (end <= chunk.start || start >= chunk.end) continue
		out.push({
			start: secondsToTimestamp(Math.max(0, start - chunk.start)),
			end: secondsToTimestamp(Math.min(end, chunk.end) - chunk.start),
			text: item.text
		})
	}
	return out
}
