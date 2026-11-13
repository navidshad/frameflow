import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The store reads `window.api` once, when it is created.
const api: any = new Proxy({}, { get: () => () => () => {} })
vi.stubGlobal('window', { api, addEventListener: () => {}, removeEventListener: () => {} })

import { useEditorStore } from './editorStore'

describe('selecting a transition and then something else', () => {
	beforeEach(() => setActivePinia(createPinia()))

	it('selecting a seam clears the clip selection and keeps the seam', () => {
		const store = useEditorStore()
		store.selectItems(['clip-1'])
		store.selectSeam('seam-1')
		expect(store.selectedSeamId).toBe('seam-1')
		expect(store.selectedItemIds).toEqual([])
	})

	it('selecting a clip leaves the seam, so the inspector shows the clip', () => {
		const store = useEditorStore()
		store.selectSeam('seam-1')
		store.selectItems(['clip-2'])
		expect(store.selectedSeamId).toBeNull()
		expect(store.selectedItemIds).toEqual(['clip-2'])
	})

	it('shift-selecting a clip (toggle) also leaves the seam', () => {
		const store = useEditorStore()
		store.selectSeam('seam-1')
		store.toggleItemSelected('clip-3')
		expect(store.selectedSeamId).toBeNull()
		expect(store.selectedItemIds).toEqual(['clip-3'])
	})

	it('clearing the clip selection does not drop a seam that is selected', () => {
		const store = useEditorStore()
		store.selectSeam('seam-1')
		store.clearItemSelection()
		expect(store.selectedSeamId).toBe('seam-1')
	})
})
