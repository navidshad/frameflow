import { describe, expect, it } from 'vitest'
import {
	chooseModel, findModel, labelFor, modelOf, parseSpecDefaults, parseSpecModels, parseSpeechModels, usableModels, type ModelCatalog
} from './audioModels'
import spec from './__fixtures__/elevenlabs-openapi-slice.json'
// GET /v1/models as ElevenLabs answered it on 2026-11-24 (a Starter key with "Models: read").
import realModels from './__fixtures__/elevenlabs-models.json'

/**
 * `spec` is the part of ElevenLabs' real `/openapi.json` the parser reads,
 * captured 2026-11-24: the effect and music request bodies and the enums their
 * `model_id` points at. `SPEECH` is shaped like `GET /v1/models` as the API
 * reference documents it (the key used that day had no "Models: read").
 */
const SPEECH = [
	{
		model_id: 'eleven_multilingual_v2', name: 'Eleven Multilingual v2', can_do_text_to_speech: true, requires_alpha_access: false,
		description: 'Our most life-like, emotionally rich mode in 29 languages.', maximum_text_length_per_request: 10000,
		languages: [{ language_id: 'en', name: 'English' }, { language_id: 'fa', name: 'Persian' }], model_rates: { character_cost_multiplier: 1 }
	},
	{
		model_id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', can_do_text_to_speech: true, requires_alpha_access: false,
		description: 'Ultra low latency.', maximum_text_length_per_request: 40000, languages: [{ language_id: 'en', name: 'English' }],
		model_rates: { character_cost_multiplier: 0.5 }
	},
	{ model_id: 'eleven_multilingual_sts_v2', name: 'Eleven Multilingual v2 (STS)', can_do_text_to_speech: false, can_do_voice_conversion: true },
	{ model_id: 'eleven_secret_v9', name: 'Eleven v9', can_do_text_to_speech: true, requires_alpha_access: true },
	{ model_id: 'eleven_bare', can_do_text_to_speech: true }
]

const catalog = (): ModelCatalog => ({
	provider: 'elevenlabs', fetchedAt: 1, models: [...parseSpeechModels(SPEECH), ...parseSpecModels(spec)]
})

describe('labelFor', () => {
	it.each([
		['music_v2_5', 'Music v2.5'],
		['music_v1', 'Music v1'],
		['eleven_text_to_sound_v3', 'Text to sound v3'],
		['eleven_flash_v2_5', 'Flash v2.5'],
		['eleven_v4', 'V4']
	])('names %s for the person', (id, label) => expect(labelFor(id)).toBe(label))
})

describe('the effect and music models, from the API spec', () => {
	it('reads every id each endpoint accepts, in the spec’s order, and which are deprecated', () => {
		const models = parseSpecModels(spec)
		expect(models.filter((m) => m.capability === 'sfx').map((m) => m.id)).toEqual(['eleven_text_to_sound_v2', 'eleven_text_to_sound_v3'])
		expect(models.filter((m) => m.capability === 'music').map((m) => [m.id, !!m.deprecated])).toEqual([
			['music_v1', true], ['music_v2', false], ['music_v2_5', false]
		])
	})

	it('follows the references, so a renamed schema still reads', () => {
		const renamed = JSON.parse(JSON.stringify(spec).replaceAll('MusicModelID', 'MusicModelIdV9'))
		expect(parseSpecModels(renamed).filter((m) => m.capability === 'music')).toHaveLength(3)
	})

	it('finds nothing in something that is not a spec, rather than failing', () => {
		expect(parseSpecModels(null)).toEqual([])
		expect(parseSpecModels({ paths: { '/v1/music': { post: {} } } })).toEqual([])
		expect(parseSpecModels('<html>')).toEqual([])
	})

	it('picks up a model ElevenLabs adds tomorrow, with no change here', () => {
		const tomorrow = JSON.parse(JSON.stringify(spec))
		tomorrow.components.schemas.MusicModelID.enum.push('music_v3')
		expect(parseSpecModels(tomorrow).map((m) => m.id)).toContain('music_v3')
	})
})

describe('the voice models, from GET /v1/models', () => {
	it('keeps the ones that read text and need no alpha access, with what the API says about each', () => {
		const models = parseSpeechModels(SPEECH)
		expect(models.map((m) => m.id)).toEqual(['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_bare'])
		expect(models[0]).toEqual({
			id: 'eleven_multilingual_v2', provider: 'elevenlabs', capability: 'speech', label: 'Eleven Multilingual v2',
			description: 'Our most life-like, emotionally rich mode in 29 languages.', maxChars: 10000, languages: 2, costMultiplier: 1
		})
		// No name from the API: one is made from the id.
		expect(models[2]).toEqual({ id: 'eleven_bare', provider: 'elevenlabs', capability: 'speech', label: 'Bare' })
	})

	it('reads nothing from a reply that is not a list', () => {
		expect(parseSpeechModels({ detail: 'missing permission' })).toEqual([])
	})

	it('falls back, before anyone has picked, to the voice model the API itself uses by default, not the last in its unordered list', () => {
		const c: ModelCatalog = { provider: 'elevenlabs', fetchedAt: 1, models: [...parseSpeechModels(realModels), ...parseSpecModels(spec)], defaults: parseSpecDefaults(spec) }
		expect(c.defaults).toEqual({ speech: 'eleven_multilingual_v2' })
		expect(chooseModel(c, { capability: 'speech', prompt: 'Hi.' })!.id).toBe('eleven_multilingual_v2')
		// A pick wins, and effects and music still take the newest current model.
		expect(chooseModel({ ...c, picks: { speech: 'eleven_v4' } }, { capability: 'speech', prompt: 'Hi.' })!.id).toBe('eleven_v4')
		expect(chooseModel(c, { capability: 'sfx', prompt: 'a door' })!.id).toBe('eleven_text_to_sound_v3')
	})

	it('reads the real reply: every model that reads text, none of the voice changers, with limits, languages and relative cost', () => {
		const models = parseSpeechModels(realModels)
		expect(models.map((m) => m.id)).toEqual([
			'eleven_v4', 'eleven_v4_turbo', 'eleven_v3', 'eleven_v3_conversational', 'eleven_multilingual_v2',
			'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_turbo_v2', 'eleven_flash_v2'
		])
		expect(models.find((m) => m.id === 'eleven_v4')).toMatchObject({ label: 'Eleven v4', maxChars: 100000, languages: 94, costMultiplier: 1 })
		expect(models.find((m) => m.id === 'eleven_flash_v2_5')).toMatchObject({ maxChars: 40000, costMultiplier: 0.5 })
		expect(models.every((m) => m.description && !m.deprecated)).toBe(true)
	})
})

describe('choosing a model', () => {
	it('never offers or chooses a deprecated one', () => {
		const c = catalog()
		expect(usableModels(c, 'music').map((m) => m.id)).toEqual(['music_v2', 'music_v2_5'])
		for (const capability of ['speech', 'sfx', 'music'] as const) {
			for (const prompt of ['Hi.', 'x'.repeat(30_000), '[whispers] a secret']) {
				for (const ownVoice of [false, true]) {
					const pick = chooseModel(c, { capability, prompt, ownVoice })
					expect(pick, `${capability} ${prompt.length} ${ownVoice}`).toBeDefined()
					expect(pick!.deprecated).toBeFalsy()
					expect(pick!.capability).toBe(capability)
				}
			}
		}
	})

	it('chooses nothing when the provider listed nothing for that kind', () => {
		expect(chooseModel(null, { capability: 'speech', prompt: 'Hi.' })).toBeUndefined()
		expect(chooseModel({ provider: 'elevenlabs', fetchedAt: 1, models: parseSpecModels(spec) }, { capability: 'speech', prompt: 'Hi.' })).toBeUndefined()
	})

	it('runs a request on the model it names, else the chosen one', () => {
		const c = catalog()
		expect(modelOf(c, { capability: 'music', prompt: 'calm piano', model: 'music_v2' })!.id).toBe('music_v2')
		expect(modelOf(c, { capability: 'music', prompt: 'calm piano' })!.id).toBe(chooseModel(c, { capability: 'music', prompt: 'calm piano' })!.id)
		expect(findModel(c, 'music', 'music_v9')).toBeUndefined()
	})
})
