import { ModelSettings } from '../../shared/types'

export const GEMINI_MODEL_2_5_PRO = 'gemini-2.5-pro'
export const GEMINI_MODEL_2_5_FLASH = 'gemini-2.5-flash'
export const GEMINI_MODEL_2_5_FLASH_LITE = 'gemini-2.5-flash-lite'
export const GEMINI_MODEL_3_FLASH_PREVIEW = 'gemini-3-flash-preview'
export const GEMINI_MODEL_3_1_FLASH_IMAGE_PREVIEW = 'gemini-3.1-flash-image-preview'
export const GEMINI_MODEL_3_PRO_IMAGE_PREVIEW = 'gemini-3-pro-image-preview'

export const MODEL_METADATA: Record<string, { label: string; description?: string }> = {
	[GEMINI_MODEL_2_5_PRO]: { label: 'Gemini 2.5 Pro' },
	[GEMINI_MODEL_2_5_FLASH]: { label: 'Gemini 2.5 Flash' },
	[GEMINI_MODEL_2_5_FLASH_LITE]: { label: 'Gemini 2.5 Flash Lite' },
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
	pricing: {
		[GEMINI_MODEL_2_5_PRO]: {
			input: {
				standard: 1.25,
				longContext: 2.50,
				threshold: 200000
			},
			output: {
				standard: 10.00,
				longContext: 15.00,
				threshold: 200000
			}
		},
		[GEMINI_MODEL_2_5_FLASH]: {
			input: {
				text: 0.30,
				audio: 1.00,
				standard: 0.30
			},
			output: {
				standard: 2.50
			}
		},
		[GEMINI_MODEL_2_5_FLASH_LITE]: {
			input: {
				text: 0.10,
				audio: 0.30,
				standard: 0.10
			},
			output: {
				standard: 0.40
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
		'raw-transcript': GEMINI_MODEL_2_5_FLASH_LITE,
		'corrected-transcript': GEMINI_MODEL_2_5_PRO,
		'intent': GEMINI_MODEL_2_5_FLASH,
		'timeline-new': GEMINI_MODEL_3_FLASH_PREVIEW,
		'timeline-edit': GEMINI_MODEL_2_5_FLASH,
		'thumbnail': GEMINI_MODEL_3_1_FLASH_IMAGE_PREVIEW,
		'scene-description': GEMINI_MODEL_2_5_FLASH_LITE,
		'image-extraction': GEMINI_MODEL_2_5_FLASH_LITE,
		'image-intent': GEMINI_MODEL_2_5_FLASH,
		'image-generation': GEMINI_MODEL_3_1_FLASH_IMAGE_PREVIEW,
		'image-upscale': GEMINI_MODEL_3_1_FLASH_IMAGE_PREVIEW,
		'editor-edit': GEMINI_MODEL_3_FLASH_PREVIEW
	}
}
