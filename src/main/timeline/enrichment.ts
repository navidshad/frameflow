import { TranscriptItem } from '../gemini/utils'
import { EnrichedTimelineSegment } from '../../shared/types'
import { srtToSeconds as timeToSeconds } from '../../shared/timeline'

export interface SceneDescription {
	index: number
	startTime: number
	description: string
}

const MIN_GAP_DURATION = 0.5 // Minimum gap to insert a dedicated visual-only segment
const MAX_GAP_CHUNK_DURATION = 15.0 // Maximum duration for a single silence segment

/**
 * Enriches the transcript by merging visual scene descriptions into every segment.
 * Ensures that even audio segments have visual context, and gaps are filled with visual-only segments.
 */
export function enrichTranscriptWithScenes(
	transcript: TranscriptItem[],
	sceneDescriptions: SceneDescription[],
	totalDuration: number
): EnrichedTimelineSegment[] {
	// 1. Convert transcript times to seconds and sort
	const sortedTranscript = [...transcript].sort((a, b) => timeToSeconds(a.start) - timeToSeconds(b.start))
	const enrichedItems: EnrichedTimelineSegment[] = []

	// 2. Helper to find relevant scene description for a timestamp
	const getSceneForTime = (time: number): string => {
		let bestScene: SceneDescription | null = null
		for (const scene of sceneDescriptions) {
			if (scene.startTime <= time) {
				if (!bestScene || scene.startTime > bestScene.startTime) {
					bestScene = scene
				}
			}
		}
		return bestScene ? bestScene.description : "No visual description available."
	}

	// Helper to add split gap segments
	const addGapSegments = (gapStart: number, gapEnd: number) => {
		let currentStart = gapStart
		while (currentStart < gapEnd) {
			const currentEnd = Math.min(currentStart + MAX_GAP_CHUNK_DURATION, gapEnd)
			const midPoint = currentStart + (currentEnd - currentStart) / 2
			
			enrichedItems.push({
				index: currentIndex++,
				start: secondsToTime(currentStart),
				end: secondsToTime(currentEnd),
				duration: currentEnd - currentStart,
				text: "[Silence]",
				visual: getSceneForTime(midPoint)
			})
			currentStart = currentEnd
		}
	}

	// 3. Iterate transcript and merge with scenes
	let previousEnd = 0.0
	let currentIndex = 1

	for (const item of sortedTranscript) {
		const start = timeToSeconds(item.start)
		const end = timeToSeconds(item.end)

		// Check for significant gap before this transcript item
		if (start - previousEnd > MIN_GAP_DURATION) {
			addGapSegments(previousEnd, start)
		}

		// Process the transcript item
		const itemMidPoint = start + (end - start) / 2
		enrichedItems.push({
			index: currentIndex++,
			start: item.start,
			end: item.end,
			duration: end - start,
			text: item.text,
			visual: getSceneForTime(itemMidPoint)
		})

		previousEnd = end
	}

	// 4. Check for trailing gap
	if (totalDuration - previousEnd > MIN_GAP_DURATION) {
		addGapSegments(previousEnd, totalDuration)
	}

	return enrichedItems
}


// Helpers
// timeToSeconds is srtToSeconds from shared/timeline — see the import above.

function secondsToTime(totalSeconds: number): string {
	const hh = Math.floor(totalSeconds / 3600)
	const mm = Math.floor((totalSeconds % 3600) / 60)
	const ss = Math.floor(totalSeconds % 60)
	const ms = Math.round((totalSeconds % 1) * 1000)

	const pad = (n: number, z = 2) => n.toString().padStart(z, '0')
	return `${pad(hh)}:${pad(mm)}:${pad(ss)},${ms.toString().padStart(3, '0')}`
}
