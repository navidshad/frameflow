import { ModelSettings } from '../../shared/types'

/**
 * Google stopped serving these to new API keys (404 "no longer available to
 * new users"); keys that used them before still work. Defaults must never
 * point here, and saved settings that do are moved to the current default
 * (see modelSettings.ts).
 */
export const RETIRED_GEMINI_MODELS = [
	'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
	'gemini-2.0-flash', 'gemini-2.0-flash-lite'
] as const

export const GEMINI_MODEL_3_FLASH_PREVIEW = 'gemini-3-flash-preview'
/** GA general model (Jul 2026). */
export const GEMINI_MODEL_3_6_FLASH = 'gemini-3.6-flash'
/** GA cheap model (Jul 2026), Google's named successor to 3.1 Flash-Lite. */
export const GEMINI_MODEL_3_5_FLASH_LITE = 'gemini-3.5-flash-lite'
/** Dedicated speech-to-text with measured word timestamps (Interactions API). */
export const GEMINI_MODEL_3_5_TRANSCRIBE = 'gemini-3.5-transcribe'
export const GEMINI_MODEL_3_1_FLASH_IMAGE_PREVIEW = 'gemini-3.1-flash-image-preview'
export const GEMINI_MODEL_3_PRO_IMAGE_PREVIEW = 'gemini-3-pro-image-preview'

export const MODEL_METADATA: Record<string, { label: string; description?: string }> = {
	[GEMINI_MODEL_3_5_TRANSCRIBE]: {
		label: 'Gemini 3.5 Transcribe',
		description: 'Speech-to-text with word timestamps measured from the audio. Transcripts only.'
	},
	[GEMINI_MODEL_3_6_FLASH]: { label: 'Gemini 3.6 Flash' },
	[GEMINI_MODEL_3_5_FLASH_LITE]: { label: 'Gemini 3.5 Flash Lite' },
	[GEMINI_MODEL_3_FLASH_PREVIEW]: { label: 'Gemini 3 Flash Preview' },
	[GEMINI_MODEL_3_1_FLASH_IMAGE_PREVIEW]: {
		label: 'Nano Banana 2',
		description: 'Pro-level visual intelligence with Flash-speed efficiency and reality-grounded generation capabilities.'
	},
	[GEMINI_MODEL_3_PRO_IMAGE_PREVIEW]: {
		label: 'Nano Banana Pro',
		description: 'State-of-the-art image generation and editing model.'
	}
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
	// USD per 1M tokens, ai.google.dev/gemini-api/docs/pricing (checked 2026-10-25).
	pricing: {
		[GEMINI_MODEL_3_5_TRANSCRIBE]: {
			input: {
				audio: 2.00,
				standard: 2.00
			},
			output: {
				standard: 12.00
			}
		},
		// Introductory price through 2026-12-31; $1.50 in / $7.50 out from 2027.
		[GEMINI_MODEL_3_6_FLASH]: {
			input: {
				audio: 0.75,
				standard: 0.75
			},
			output: {
				standard: 3.75
			}
		},
		[GEMINI_MODEL_3_5_FLASH_LITE]: {
			input: {
				audio: 0.30,
				standard: 0.30
			},
			output: {
				standard: 2.50
			}
		},
		[GEMINI_MODEL_3_FLASH_PREVIEW]: {
			input: {
				text: 0.50,
				audio: 1.00,
				standard: 0.50
			},
			output: {
				standard: 3.00
			}
		},
		[GEMINI_MODEL_3_1_FLASH_IMAGE_PREVIEW]: {
			input: {
				standard: 0.50
			},
			output: {
				standard: 3.00,
				image: 0.0672
			}
		},
		[GEMINI_MODEL_3_PRO_IMAGE_PREVIEW]: {
			input: {
				standard: 2.00
			},
			output: {
				standard: 12.00,
				image: 0.134
			}
		}
	},
	selection: {
		'raw-transcript': GEMINI_MODEL_3_5_TRANSCRIBE,
		// The repair pass reads the previous attempt as text, which a transcribe
		// model cannot take — a general model does the correcting.
		'corrected-transcript': GEMINI_MODEL_3_6_FLASH,
		'intent': GEMINI_MODEL_3_6_FLASH,
		'thumbnail': GEMINI_MODEL_3_1_FLASH_IMAGE_PREVIEW,
		'scene-description': GEMINI_MODEL_3_5_FLASH_LITE,
		'image-extraction': GEMINI_MODEL_3_5_FLASH_LITE,
		'image-intent': GEMINI_MODEL_3_6_FLASH,
		'image-generation': GEMINI_MODEL_3_1_FLASH_IMAGE_PREVIEW,
		'image-upscale': GEMINI_MODEL_3_1_FLASH_IMAGE_PREVIEW,
		'editor-edit': GEMINI_MODEL_3_FLASH_PREVIEW
	}
}
