import { describe, expect, it } from 'vitest'
import { mergeModelSettings } from './modelSettings'
import { DEFAULT_MODEL_SETTINGS, RETIRED_GEMINI_MODELS } from './constants/gemini'

describe('mergeModelSettings', () => {
	it('keeps the user’s saved choices', () => {
		const out = mergeModelSettings({ pricing: {}, selection: { 'raw-transcript': 'gemini-3-flash-preview', intent: 'x' } })
		expect(out.selection['raw-transcript']).toBe('gemini-3-flash-preview')
		expect(out.selection.intent).toBe('x')
	})

	it('fills operations the saved file does not have', () => {
		const out = mergeModelSettings({ pricing: {}, selection: {} })
		expect(out.selection).toEqual(DEFAULT_MODEL_SETTINGS.selection)
		expect(Object.keys(out.pricing)).toEqual(Object.keys(DEFAULT_MODEL_SETTINGS.pricing))
	})

	it('drops the retired timeline operations', () => {
		const out = mergeModelSettings({ pricing: {}, selection: { 'timeline-new': 'a', 'timeline-edit': 'b', thumbnail: 't' } })
		expect(out.selection).not.toHaveProperty('timeline-new')
		expect(out.selection).not.toHaveProperty('timeline-edit')
		expect(out.selection.thumbnail).toBe('t')
	})

	it('moves operations saved on a retired model to the current default', () => {
		// What a profile created by an older version holds: its defaults, saved.
		const out = mergeModelSettings({
			pricing: { 'gemini-2.5-pro': { input: { standard: 1.25 }, output: { standard: 10 } } },
			selection: {
				'raw-transcript': 'gemini-2.5-flash-lite',
				'corrected-transcript': 'gemini-2.5-pro',
				'scene-description': 'gemini-2.5-flash-lite',
				intent: 'gemini-2.5-flash',
				'editor-edit': 'gemini-3-flash-preview'
			}
		})
		expect(out.selection['raw-transcript']).toBe(DEFAULT_MODEL_SETTINGS.selection['raw-transcript'])
		expect(out.selection['corrected-transcript']).toBe(DEFAULT_MODEL_SETTINGS.selection['corrected-transcript'])
		expect(out.selection['scene-description']).toBe(DEFAULT_MODEL_SETTINGS.selection['scene-description'])
		expect(out.selection.intent).toBe(DEFAULT_MODEL_SETTINGS.selection.intent)
		expect(out.selection['editor-edit']).toBe('gemini-3-flash-preview')
		expect(out.pricing).not.toHaveProperty('gemini-2.5-pro')
	})

	it('no default points at a retired model, and every default is priced', () => {
		for (const [op, model] of Object.entries(DEFAULT_MODEL_SETTINGS.selection)) {
			expect(RETIRED_GEMINI_MODELS as readonly string[], op).not.toContain(model)
			expect(DEFAULT_MODEL_SETTINGS.pricing, op).toHaveProperty([model])
		}
		expect(DEFAULT_MODEL_SETTINGS.selection['raw-transcript']).toBe('gemini-3.5-transcribe')
	})
})
