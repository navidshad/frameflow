import { describe, expect, it } from 'vitest'
import { shallowRef } from 'vue'
import { createDialogQueue, type DialogRequest } from './useDialog'

const setup = () => {
	const current = shallowRef<DialogRequest | null>(null)
	return { current, queue: createDialogQueue(current) }
}

const yesNo = {
	actions: [
		{ label: 'No', value: false },
		{ label: 'Yes', value: true, primary: true }
	],
	dismissValue: false
}

describe('dialog queue', () => {
	it('shows the first request and resolves with the settled value', async () => {
		const { current, queue } = setup()
		const answer = queue.open<boolean>({ title: 'Delete?', ...yesNo })
		expect(current.value?.title).toBe('Delete?')
		queue.settle(current.value!.id, true)
		await expect(answer).resolves.toBe(true)
		expect(current.value).toBeNull()
	})

	it('queues a second request behind the first instead of replacing it', async () => {
		const { current, queue } = setup()
		const first = queue.open<boolean>({ title: 'First', ...yesNo })
		const second = queue.open<boolean>({ title: 'Second', ...yesNo })
		expect(current.value?.title).toBe('First')
		expect(queue.size).toBe(2)

		queue.settle(current.value!.id, false)
		await expect(first).resolves.toBe(false)
		expect(current.value?.title).toBe('Second')

		queue.settle(current.value!.id, true)
		await expect(second).resolves.toBe(true)
		expect(current.value).toBeNull()
		expect(queue.size).toBe(0)
	})

	it('ignores a stale id', async () => {
		const { current, queue } = setup()
		const answer = queue.open<boolean>({ title: 'A', ...yesNo })
		const id = current.value!.id
		queue.settle(id + 99, true)
		expect(current.value?.title).toBe('A')
		queue.settle(id, false)
		await expect(answer).resolves.toBe(false)
		queue.settle(id, true) // already settled: no-op, no throw
	})

	it('carries three-way choices through untouched', async () => {
		const { current, queue } = setup()
		const answer = queue.open<'cancel' | 'discard' | 'save'>({
			title: 'Unsaved changes',
			actions: [
				{ label: 'Cancel', value: 'cancel' },
				{ label: 'Discard changes', value: 'discard' },
				{ label: 'Save & switch', value: 'save', primary: true }
			],
			dismissValue: 'cancel'
		})
		expect(current.value?.actions.map((a) => a.label)).toEqual(['Cancel', 'Discard changes', 'Save & switch'])
		expect(current.value?.dismissValue).toBe('cancel')
		queue.settle(current.value!.id, 'save')
		await expect(answer).resolves.toBe('save')
	})
})
