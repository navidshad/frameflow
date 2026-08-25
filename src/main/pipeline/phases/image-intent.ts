import { PipelineFunction } from '../index'
import { GeminiAdapter } from '../../gemini/adapter'
import fs from 'fs'
import { IntentResult } from '../../../shared/types'
import { settingsManager } from '../../settings'

const IMAGE_INTENT_SYSTEM_INSTRUCTION = `
Model Role:
You are an AI assistant for a creative image editor. Your goal is to understand the user's intent based on their latest message, the conversation history, the detailed textual descriptions of all images provided in the collection, and optionally, any attached images provided by the user.

Task:
You must decide between three types of actions:
1. "text": Conversational response. Use this for general questions, proposing a creative idea, or asking for final confirmation.
2. "generate-image": Signal to actually generate a new image based on the collection.
3. "generate-thumbnail": Same as generate-image, but the user wants a VIDEO THUMBNAIL / cover art / poster frame — a high-impact promotional still. Choose this whenever the request mentions a thumbnail, cover, poster or YouTube-style preview image.

Data Provided:
- COLLECTION: A JSON object mapping file paths to detailed descriptions of those images.
- PROMPT: The user's request.
- ATTACHED IMAGES: (Optional) Actual images provided by the user in the current message or history.

Attached Images:
- If the user provides images, they are likely intended as reference material for the generation (e.g., "make something in this style", "mix this image with my collection").
- Use these images to better understand what the user is referring to.

Rules (STRICT ENFORCEMENT):
- NEVER trigger "generate-image" or "generate-thumbnail" if the request is ambiguous.
- ONLY trigger a generation action if:
    a) The user gives a direct, unambiguous COMMAND.
    b) The user explicitly confirms a previously proposed creative idea.
- If a generation action is triggered, you must:
    a) Select the SPECIFIC images from the COLLECTION that are relevant to the request.
    b) Create a DETAILED technical prompt for a creative image generator (like Gemini Image 3). 
    c) This prompt should specify style, composition, lighting, and how to merge the elements from the selected images AND any provided ATTACHED IMAGES.
    d) PERSON NAMES: DO NOT mention specific real-world names (e.g., 'Olga Loiek') in the 'content' field. Instead, refer to them using generic descriptors based on the images, such as 'the speaker', 'the subject', 'the person in the video', or 'the main figure'. This is to avoid triggering safety/privacy filters. You can refer to 'Image X' or 'Image index Y' to point to specific people.
    e) IMAGE ACCESS RESTRICTION: If the system note indicates "IMAGE ACCESS DISABLED", you CANNOT return 'selectedIndices' or trigger visual generation actions that require specific project images. In this case, use 'type': 'text' and ask the user to enable 'Smart Auto-References' (the blade icon).

Respond ONLY with a JSON object following this schema:
{
  "type": "text" | "generate-image" | "generate-thumbnail",
  "content": "A detailed idea/prompt for the image generator (if generating) OR the final text answer (if text)",
  "selectedIndices": number[] (indices into the provided collection array for images to be used - 0-indexed)
}
`

const IMAGE_INTENT_SCHEMA = {
	type: 'object',
	properties: {
		type: { type: 'string', enum: ['text', 'generate-image', 'generate-thumbnail'] },
		content: { type: 'string' },
		selectedIndices: {
			type: 'array',
			items: { type: 'number' }
		}
	},
	required: ['type', 'content', 'selectedIndices']
}

export const determineImageIntent: PipelineFunction = async (_data, context) => {
	context.updateStatus('Analyzing image intent...')

	const imageDataPath = context.preprocessing.imageTextPath
	if (!imageDataPath || !fs.existsSync(imageDataPath)) {
		throw new Error('Image data not found. Please wait for extraction to complete.')
	}

	const imageTexts = JSON.parse(fs.readFileSync(imageDataPath, 'utf-8'))
	const imagePaths = Object.keys(imageTexts)
	
	const collectionText = Object.entries(imageTexts)
		.map(([path, text], index) => `Image ${index}: ${text}`)
		.join('\n\n')

	const contextLines = context.context.trim().split('\n')
	const lastUserPrompt = contextLines.pop() || ''

	const userPrompt = `
COLLECTION of Images:
${collectionText}

Conversation History:
${context.context}

User Prompt:
${lastUserPrompt}

${context.autoUseImages || (context.attachedImages && context.attachedImages.length > 0) 
	? "[SYSTEM NOTE]: IMAGE ACCESS IS ENABLED. You can select project images as references." 
	: "[SYSTEM NOTE]: IMAGE ACCESS IS DISABLED. You can see visual descriptions but cannot access actual image files. To perform visual tasks, ask the user to enable 'Smart Auto-References'."}

(Note: If the user provided any attached images, they are passed as visual context to you.)
`
	console.log(`[IMAGE-INTENT] Sending prompt to AI. User prompt detected as: "${lastUserPrompt}"`)

	const uniqueImages = Array.from(new Set(context.attachedImages || []))
	const limitedImages = uniqueImages.slice(-8)

	const adapter = GeminiAdapter.create()
	const modelSettings = settingsManager.getModelSettings()
	const modelName = modelSettings.selection['image-intent']

	const { data: result, record } = await adapter.generateStructuredText<IntentResult>(
		modelName,
		userPrompt,
		IMAGE_INTENT_SCHEMA,
		IMAGE_INTENT_SYSTEM_INSTRUCTION,
		context.signal,
		limitedImages,
		{ includeThinking: true }
	)

	console.log(`[IMAGE-INTENT] AI Result: type=${result.type}, content length=${result.content.length}, selectedIndices=${JSON.stringify(result.selectedIndices)}`)

	await context.recordUsage(record)

	if (context.signal.aborted) return

	context.intentResult = result

	if (result.type === 'text') {
		context.finish(result.content)
	} else {
		context.updateStatus(`Intent recognized: Selecting ${result.selectedIndices?.length || 0} images...`)
		context.next({ ..._data })
	}
}
