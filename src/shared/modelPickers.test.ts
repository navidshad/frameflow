import { describe, expect, it } from 'vitest'
import type { ModelPricing } from './types'
import { allModels, audioModels, groupValue, imageOutputModels, priceHint, withGroupValue } from './modelPickers'

const pricing: Record<string, ModelPricing> = {
	lite: { input: { standard: 0.1, audio: 0.3 }, output: { standard: 0.4 } },
	pro: { input: { standard: 1.25 }, output: { standard: 10 } },
	banana: { input: { standard: 0.5 }, output: { standard: 3, image: 0.0672 } }
}

describe('model pickers', () => {
	it('lists only audio-capable models for transcripts', () => {
		expect(audioModels(pricing)).toEqual(['lite'])
	})

	it('lists only image-output models for generation', () => {
		expect(imageOutputModels(pricing)).toEqual(['banana'])
	})

	it('words the price hint', () => {
		expect(priceHint(pricing, 'lite')).toBe('$0.10 in · $0.40 out / 1M')
		expect(priceHint(pricing, 'pro')).toBe('$1.25 in · $10.00 out / 1M')
		expect(priceHint(pricing, 'banana')).toBe('$0.0672 per image')
		expect(priceHint(pricing, 'gone')).toBe('')
	})

	it('shows a grouped value only when every step agrees', () => {
		const ops = ['a', 'b', 'c']
		expect(groupValue({ a: 'x', b: 'x', c: 'x' }, ops)).toBe('x')
		expect(groupValue({ a: 'x', b: 'y', c: 'x' }, ops)).toBeNull()
		expect(groupValue({}, ops)).toBeNull()
	})

	it('writes one model to every step and leaves the rest alone', () => {
		const next = withGroupValue({ a: 'x', b: 'y', z: 'keep' }, ['a', 'b'], 'new')
		expect(next).toEqual({ a: 'new', b: 'new', z: 'keep' })
	})

	it('offers the speech-to-text model for transcripts only', () => {
		const withStt: Record<string, ModelPricing> = {
			...pricing,
			'gemini-3.5-transcribe': { input: { standard: 2, audio: 2 }, output: { standard: 12 } }
		}
		expect(audioModels(withStt)).toContain('gemini-3.5-transcribe')
		expect(allModels(withStt)).not.toContain('gemini-3.5-transcribe')
	})
})
