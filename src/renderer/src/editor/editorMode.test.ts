import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	ADVANCED_LEFT_TABS, EDITOR_MODE_KEY, isAdvancedTab, motionWarningHint, parseEditorMode, tabForMode, useEditorMode
} from './editorMode'

describe('reading the stored mode', () => {
	it('opens in Light when nothing is stored yet', () => {
		expect(parseEditorMode(null)).toBe('light')
		expect(parseEditorMode(undefined)).toBe('light')
		expect(parseEditorMode('')).toBe('light')
	})

	it('keeps Pro and Light as they were stored', () => {
		expect(parseEditorMode('pro')).toBe('pro')
		expect(parseEditorMode('light')).toBe('light')
	})

	it('reads anything it does not know as Light', () => {
		for (const junk of ['Pro', 'PRO', ' pro', 'simple', 'true', '1', 'null', '{"mode":"pro"}']) {
			expect(parseEditorMode(junk)).toBe('light')
		}
	})
})

describe('the advanced left tabs', () => {
	it('are Motion, Transitions, Effects and Sound', () => {
		expect([...ADVANCED_LEFT_TABS]).toEqual(['motion', 'transitions', 'effects', 'sound'])
		for (const tab of ADVANCED_LEFT_TABS) expect(isAdvancedTab(tab)).toBe(true)
	})

	it('do not include Media, Words or a tab that does not exist', () => {
		for (const tab of ['media', 'words', '', 'Motion', 'inspect']) expect(isAdvancedTab(tab)).toBe(false)
	})

	it('fall back to Media in Light', () => {
		for (const tab of ADVANCED_LEFT_TABS) expect(tabForMode(tab, 'light')).toBe('media')
	})

	it('leave Media and Words alone in Light', () => {
		expect(tabForMode('media', 'light')).toBe('media')
		expect(tabForMode('words', 'light')).toBe('words')
	})

	it('leave every tab alone in Pro', () => {
		for (const tab of ['media', 'words', ...ADVANCED_LEFT_TABS]) expect(tabForMode(tab, 'pro')).toBe(tab)
	})
})

describe('the hint after a motion layer warning', () => {
	it('points Pro at the HTML tab', () => {
		expect(motionWarningHint('pro')).toMatch(/HTML tab/)
	})

	it('never sends Light to an HTML tab it does not have', () => {
		const hint = motionWarningHint('light')
		expect(hint).not.toMatch(/html/i)
		expect(hint).toMatch(/assistant/)
		expect(hint).toMatch(/Pro/)
	})

	it('says something different in each mode, as a clause that can follow a dash', () => {
		expect(motionWarningHint('light')).not.toBe(motionWarningHint('pro'))
		for (const hint of [motionWarningHint('light'), motionWarningHint('pro')]) {
			expect(hint).toMatch(/^[a-z]/)
			expect(hint).not.toMatch(/[.!]$/)
		}
	})
})

describe('the shared mode', () => {
	// The mode is read once, when the module loads, so each case loads a fresh
	// copy against the storage it wants to find there.
	const load = async (stored?: Record<string, string>) => {
		vi.resetModules()
		const kept = new Map(Object.entries(stored ?? {}))
		if (stored) {
			vi.stubGlobal('localStorage', {
				getItem: (key: string) => kept.get(key) ?? null,
				setItem: (key: string, value: string) => { kept.set(key, value) }
			})
		}
		const fresh = await import('./editorMode')
		return { ...fresh.useEditorMode(), again: fresh.useEditorMode, kept }
	}

	afterEach(() => {
		vi.unstubAllGlobals()
		useEditorMode().setMode('light')
	})

	it('is Light where there is no storage at all, and still switches', async () => {
		vi.stubGlobal('localStorage', undefined)
		const { mode, isPro, isLight, setMode } = await load()
		expect(mode.value).toBe('light')
		expect(isLight.value).toBe(true)
		setMode('pro')
		expect(mode.value).toBe('pro')
		expect(isPro.value).toBe(true)
		expect(isLight.value).toBe(false)
	})

	it('is Light on a machine that has never chosen', async () => {
		const { mode, kept } = await load({})
		expect(mode.value).toBe('light')
		// Opening the editor is not a choice: nothing is written until the switch is used.
		expect(kept.has(EDITOR_MODE_KEY)).toBe(false)
	})

	it('opens in the mode used last', async () => {
		expect((await load({ [EDITOR_MODE_KEY]: 'pro' })).mode.value).toBe('pro')
		expect((await load({ [EDITOR_MODE_KEY]: 'light' })).mode.value).toBe('light')
		expect((await load({ [EDITOR_MODE_KEY]: 'expert' })).mode.value).toBe('light')
	})

	it('remembers a switch, both ways', async () => {
		const { setMode, kept } = await load({})
		setMode('pro')
		expect(kept.get(EDITOR_MODE_KEY)).toBe('pro')
		setMode('light')
		expect(kept.get(EDITOR_MODE_KEY)).toBe('light')
	})

	it('is one mode for every caller', async () => {
		const first = await load({})
		const second = first.again()
		first.setMode('pro')
		expect(second.mode.value).toBe('pro')
		expect(second.isPro.value).toBe(true)
		second.setMode('light')
		expect(first.isLight.value).toBe(true)
	})

	it('keeps working when storage refuses the write', async () => {
		vi.resetModules()
		vi.stubGlobal('localStorage', {
			getItem: () => { throw new Error('denied') },
			setItem: () => { throw new Error('denied') }
		})
		const { useEditorMode: use } = await import('./editorMode')
		const { mode, setMode } = use()
		expect(mode.value).toBe('light')
		expect(() => setMode('pro')).not.toThrow()
		expect(mode.value).toBe('pro')
	})
})
