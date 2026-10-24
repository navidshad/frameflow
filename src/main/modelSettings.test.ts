import { describe, expect, it } from 'vitest'
import { mergeModelSettings } from './modelSettings'
import { DEFAULT_MODEL_SETTINGS } from './constants/gemini'

describe('mergeModelSettings', () => {
	it('keeps the user’s saved choices', () => {
		const out = mergeModelSettings({ pricing: {}, selection: { 'raw-transcript': 'gemini-2.5-pro', intent: 'x' } })
		expect(out.selection['raw-transcript']).toBe('gemini-2.5-pro')
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
})
