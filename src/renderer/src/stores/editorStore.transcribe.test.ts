import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The store reads `window.api` once, when it is created.
const preprocessMedia = vi.fn().mockResolvedValue(undefined)
// Every other call the store makes while it is created (the IPC listeners) does nothing.
const api: any = new Proxy({ preprocessMedia }, {
	get: (target, key) => (key in target ? (target as any)[key] : () => () => {})
})
vi.stubGlobal('window', { api, addEventListener: () => {}, removeEventListener: () => {} })

import { useEditorStore } from './editorStore'

describe('editorStore.transcribeAsset (the "Transcribe again" button)', () => {
	beforeEach(() => {
		preprocessMedia.mockClear()
		setActivePinia(createPinia())
	})

	it('asks for the audio and the transcript of that file, by name, so the run is explicit', async () => {
		const store = useEditorStore()
		store.threadId = 'thread-1'
		await store.transcribeAsset('asset-9')
		expect(preprocessMedia).toHaveBeenCalledWith({
			threadId: 'thread-1', assetId: 'asset-9', steps: ['audio', 'transcript']
		})
	})

	it('does nothing without an open project', async () => {
		const store = useEditorStore()
		await store.transcribeAsset('asset-9')
		expect(preprocessMedia).not.toHaveBeenCalled()
	})
})
