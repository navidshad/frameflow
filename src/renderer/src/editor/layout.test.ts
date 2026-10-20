import { describe, expect, it } from 'vitest'
import { CHAT, LEFT, LEFT_CODE_VIEW, PREVIEW_FLOOR, RAIL_W, resolveEditorLayout, type LayoutInput } from './layout'

const base: LayoutInput = {
	windowW: 1440, leftOpen: true, leftWanted: LEFT.def, codeView: false, chatOpen: true, chatWanted: CHAT.def
}
const at = (over: Partial<LayoutInput>) => resolveEditorLayout({ ...base, ...over })

describe('the editor layout budget', () => {
	it('matches the v2 board at 1440: rail 44, left 280, chat 340, picture 776', () => {
		const r = at({})
		expect(r).toMatchObject({ left: 280, chat: 340, chatFolded: false, preview: 776 })
		expect(RAIL_W + r.left + r.preview + r.chat).toBe(1440)
	})

	it('widens the left panel for a custom HTML layer, picture stays at the floor', () => {
		const r = at({ codeView: true })
		expect(r.left).toBe(LEFT_CODE_VIEW)
		expect(r.preview).toBe(1440 - RAIL_W - LEFT_CODE_VIEW - 340)
		expect(r.preview).toBeGreaterThanOrEqual(PREVIEW_FLOOR)
	})

	it('never lets the code view push the picture under the floor: the left panel narrows', () => {
		const r = at({ windowW: 1300, codeView: true })
		expect(r.preview).toBe(PREVIEW_FLOOR)
		expect(r.left).toBeLessThan(LEFT_CODE_VIEW)
		expect(r.left).toBeGreaterThanOrEqual(LEFT.min)
		expect(r.chat).toBe(340)
	})

	it('narrows the left panel first, then the chat, in that order', () => {
		// room = 1230 - 44 - 640 = 546; wanted 280 + 340 = 620; over by 74.
		// The left panel can give 80, so it alone covers it and chat is untouched.
		const a = at({ windowW: 1230 })
		expect(a.left).toBe(280 - 74)
		expect(a.chat).toBe(340)

		// room = 1170 - 44 - 640 = 486; over by 134: left gives its 80, chat the rest.
		const b = at({ windowW: 1170 })
		expect(b.left).toBe(LEFT.min)
		expect(b.chat).toBe(340 - 54)
		expect(b.chat).toBeGreaterThanOrEqual(CHAT.min)
		expect(b.preview).toBe(PREVIEW_FLOOR)
	})

	it('folds the chat when it cannot narrow any further, and the left panel takes the room back', () => {
		const r = at({ windowW: 1000 })
		expect(r.chatFolded).toBe(true)
		expect(r.chatFoldedForRoom).toBe(true)
		expect(r.chat).toBe(0)
		// room = 1000 - 44 - 640 = 316, so the left panel is back to its wish.
		expect(r.left).toBe(280)
		expect(r.preview).toBe(1000 - RAIL_W - 280)
	})

	it('a chat the person closed is folded by choice, not for room', () => {
		const r = at({ chatOpen: false })
		expect(r.chatFolded).toBe(true)
		expect(r.chatFoldedForRoom).toBe(false)
		expect(r.preview).toBe(1440 - RAIL_W - 280)
	})

	it('a collapsed left panel leaves only the rail', () => {
		const r = at({ leftOpen: false })
		expect(r.left).toBe(0)
		expect(r.preview).toBe(1440 - RAIL_W - 340)
	})

	it('clamps a stored width to the panel limits', () => {
		expect(at({ leftWanted: 90 }).left).toBe(LEFT.min)
		expect(at({ leftWanted: 900, windowW: 2400 }).left).toBe(LEFT.max)
		expect(at({ chatWanted: 900, windowW: 2400 }).chat).toBe(CHAT.max)
		expect(at({ chatWanted: 100 }).chat).toBe(CHAT.min)
	})

	it('on a very small window the picture takes what is left rather than going negative', () => {
		const r = at({ windowW: 600 })
		expect(r.preview).toBeGreaterThanOrEqual(0)
		expect(r.chatFolded).toBe(true)
	})
})
