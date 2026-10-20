/**
 * The editor's horizontal budget, as one pure function.
 *
 * The window is split between a slim rail, the left panel (libraries and the
 * Inspect tab), the picture, and the chat column. The picture is the point of
 * the app, so it has a floor: panels give way to it, in a fixed order, and the
 * chat folds rather than the picture shrinking past the floor.
 *
 * Yield order when the window is too narrow:
 *   1. the left panel narrows, down to its minimum;
 *   2. the chat column narrows, down to its minimum;
 *   3. the chat folds to a composer strip under the picture, and the left panel
 *      gets back whatever that frees.
 *
 * This is the layout board's rule (v2 · "Layout budget and rules"), kept here
 * rather than inside a component so the order is something a test can pin.
 */

export const RAIL_W = 44
/** The narrowest the picture is allowed to get while there is anything to give. */
export const PREVIEW_FLOOR = 640

export const LEFT = { def: 280, min: 200, max: 440 } as const
/** A custom HTML layer wants room for its code, up to what the floor allows. */
export const LEFT_CODE_VIEW = 416
export const CHAT = { def: 340, min: 280, max: 560 } as const
export const TIMELINE = { def: 290, min: 140 } as const

export interface LayoutInput {
	/** The window's inner width in px. */
	windowW: number
	/** Whether the left panel is open. The rail itself is always there. */
	leftOpen: boolean
	/** The width the person set (or the default). */
	leftWanted: number
	/** A single custom HTML layer is selected: the left panel widens. */
	codeView: boolean
	/** Whether the person has the chat column open. */
	chatOpen: boolean
	chatWanted: number
}

export interface LayoutResult {
	left: number
	chat: number
	/** True when chat is not drawn as a column: closed, or folded for room. */
	chatFolded: boolean
	/** True only when it folded because there was no room, not by choice. */
	chatFoldedForRoom: boolean
	preview: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

export function resolveEditorLayout(input: LayoutInput): LayoutResult {
	const leftTarget = input.leftOpen
		? input.codeView
			? Math.max(clamp(input.leftWanted, LEFT.min, LEFT.max), LEFT_CODE_VIEW)
			: clamp(input.leftWanted, LEFT.min, LEFT.max)
		: 0
	const leftFloor = input.leftOpen ? LEFT.min : 0
	const chatTarget = input.chatOpen ? clamp(input.chatWanted, CHAT.min, CHAT.max) : 0

	// What the panels may spend: everything except the rail and the floor.
	const room = Math.max(0, input.windowW - RAIL_W - PREVIEW_FLOOR)

	let left = leftTarget
	let chat = chatTarget
	let over = left + chat - room

	if (over > 0) {
		const give = Math.min(over, left - leftFloor)
		left -= give
		over -= give
	}
	if (over > 0 && chat > 0) {
		const give = Math.min(over, chat - CHAT.min)
		chat -= give
		over -= give
	}
	let foldedForRoom = false
	if (over > 0 && chat > 0) {
		// The chat cannot narrow further: fold it, and let the left panel take
		// back what that frees (up to what it wanted).
		chat = 0
		foldedForRoom = true
		left = Math.min(leftTarget, Math.max(leftFloor, room))
	}

	return {
		left,
		chat,
		chatFolded: chat === 0,
		chatFoldedForRoom: foldedForRoom,
		preview: Math.max(0, input.windowW - RAIL_W - left - chat)
	}
}
