import { describe, expect, it } from 'vitest'
import { textIsSelected } from './shortcutGuards'

const selection = (text: string, isCollapsed = false) => ({ isCollapsed, toString: () => text })

describe('textIsSelected', () => {
	it('is true for words the person selected', () => {
		expect(textIsSelected(selection('These are taken from where each chapter starts'))).toBe(true)
		expect(textIsSelected(selection('دستگاهی دیجی خیلی'))).toBe(true)
	})

	it('is false for no selection, a caret, or only blanks', () => {
		expect(textIsSelected(null)).toBe(false)
		expect(textIsSelected(undefined)).toBe(false)
		expect(textIsSelected(selection('', true))).toBe(false)
		expect(textIsSelected(selection('   \n '))).toBe(false)
	})
})
