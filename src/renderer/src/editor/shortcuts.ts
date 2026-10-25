/**
 * Every keyboard shortcut in the editor, once.
 *
 * The handler and the help overlay both read this table, so a shortcut cannot
 * exist without being documented and the documentation cannot drift from what
 * actually fires — which is the usual way a shortcuts list goes stale.
 *
 * `keys` is what the user presses, written the way the overlay should show it.
 * `match` decides whether an event is this shortcut; keeping the two separate
 * lets one action answer to several keys without listing each in the overlay.
 */

export type ShortcutGroup = 'Transport' | 'Editing' | 'Selection' | 'View'

export interface ShortcutDef {
	id: string
	group: ShortcutGroup
	/** Shown in the overlay. `+` joins simultaneous keys, `/` alternatives. */
	keys: string
	label: string
	/** True when this event should fire this shortcut. */
	match(event: KeyboardEvent, mod: boolean): boolean
}

/** ⌘ on a Mac, Ctrl elsewhere. Written once so the overlay reads right. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform)
	? '⌘'
	: 'Ctrl'

const plain = (event: KeyboardEvent, mod: boolean) => !mod && !event.altKey

const key = (event: KeyboardEvent) => event.key.toLowerCase()

export const SHORTCUTS: ShortcutDef[] = [
	// ---- Transport ----
	{
		id: 'play', group: 'Transport', keys: 'Space', label: 'Play or pause',
		match: (e, mod) => e.key === ' ' && plain(e, mod)
	},
	{
		id: 'shuttle-forward', group: 'Transport', keys: 'L', label: 'Play, then 2× and 4×',
		match: (e, mod) => key(e) === 'l' && plain(e, mod)
	},
	{
		id: 'shuttle-stop', group: 'Transport', keys: 'K', label: 'Stop',
		match: (e, mod) => key(e) === 'k' && plain(e, mod)
	},
	{
		id: 'shuttle-back', group: 'Transport', keys: 'J', label: 'Rewind, faster each press',
		match: (e, mod) => key(e) === 'j' && plain(e, mod)
	},
	{
		id: 'step', group: 'Transport', keys: '← / →', label: 'One frame',
		match: (e, mod) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && !e.shiftKey && !e.altKey
	},
	{
		id: 'step-second', group: 'Transport', keys: 'Alt + ← / →', label: 'One second',
		match: (e, mod) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && e.altKey && !e.shiftKey
	},
	{
		id: 'go-start', group: 'Transport', keys: 'Home', label: 'To the start',
		match: (e, mod) => e.key === 'Home' && plain(e, mod)
	},
	{
		id: 'go-end', group: 'Transport', keys: 'End', label: 'To the end',
		match: (e, mod) => e.key === 'End' && plain(e, mod)
	},

	// ---- Editing ----
	{
		id: 'split', group: 'Editing', keys: `S / ${MOD}+B`, label: 'Split at the playhead',
		match: (e, mod) => (key(e) === 's' && plain(e, mod)) || (mod && key(e) === 'b')
	},
	{
		id: 'trim-start', group: 'Editing', keys: 'Q', label: 'Trim the start to the playhead',
		match: (e, mod) => key(e) === 'q' && plain(e, mod)
	},
	{
		id: 'trim-end', group: 'Editing', keys: 'W', label: 'Trim the end to the playhead',
		match: (e, mod) => key(e) === 'w' && plain(e, mod)
	},
	{
		id: 'delete', group: 'Editing', keys: 'Delete', label: 'Delete and close the gap',
		match: (e, mod) => (e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.shiftKey && !e.altKey
	},
	{
		id: 'delete-gap', group: 'Editing', keys: 'Shift + Delete', label: 'Delete and leave the gap',
		match: (e, mod) => (e.key === 'Delete' || e.key === 'Backspace') && !mod && (e.shiftKey || e.altKey)
	},
	{
		id: 'duplicate', group: 'Editing', keys: `${MOD}+D`, label: 'Duplicate',
		match: (e, mod) => mod && key(e) === 'd'
	},
	{
		id: 'copy', group: 'Editing', keys: `${MOD}+C`, label: 'Copy',
		match: (e, mod) => mod && key(e) === 'c'
	},
	{
		id: 'paste', group: 'Editing', keys: `${MOD}+V`, label: 'Paste at the playhead',
		match: (e, mod) => mod && key(e) === 'v'
	},
	{
		id: 'nudge', group: 'Editing', keys: 'Shift + ← / →', label: 'Nudge the selection',
		match: (e, mod) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && e.shiftKey
	},
	{
		// The physical key, not the character: Alt+1 types "¡" on a Mac.
		id: 'angle-cut', group: 'Editing', keys: '1 – 9', label: 'Cut to that camera angle at the playhead',
		match: (e, mod) => /^(Digit|Numpad)[1-9]$/.test(e.code) && plain(e, mod) && !e.shiftKey
	},
	{
		id: 'angle-switch', group: 'Editing', keys: 'Alt + 1 – 9', label: 'Show that angle for the whole shot',
		match: (e, mod) => /^(Digit|Numpad)[1-9]$/.test(e.code) && !mod && e.altKey && !e.shiftKey
	},
	{
		id: 'marker', group: 'Editing', keys: 'M', label: 'Marker at the playhead',
		match: (e, mod) => key(e) === 'm' && plain(e, mod)
	},
	{
		id: 'undo', group: 'Editing', keys: `${MOD}+Z`, label: 'Undo',
		match: (e, mod) => mod && key(e) === 'z' && !e.shiftKey
	},
	{
		id: 'redo', group: 'Editing', keys: `${MOD}+Shift+Z`, label: 'Redo',
		match: (e, mod) => mod && key(e) === 'z' && e.shiftKey
	},

	// ---- Selection ----
	{
		id: 'select-all', group: 'Selection', keys: `${MOD}+A`, label: 'Select every clip',
		match: (e, mod) => mod && key(e) === 'a'
	},
	{
		id: 'deselect', group: 'Selection', keys: 'Esc', label: 'Deselect',
		match: (e, mod) => e.key === 'Escape' && plain(e, mod)
	},

	// ---- View ----
	{
		id: 'zoom-in', group: 'View', keys: '+', label: 'Zoom the timeline in',
		match: (e, mod) => (e.key === '+' || e.key === '=') && plain(e, mod)
	},
	{
		id: 'zoom-out', group: 'View', keys: '−', label: 'Zoom the timeline out',
		match: (e, mod) => (e.key === '-' || e.key === '_') && plain(e, mod)
	},
	{
		id: 'snapping', group: 'View', keys: 'N', label: 'Snapping on or off',
		match: (e, mod) => key(e) === 'n' && plain(e, mod)
	},
	{
		id: 'fullscreen', group: 'View', keys: 'F', label: 'Fullscreen the monitor',
		match: (e, mod) => key(e) === 'f' && plain(e, mod)
	},
	{
		id: 'help', group: 'View', keys: '?', label: 'This list',
		match: (e, mod) => (e.key === '?' || (e.shiftKey && e.key === '/')) && !mod
	}
]

/** Which shortcut an event is, or null. First match wins, so order matters. */
export function matchShortcut(event: KeyboardEvent): ShortcutDef | null {
	const mod = event.metaKey || event.ctrlKey
	return SHORTCUTS.find((s) => s.match(event, mod)) ?? null
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = ['Transport', 'Editing', 'Selection', 'View']

export const shortcutsIn = (group: ShortcutGroup): ShortcutDef[] =>
	SHORTCUTS.filter((s) => s.group === group)

/** The keys for one action, for a tooltip. */
export const keysFor = (id: string): string => SHORTCUTS.find((s) => s.id === id)?.keys ?? ''

/**
 * While an outside agent holds the project (an open MCP round), the keyboard
 * may still play, scrub, select and change the view, but not edit: an edit
 * would land under the agent mid-round.
 */
export const liveWhileAgentWorks = (def: ShortcutDef): boolean => def.group !== 'Editing'
