import { describe, expect, it } from 'vitest'
import { keysFor, liveWhileAgentWorks, matchShortcut, SHORTCUT_GROUPS, SHORTCUTS, shortcutsIn } from './shortcuts'

/** A KeyboardEvent's worth of fields, which is all `match` reads. */
const press = (key: string, mods: Partial<Record<'meta' | 'ctrl' | 'shift' | 'alt', boolean>> = {}) =>
	({
		key,
		metaKey: !!mods.meta,
		ctrlKey: !!mods.ctrl,
		shiftKey: !!mods.shift,
		altKey: !!mods.alt
	} as KeyboardEvent)

describe('the shortcut table', () => {
	it('documents every shortcut, because the overlay reads this list', () => {
		for (const s of SHORTCUTS) {
			expect(s.keys.trim(), s.id).not.toBe('')
			expect(s.label.trim(), s.id).not.toBe('')
			expect(SHORTCUT_GROUPS, s.id).toContain(s.group)
		}
	})

	it('has no duplicate ids', () => {
		const ids = SHORTCUTS.map((s) => s.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it('puts every shortcut in exactly one group', () => {
		const grouped = SHORTCUT_GROUPS.flatMap((g) => shortcutsIn(g))
		expect(grouped).toHaveLength(SHORTCUTS.length)
	})
})

describe('matchShortcut', () => {
	it('reads the transport keys', () => {
		expect(matchShortcut(press(' '))?.id).toBe('play')
		expect(matchShortcut(press('l'))?.id).toBe('shuttle-forward')
		expect(matchShortcut(press('J'))?.id).toBe('shuttle-back')
		expect(matchShortcut(press('k'))?.id).toBe('shuttle-stop')
		expect(matchShortcut(press('Home'))?.id).toBe('go-start')
	})

	it('separates a bare arrow from its modified forms', () => {
		expect(matchShortcut(press('ArrowRight'))?.id).toBe('step')
		expect(matchShortcut(press('ArrowRight', { alt: true }))?.id).toBe('step-second')
		expect(matchShortcut(press('ArrowRight', { shift: true }))?.id).toBe('nudge')
	})

	it('separates undo from redo by shift alone', () => {
		expect(matchShortcut(press('z', { meta: true }))?.id).toBe('undo')
		expect(matchShortcut(press('z', { meta: true, shift: true }))?.id).toBe('redo')
	})

	it('takes Ctrl and Cmd as the same modifier', () => {
		expect(matchShortcut(press('d', { ctrl: true }))?.id).toBe('duplicate')
		expect(matchShortcut(press('d', { meta: true }))?.id).toBe('duplicate')
	})

	it('separates delete-with-ripple from delete-leaving-a-gap', () => {
		expect(matchShortcut(press('Delete'))?.id).toBe('delete')
		expect(matchShortcut(press('Backspace', { shift: true }))?.id).toBe('delete-gap')
	})

	it('does not fire a plain letter when a modifier is down', () => {
		// Cmd+S is Save to the OS, not Split.
		expect(matchShortcut(press('s', { meta: true }))).toBeNull()
		expect(matchShortcut(press('m', { ctrl: true }))).toBeNull()
	})

	it('takes both spellings of the help key', () => {
		expect(matchShortcut(press('?'))?.id).toBe('help')
		expect(matchShortcut(press('/', { shift: true }))?.id).toBe('help')
	})

	it('is silent for a key it does not claim', () => {
		expect(matchShortcut(press('Tab'))).toBeNull()
		expect(matchShortcut(press('F5'))).toBeNull()
	})
})

describe('no two shortcuts answer to the same press', () => {
	it('a press resolves to one action', () => {
		// A collision would make one of them dead, and the overlay would still
		// advertise both.
		const presses = [
			press(' '), press('l'), press('j'), press('k'), press('s'), press('q'), press('w'),
			press('m'), press('n'), press('f'), press('?'), press('Escape'),
			press('ArrowLeft'), press('ArrowRight'),
			press('ArrowLeft', { shift: true }), press('ArrowLeft', { alt: true }),
			press('Home'), press('End'), press('Delete'), press('Delete', { shift: true }),
			press('=' ), press('-'),
			press('z', { meta: true }), press('z', { meta: true, shift: true }),
			press('d', { meta: true }), press('c', { meta: true }), press('v', { meta: true }),
			press('a', { meta: true }), press('b', { meta: true })
		]
		for (const event of presses) {
			const hits = SHORTCUTS.filter((s) => s.match(event, event.metaKey || event.ctrlKey))
			expect(hits.length, `${event.key}: ${hits.map((h) => h.id).join(', ')}`).toBe(1)
		}
	})
})

describe('camera angles', () => {
	const digit = (n: number, mods: Partial<Record<'meta' | 'alt' | 'shift', boolean>> = {}) =>
		({ ...press(mods.alt ? '¡' : String(n), mods), code: `Digit${n}` }) as KeyboardEvent

	it('cuts on a number and switches the whole shot on Alt + number, by the physical key', () => {
		expect(matchShortcut(digit(2))?.id).toBe('angle-cut')
		// On a Mac Alt+1 types "¡": the key code is what says it was the 1 key.
		expect(matchShortcut(digit(1, { alt: true }))?.id).toBe('angle-switch')
		expect(matchShortcut(digit(1, { meta: true }))).toBeNull()
		expect(matchShortcut({ ...press('0'), code: 'Digit0' } as KeyboardEvent)).toBeNull()
	})

	it('is an edit, so it waits while an agent holds the project', () => {
		expect(liveWhileAgentWorks(SHORTCUTS.find((s) => s.id === 'angle-cut')!)).toBe(false)
	})
})

describe('keysFor', () => {
	it('gives a tooltip the same keys the overlay shows', () => {
		expect(keysFor('split')).toContain('S')
		expect(keysFor('snapping')).toBe('N')
		expect(keysFor('nope')).toBe('')
	})
})

describe('while an agent works', () => {
	it('plays and scrubs but does not edit', () => {
		const live = (key: string, mods = {}) => liveWhileAgentWorks(matchShortcut(press(key, mods))!)
		expect(live(' ')).toBe(true)
		expect(live('ArrowRight')).toBe(true)
		expect(live('f')).toBe(true)
		expect(live('Delete')).toBe(false)
		expect(live('s')).toBe(false)
		expect(live('z', { meta: true })).toBe(false)
	})
})
