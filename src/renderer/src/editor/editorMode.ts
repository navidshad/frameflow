import { computed, readonly, ref } from 'vue'

/**
 * Light and Pro: one editor, two amounts of it.
 *
 * Pro is the whole editor. Light is the same editor with the advanced tools
 * put away — animation, and the Motion, Transitions, Effects and Sound
 * libraries — because the assistant does that work for most people. Nothing
 * in Light is a different screen for the same job: a tool is either there,
 * looking as it does in Pro, or it is not there.
 *
 * Everything that needs to know the mode asks here, so the two can never
 * disagree about which one the editor is in.
 */
export type EditorMode = 'light' | 'pro'

/** Where the mode is kept, per machine, beside the editor's other layout choices. */
export const EDITOR_MODE_KEY = 'editor.mode'

/**
 * The stored value, read as a mode. Only an explicit `'pro'` is Pro: a machine
 * that has never chosen, or holds something this version does not know, opens
 * in Light.
 */
export const parseEditorMode = (stored: string | null | undefined): EditorMode =>
	stored === 'pro' ? 'pro' : 'light'

/** The left rail's libraries that only Pro lists. */
export const ADVANCED_LEFT_TABS = ['motion', 'transitions', 'effects', 'sound'] as const

export const isAdvancedTab = (tab: string): boolean =>
	(ADVANCED_LEFT_TABS as readonly string[]).includes(tab)

/**
 * The tab to show for the tab that was asked for. Light has no advanced
 * libraries, so a saved or requested one falls back to Media; every other tab,
 * and every tab in Pro, is itself.
 */
export const tabForMode = <T extends string>(tab: T, mode: EditorMode): T | 'media' =>
	mode === 'light' && isAdvancedTab(tab) ? 'media' : tab

/**
 * What to do about a motion layer whose page fails a check, said after the
 * warning itself: a clause with no capital and no full stop, so it can follow
 * a dash ("Fails 2 checks — open the HTML tab to see why").
 *
 * Pro points at the HTML tab, where the failing checks are listed. Light has
 * no HTML tab, so it must not send anyone looking for one.
 */
export const motionWarningHint = (mode: EditorMode): string =>
	mode === 'pro'
		? 'open the HTML tab to see why'
		: 'ask the assistant to fix it, or switch to Pro to see why'

// localStorage is the renderer's. Tests run in node, where it does not exist
// (or exists and throws), and a private window can refuse it: the mode still
// works for the session, it just is not remembered.
const readStored = (): string | null => {
	try {
		return localStorage.getItem(EDITOR_MODE_KEY)
	} catch {
		return null
	}
}

const writeStored = (mode: EditorMode) => {
	try {
		localStorage.setItem(EDITOR_MODE_KEY, mode)
	} catch {
		// Nowhere to keep it: the choice lasts until the window closes.
	}
}

/** The one mode every caller shares: the top bar's switch writes it, the rest read it. */
const mode = ref<EditorMode>(parseEditorMode(readStored()))
const isPro = computed(() => mode.value === 'pro')
const isLight = computed(() => mode.value === 'light')

const setMode = (next: EditorMode) => {
	if (next === mode.value) return
	mode.value = next
	writeStored(next)
}

/**
 * The editor's mode. `mode` is read-only on purpose: `setMode` is the only way
 * to change it, so what is on screen and what is remembered stay the same.
 */
export const useEditorMode = () => ({ mode: readonly(mode), isPro, isLight, setMode })
