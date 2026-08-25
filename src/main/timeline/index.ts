import { TimelineSegment, EnrichedTimelineSegment, UsageRecord } from '../../shared/types'
import { srtToSeconds } from '../../shared/timeline'
import { TranscriptItem } from '../gemini/utils'
import { GeminiAdapter } from '../gemini/adapter'

export interface GenerateTimelineOptions {
    userExpectation: string;
    allSegments: EnrichedTimelineSegment[];
    targetDuration: number;
    baseTimeline?: EnrichedTimelineSegment[];
    modelName: string;
    mode: 'new' | 'edit';
    onUpdateStatus?: (status: string) => void;
    onRecordUsage?: (record: UsageRecord) => void;
    signal?: AbortSignal;
}


export async function generateTimeline(options: GenerateTimelineOptions): Promise<EnrichedTimelineSegment[]> {
    const {
        userExpectation,
        allSegments,
        targetDuration,
        onUpdateStatus,
        onRecordUsage,
        baseTimeline = [],
        modelName,
        mode,
        signal
    } = options;

    const fullTranscriptText = formatEnrichedTranscript(allSegments);
    const geminiAdapter = GeminiAdapter.create();


    if (mode === 'edit') {
        return editTimeline({
            userExpectation,
            allSegments,
            fullTranscriptText,
            targetDuration,
            baseTimeline,
            geminiAdapter,
            modelName,
            onUpdateStatus,
            onRecordUsage,
            signal
        });
    } else {
        return generateNewTimeline({
            userExpectation,
            allSegments,
            fullTranscriptText,
            targetDuration,
            geminiAdapter,
            modelName,
            onUpdateStatus,
            onRecordUsage,
            baseTimeline,
            signal
        });
    }
}

async function editTimeline(options: {
    userExpectation: string;
    allSegments: EnrichedTimelineSegment[];
    fullTranscriptText: string;
    targetDuration: number;
    baseTimeline: EnrichedTimelineSegment[];
    geminiAdapter: GeminiAdapter;
    modelName: string;
    onUpdateStatus?: (status: string) => void;
    onRecordUsage?: (record: UsageRecord) => void;
    signal?: AbortSignal;
}): Promise<EnrichedTimelineSegment[]> {

    const {
        userExpectation,
        allSegments,
        fullTranscriptText,
        targetDuration,
        baseTimeline,
        geminiAdapter,
        modelName,
        onUpdateStatus,
        onRecordUsage,
        signal
    } = options;

    onUpdateStatus?.(`Editing timeline in one-shot...`);

    const formattedCurrentTimeline = baseTimeline.length > 0
        ? baseTimeline.map(s => `• Index ${s.index}: ${s.duration.toFixed(1)}s duration, ${s.text}`).join('\n')
        : '• empty';

    const systemInstruction = `
You are a video editor assistant.
Your task is to EDIT an existing video timeline based on the user's technical request.
You are provided with the FULL transcript and the CURRENT timeline.

The transcript includes BOTH visual descriptions and audio captions for each segment.
Each segment is exactly one index (starting from 1).

Format per segment:
INDEX: [START - END] | Visual: Scene description | Audio: Transcript text

Strict Rules for Editing:
1. MAXIMAL CONSISTENCY: Do NOT change segments from the CURRENT timeline unless the user's request explicitly requires it.
2. PRESERVE ORDER: Maintain the existing sequence of segments as much as possible.
3. MINIMAL CHANGES: If a user asks to add something, keep the rest of the timeline identical. If they ask to remove something, only remove that specific part.
4. ONE-SHOT RESULT: Return the COMPLETE list of indices for the NEW version of the timeline.
5. RESPECT DURATION: The total duration of the NEW timeline must be close to the Target Duration if specified.
6. VISUAL CONTEXT: Use the "Visual" part to understand the scene content even if the "Audio" is [Silence].
7. AVOID HUGE SEGMENTS: If a single segment is longer than 30s and doesn't contain essential audio, avoid picking it unless necessary.

Return ONLY a JSON array of indices (integers) of the segments that should make up the NEW timeline, e.g. [1, 5, 8].
Indices refer to the line numbers (starting at 1) of the FULL transcript.
Do not include any other text.

`;

    const prompt = `
User Editing Request: ${userExpectation}
Target Duration: ${targetDuration} seconds

-----------------
FULL transcript:
${fullTranscriptText}
-----------------

CURRENT timeline:
${formattedCurrentTimeline}

-----------------
Task: Provide a list of indices representing the new timeline after applying the user's edits.
`;

    try {
        const { data: indices, record } = await geminiAdapter.generateStructuredText<number[]>(
            modelName,
            prompt,
            INDICES_SCHEMA,
            systemInstruction,
            signal
        );
        console.log(`Gemini response (Edit Mode):`, indices);

        // Record usage for the edit call
        onRecordUsage?.(record);
        const newTimeline: EnrichedTimelineSegment[] = [];

        for (const idx of indices) {
            const segmentIndex = idx - 1;
            if (segmentIndex >= 0 && segmentIndex < allSegments.length) {
                const originalSegment = allSegments[segmentIndex];
                const duration = calculateDuration(originalSegment.start, originalSegment.end);
                newTimeline.push({
                    index: idx,
                    start: originalSegment.start,
                    end: originalSegment.end,
                    text: originalSegment.text,
                    visual: originalSegment.visual,
                    duration: duration
                });
            }
        }
        return newTimeline;
    } catch (error) {
        console.error("Error in editTimeline:", error);
        onUpdateStatus?.(`Error in AI generation: ${error instanceof Error ? error.message : String(error)}`);
        return baseTimeline;
    }
}

async function generateNewTimeline(options: {
    userExpectation: string;
    allSegments: EnrichedTimelineSegment[];
    fullTranscriptText: string;
    targetDuration: number;
    geminiAdapter: GeminiAdapter;
    modelName: string;
    onUpdateStatus?: (status: string) => void;
    onRecordUsage?: (record: UsageRecord) => void;
    baseTimeline?: EnrichedTimelineSegment[];
    signal?: AbortSignal;
}): Promise<EnrichedTimelineSegment[]> {

    const {
        userExpectation,
        allSegments,
        fullTranscriptText,
        targetDuration,
        geminiAdapter,
        modelName,
        onUpdateStatus,
        onRecordUsage,
        baseTimeline = [],
        signal
    } = options;

    const currentShorterTimeline: EnrichedTimelineSegment[] = [...baseTimeline];
    let currentDuration = calculateTotalDuration(currentShorterTimeline);

    let iterationCount = 0;
    const MAX_ITERATIONS = 20; // Safety break

    const systemInstruction = `
You are a video editor assistant.
Your task is to select the next best segments from the full transcript to build a shorter video timeline based on the user's request.

The transcript includes BOTH visual descriptions and audio captions for each segment.
Each segment is exactly one index (starting from 1).

Format per segment:
INDEX: [START - END] | Visual: Scene description | Audio: Transcript text

IMPORTANT: Selection Logic
1. CHRONOLOGICAL ORDER: Unless the user explicitly asks for a non-linear narrative (e.g. "start with the ending", "flashback"), you MUST select segments that appear later in the timeline than the previous ones.
2. GRADUAL PROGRESSION: The story line should be kept based on timing, and do not mix times. Ideally select the next best segment that continues the flow naturally.
3. VISUAL CONTEXT: Use the "Visual" part to understand the scene content even if the "Audio" is [Silence]. Use these segments to bridge gaps or set the scene.
4. AVOID HUGE SEGMENTS: Do NOT pick a single segment that is longer than the Target Duration or consumes most of it (e.g. >30s) unless strictly required by the user's request.

Return ONLY a JSON array of indices (integers) of the selected segments, e.g. [1, 5, 8].
Indices refer to the line numbers (starting at 1) of the FULL transcript.
Do not include any other text.

`;

    while (currentDuration < targetDuration && iterationCount < MAX_ITERATIONS) {
        if (signal?.aborted) {
            console.log('[TIMELINE] Aborting generation loop - signal triggered.')
            throw new Error('Timeline generation aborted by user')
        }
        iterationCount++;
        onUpdateStatus?.(`Iteration ${iterationCount} - Duration: ${currentDuration.toFixed(1)}s / ${targetDuration}s`);

        const formattedCurrentTimeline = currentShorterTimeline.length > 0
            ? currentShorterTimeline.map(s => `• ${s.duration.toFixed(1)}s duration, ${s.text}`).join('\n')
            : '• empty';

        const prompt = `
User Request: ${userExpectation}
Target Duration: ${targetDuration} seconds

-----------------
Full transcript:
${fullTranscriptText}
-----------------

Current built timeline (${currentDuration.toFixed(1)}s):
${formattedCurrentTimeline}

-----------------
Task: Pick the next 3 segments to add to the timeline.
`;

        try {
            const { data: indices, record } = await geminiAdapter.generateStructuredText<number[]>(
                modelName,
                prompt,
                INDICES_SCHEMA,
                systemInstruction,
                signal
            );
            
            // Record usage IMMEDIATELY after call finishes, before any abort checks
            onRecordUsage?.(record);

            console.log(`Gemini response (Iteration ${iterationCount}):`, indices);

            if (indices.length === 0) {
                console.warn("No indices returned from Gemini, stopping loop.");
                break;
            }

            let addedCount = 0;
            for (const idx of indices) {
                const segmentIndex = idx - 1;

                if (segmentIndex >= 0 && segmentIndex < allSegments.length) {
                    const originalSegment = allSegments[segmentIndex];
                    const alreadyExists = currentShorterTimeline.some(s => s.index === idx);
                    if (!alreadyExists) {
                        const duration = calculateDuration(originalSegment.start, originalSegment.end);
                        currentShorterTimeline.push({
                            index: idx,
                            start: originalSegment.start,
                            end: originalSegment.end,
                            text: originalSegment.text,
                            visual: originalSegment.visual,
                            duration: duration
                        });
                        addedCount++;
                    }
                }
            }

            if (addedCount === 0) {
                console.warn("Gemini returned indices but none were valid or new. Stopping to avoid infinite loop.");
                break;
            }

            currentDuration = calculateTotalDuration(currentShorterTimeline);

        } catch (error) {
            if (signal?.aborted) throw new Error('Timeline generation aborted by user')
            console.error("Error in generateNewTimeline iteration:", error);
            onUpdateStatus?.(`Error in AI generation: ${error instanceof Error ? error.message : String(error)}`);
            break;
        }
    }

    return currentShorterTimeline;
}

function calculateDuration(start: string, end: string): number {
    return srtToSeconds(end) - srtToSeconds(start)
}

function calculateTotalDuration(segments: TimelineSegment[]): number {
    return segments.reduce((acc, curr) => acc + curr.duration, 0);
}

function formatEnrichedTranscript(items: EnrichedTimelineSegment[]): string {
    return items.map((item) => {
        const duration = item.duration.toFixed(1);
        return `${item.index}: [${item.start} - ${item.end}] (${duration}s) | Visual: ${item.visual} | Audio: ${item.text}`
    }).join('\n')
}


/**
 * JSON schema that forces Gemini to return a plain array of segment indices.
 */
const INDICES_SCHEMA = {
    type: 'ARRAY',
    items: { type: 'INTEGER' }
};