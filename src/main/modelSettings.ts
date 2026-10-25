import type { ModelSettings } from '../shared/types'
import { DEFAULT_MODEL_SETTINGS, RETIRED_GEMINI_MODELS } from './constants/gemini'

/** Operations that older versions saved and nothing reads any more. */
const RETIRED_OPERATIONS = ['timeline-new', 'timeline-edit']

const isRetiredModel = (model: string | undefined) =>
	!!model && (RETIRED_GEMINI_MODELS as readonly string[]).includes(model)

/**
 * Saved choices win over defaults; retired operations are dropped; and a
 * saved model Google no longer serves to new keys is replaced by that
 * operation's current default. Settings files store the whole selection, so a
 * fresh profile from an older version holds the old defaults as if chosen —
 * left alone, every transcript 404s and the import continues without one.
 */
export function mergeModelSettings(existing: ModelSettings): ModelSettings {
	const selection = { ...DEFAULT_MODEL_SETTINGS.selection, ...existing.selection }
	for (const op of RETIRED_OPERATIONS) delete selection[op]
	for (const [op, model] of Object.entries(selection)) {
		if (isRetiredModel(model) && DEFAULT_MODEL_SETTINGS.selection[op]) {
			selection[op] = DEFAULT_MODEL_SETTINGS.selection[op]
		}
	}
	// Retired models drop out of the price table too, which is what fills the
	// model menus — otherwise they stay offered and fail when picked.
	const pricing = { ...DEFAULT_MODEL_SETTINGS.pricing, ...existing.pricing }
	for (const model of RETIRED_GEMINI_MODELS) delete pricing[model]
	return { pricing, selection }
}
