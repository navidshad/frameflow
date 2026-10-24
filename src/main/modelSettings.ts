import type { ModelSettings } from '../shared/types'
import { DEFAULT_MODEL_SETTINGS } from './constants/gemini'

/** Operations that older versions saved and nothing reads any more. */
const RETIRED_OPERATIONS = ['timeline-new', 'timeline-edit']

/** Saved choices win over defaults; retired operations are dropped. */
export function mergeModelSettings(existing: ModelSettings): ModelSettings {
	const selection = { ...DEFAULT_MODEL_SETTINGS.selection, ...existing.selection }
	for (const op of RETIRED_OPERATIONS) delete selection[op]
	return {
		pricing: { ...DEFAULT_MODEL_SETTINGS.pricing, ...existing.pricing },
		selection
	}
}
