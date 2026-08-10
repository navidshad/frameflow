import { PipelineFunction } from '../index'
import { GeminiAdapter } from '../../gemini/adapter'
import { IntentResult } from '../../../shared/types'
import { TranscriptItem, formatTranscript } from '../../gemini/utils'
import * as ffmpegAdapter from '../../ffmpeg'
import fs from 'fs'

const INTENT_SYSTEM_INSTRUCTION = `
Model Role:
You are an AI assistant for a video editing tool. Your goal is to understand the user's intent based on their latest message, the conversation history, the video transcript, and optionally, a reference timeline and any attached images provided by the user.

Task:
You must decide between two types of actions:
1. "text": Conversational response. Use this for general questions, proposing a summary plan, proposing a thumbnail idea, or asking for final confirmation. This is the DEFAULT and preferred action.
2. "generate-timeline": Signal to actually build the video.
3. "generate-thumbnail": Signal to generate a thumbnail.

Reference Timeline (Edit Mode):
- If a "REFERENCE TIMELINE" is provided below, it means the user is currently editing an existing summary.
- Your goal is to decide whether to update/modify this timeline or just answer the user's question about it.
- If the user asks to "change", "add", "remove", "extend", or "refine" parts of it, trigger "generate-timeline".

Attached Images:
- If the user provides images (frames from the video or uploaded assets), they are likely intended as reference material for a thumbnail, cover, or as a specific moment they want included in the video summary.
- Use these images to better understand what the user is referring to (e.g., "make a cover like this").

Confirmation Rules (STRICT ENFORCEMENT):
- NEVER trigger "generate-timeline" for suggestive or planning phrases like "let's make a summary", "can you create a highlights clip", "how about a summary", or "I want to see the key moments", etc.
- For any of the above, use "text" to describe what you will include in the summary (e.g. "I will create a 30s summary focusing on [X].") and ask: "Shall I proceed with generating this video?".
- ONLY trigger "generate-timeline" if:
    a) The user gives a direct, unambiguous COMMAND including a duration (e.g., "Generate/Create a 30s video now").
    b) The user explicitly confirms a previously proposed VIDEO/SUMMARY idea (e.g., "Yes", "Go ahead", "Do it"). If the conversation history shows your last response was a summary proposal, interpret "Yes/Go ahead" as "generate-timeline".
    c) The user explicitly asks to MODIFY the existing REFERENCE TIMELINE (e.g., "Change the middle part to show X", "Make it longer").

Thumbnail Rules:
- If the user asks for a thumbnail (e.g., "Make a thumbnail", "Suggest a thumbnail", "How about a thumbnail for this video?"), your FIRST step must be to propose an idea using "type": "text".
- Propose a specific idea based on the video content (e.g., "I suggest a thumbnail showing the logo reveal at 00:45 with a 'New Product' text. Shall I generate it?").
- ONLY trigger "generate-thumbnail" if:
    a) The user explicitly confirms a previously proposed THUMBNAIL idea (e.g., "Yes", "Go ahead", "Do it", "Looks good", "cool", "coll"). If the conversation history shows your last response was a thumbnail proposal, interpret "Yes/Go ahead" as "generate-thumbnail".
    b) The user gives a direct, unambiguous COMMAND for a specific thumbnail (e.g., "Generate a thumbnail with a blue background and text 'Hello'").
    c) The user provides specific images and asks to "make a cover/thumbnail with these". In this case, you can trigger "generate-thumbnail" immediately as the intent is clear and visual reference is provided.
- If the user asks "Tell me about the video", provide a detailed text description in the chat and do NOT trigger generation.

Behavioral Guidelines:
- If "generate-timeline" is triggered, you must determine the desired duration in seconds.
  - If specified, use that.
  - If NOT specified, use a reasonable duration based on video length (default 30-60s) or the length of the reference timeline if it exists.

Respond ONLY with a JSON object following this schema:
{
  "type": "text" | "generate-timeline" | "generate-thumbnail",
  "content": "A detailed idea/prompt for the thumbnail (if generate-thumbnail) OR a description for timeline builder (if generate-timeline) OR the final text answer (if text)",
  "duration": number (only if type is "generate-timeline"),
  "selectedIndices": number[] (ONLY if type is "generate-thumbnail" and you want to use specific scenes from the video as reference. Indices are 0-based based on the ENRICHED TIMELINE SEGMENTS provided)
}

Specific rules for 'content' field:
- If type is 'text': This is the message shown directly to the user.
- If type is 'generate-timeline': This is a COMPREHENSIVE and DETAILED technical description for the timeline builder agent.
- If type is 'generate-thumbnail': This is a COMPREHENSIVE and DETAILED technical description for the thumbnail generator. Include visual elements, frames to extract (YOU MUST list specific timestamps in [HH:MM:SS] format for at least 2-3 relevant scenes), and any overlay text.
- CRITICAL: When editing an existing timeline or thumbnail, specify EXACTLY which parts to keep, remove, or replace. The goal is maximum consistency with the REFERENCE TIMELINE except for the requested changes. It will NOT be shown to the user. 'content' for 'generate-thumbnail' MUST be technical and precise.
- PERSON NAMES: DO NOT mention specific real-world names (e.g., 'Olga Loiek') in the 'content' field for 'generate-thumbnail'. Instead, refer to them using generic descriptors based on the reference frames, such as 'the speaker', 'the subject', 'the person in the video', or 'the main figure'. This is to avoid triggering safety/privacy filters. You can refer to 'Scene X' or 'Image Y' to point to specific people.
- IMAGE ACCESS RESTRICTION: If the system note indicates "IMAGE ACCESS DISABLED", you CANNOT return 'selectedIndices' or trigger visual generation actions that require specific project frames. In this case, use 'type': 'text' and ask the user to enable 'Smart Auto-References' (the blade icon).`

const INTENT_SCHEMA = {
	type: 'object',
	properties: {
		type: { type: 'string', enum: ['text', 'generate-timeline', 'generate-thumbnail'] },
		content: { type: 'string' },
		duration: { type: 'number' },
		selectedIndices: { 
			type: 'array', 
			items: { type: 'number' },
			description: 'Indices of scenes from the enriched timeline to be used as visual references for the thumbnail/cover.'
		}
	},
	required: ['type', 'content']
}

export const determineIntent: PipelineFunction = async (data, context) => {
	context.updateStatus('Analyzing your request...')

	// 1. Gather Video Context (Timeline Segments OR Transcript)
	let videoContextText = ''
	const sceneDescriptionsPath = context.preprocessing.sceneDescriptionsPath
	const transcriptPath = context.preprocessing.rawTranscriptPath

	if (sceneDescriptionsPath && fs.existsSync(sceneDescriptionsPath)) {
		// Use Enriched Timeline Segments as primary visual-first context
		const scenes = JSON.parse(fs.readFileSync(sceneDescriptionsPath, 'utf-8'));
		// The records carry startTime — `start`/`end` were never written, so every
		// line used to render as "[undefined - undefined]" into the prompt.
		videoContextText = `ENRICHED TIMELINE SEGMENTS (Scene Descriptions):\n` +
			scenes.map((s: any, idx: number) => `Scene ${idx+1} [${(s.startTime ?? 0).toFixed(1)}s]: ${s.description}`).join('\n');
	} else if (transcriptPath && fs.existsSync(transcriptPath)) {
		// Fallback to audio transcript if scenes are missing
		const transcript: TranscriptItem[] = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
		videoContextText = `AUDIO TRANSCRIPT:\n` + formatTranscript(transcript);
	}

	// 2. Technical Metadata
	const videoDuration = await ffmpegAdapter.getVideoDuration(context.videoPath)

	// 3. Format base timeline if available (edit mode)
	let baseTimelineContext = ''
	if (context.baseTimeline && Array.isArray(context.baseTimeline) && context.baseTimeline.length > 0) {
		baseTimelineContext = `
REFERENCE TIMELINE (The user is editing this):
${context.baseTimeline.map((s: any) => `• [${s.start} --> ${s.end}] (${s.duration.toFixed(1)}s): ${s.text}`).join('\n')}
`
	}

	// 4. Build Final User Prompt
	const userPrompt = `Video Duration: ${videoDuration}s

${videoContextText}

${baseTimelineContext}

Conversation History:
${context.context}

${context.autoUseImages || (context.attachedImages && context.attachedImages.length > 0) 
	? "[SYSTEM NOTE]: IMAGE ACCESS IS ENABLED. You can use project images as references and return 'selectedIndices'." 
	: "[SYSTEM NOTE]: IMAGE ACCESS IS DISABLED. You can see visual descriptions but cannot access actual image files. To perform visual tasks, ask the user to enable 'Smart Auto-References'."}
`

	// 5. Limit and Deduplicate Images (Base64 is expensive, limit to last 8)
	const uniqueImages = Array.from(new Set(context.attachedImages || []))
	const limitedImages = uniqueImages.slice(-8)

	try {
		const adapter = GeminiAdapter.create()
		const modelSettings = (await import('../../settings')).settingsManager.getModelSettings()
		const modelName = modelSettings.selection['intent']
		
		const { data: result, record } = await adapter.generateStructuredText<IntentResult>(
			modelName,
			userPrompt,
			INTENT_SCHEMA,
			INTENT_SYSTEM_INSTRUCTION,
			context.signal,
			limitedImages,
			{ includeThinking: true }
		)

		// Record usage immediately
		await context.recordUsage(record)

		if (context.signal.aborted) return;

		context.intentResult = result

		if (result.type === 'text') {
			context.finish(result.content)
		} else if (result.type === 'generate-thumbnail') {
			context.updateStatus(`Intent recognized: Preparing thumbnail: ${result.content.substring(0, 50)}...`)
			context.next(data)
		} else {
			context.updateStatus(`Intent recognized: Generating a ${result.duration}s video...`)
			context.next(data)
		}
	} catch (error) {
		if (!context.signal.aborted) {
			console.error('Error in determineIntent:', error)
		}
		// Fallback to timeline if intent analysis fails
		context.intentResult = { type: 'generate-timeline', content: 'Create a video highlighting key moments.', duration: 30 }
		context.next(data)
	}
}
