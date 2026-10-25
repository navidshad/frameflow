import type { ModelPricing, ModelSelection } from './types'

/**
 * Pure helpers behind the model pickers in Settings. A picker can write one
 * model to several operations ("Understand images" sets three), so the value
 * it shows is derived from those operations.
 */

type PricingMap = Record<string, ModelPricing>

/**
 * Speech-to-text models (gemini-3.5-transcribe): they only turn audio into
 * words, so they belong in the transcript pickers and nowhere else.
 */
export const isSpeechOnlyModel = (model: string): boolean => /transcribe/i.test(model)

/** Models that can hear audio: the ones priced for audio input. */
export const audioModels = (pricing: PricingMap): string[] =>
	Object.keys(pricing).filter((m) => pricing[m]?.input?.audio !== undefined)

/** Models that can make images: the ones priced per output image. */
export const imageOutputModels = (pricing: PricingMap): string[] =>
	Object.keys(pricing).filter((m) => pricing[m]?.output?.image !== undefined)

/** Every general model: anything but speech-to-text. */
export const allModels = (pricing: PricingMap): string[] => Object.keys(pricing).filter((m) => !isSpeechOnlyModel(m))

const usd = (n: number): string => {
	// 0.0672 stays exact; 0.10 and 3 read as money.
	const s = n >= 0.1 ? n.toFixed(2) : String(Number(n.toFixed(4)))
	return `$${s}`
}

/** "$0.10 in · $0.40 out / 1M", or "$0.067 per image" for image-output models. */
export function priceHint(pricing: PricingMap, model: string): string {
	const p = pricing[model]
	if (!p) return ''
	if (p.output.image !== undefined) return `$${Number(p.output.image.toPrecision(3))} per image`
	return `${usd(p.input.standard)} in · ${usd(p.output.standard)} out / 1M`
}

/** The short price shown beside an option in a list: input price per 1M tokens. */
export const optionPrice = (pricing: PricingMap, model: string): string => {
	const p = pricing[model]
	if (!p) return ''
	return p.output.image !== undefined ? `$${Number(p.output.image.toPrecision(3))}` : usd(p.input.standard)
}

/** The model every operation agrees on, or null when they differ (or are unset). */
export function groupValue(selection: ModelSelection, ops: string[]): string | null {
	const first = selection[ops[0]]
	return first && ops.every((op) => selection[op] === first) ? first : null
}

/** A copy of `selection` with `model` written to every operation in `ops`. */
export function withGroupValue(selection: ModelSelection, ops: string[], model: string): ModelSelection {
	const next = { ...selection }
	for (const op of ops) next[op] = model
	return next
}
