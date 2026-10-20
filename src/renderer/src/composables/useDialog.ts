import { shallowRef, type ShallowRef } from 'vue'

/**
 * In-app replacements for the native confirm / alert / message-box dialogs.
 *
 * Promise-based so a call site reads like the native call it replaces:
 *
 *   if (!(await dialog.confirm({ title: 'Delete project', message: '…', danger: true }))) return
 *
 * One host (`ConfirmDialog.vue`, mounted once in App.vue) renders whatever is
 * at the head of the queue. Requests queue rather than stack, so two calls in
 * a row are answered one after the other and neither is lost.
 */

export type DialogTone = 'neutral' | 'info' | 'warning' | 'error' | 'success'

export interface DialogAction<T = unknown> {
	label: string
	value: T
	/** The single filled button. */
	primary?: boolean
	/** Red: the action destroys something. */
	danger?: boolean
}

export interface DialogRequest<T = unknown> {
	id: number
	title: string
	message?: string
	/** Smaller second paragraph under the message. */
	detail?: string
	tone: DialogTone
	/** Left to right in the footer; the primary one is filled. */
	actions: DialogAction<T>[]
	/** What Esc and a click outside resolve with. */
	dismissValue: T
}

export interface ChooseOptions<T> {
	title: string
	message?: string
	detail?: string
	tone?: DialogTone
	actions: DialogAction<T>[]
	dismissValue: T
}

export interface ConfirmOptions {
	title: string
	message?: string
	detail?: string
	confirmLabel?: string
	cancelLabel?: string
	/** Red confirm button and a warning tone: the action destroys something. */
	danger?: boolean
}

export interface NotifyOptions {
	title: string
	message?: string
	detail?: string
	tone?: DialogTone
	okLabel?: string
}

interface Entry {
	request: DialogRequest
	resolve: (value: unknown) => void
}

/** The queue behind the host. Pure, so it can be tested without a component. */
export function createDialogQueue(current: ShallowRef<DialogRequest | null>) {
	const pending: Entry[] = []
	let active: Entry | null = null
	let nextId = 1

	const advance = () => {
		active = pending.shift() ?? null
		current.value = active ? active.request : null
	}

	const open = <T>(options: ChooseOptions<T>): Promise<T> =>
		new Promise<T>((resolve) => {
			const request: DialogRequest<T> = {
				id: nextId++,
				title: options.title,
				message: options.message,
				detail: options.detail,
				tone: options.tone ?? 'neutral',
				actions: options.actions,
				dismissValue: options.dismissValue
			}
			pending.push({ request: request as DialogRequest, resolve: resolve as (value: unknown) => void })
			if (!active) advance()
		})

	/** Called by the host with the chosen action's value. A stale id is ignored. */
	const settle = (id: number, value: unknown) => {
		if (!active || active.request.id !== id) return
		const { resolve } = active
		advance()
		resolve(value)
	}

	return {
		open,
		settle,
		get size() {
			return pending.length + (active ? 1 : 0)
		}
	}
}

const current = shallowRef<DialogRequest | null>(null)
const queue = createDialogQueue(current)

/** Plain functions (not a composable) so stores can await them too. */
export const dialog = {
	/** Resolves `true` on confirm, `false` on cancel, Esc or a click outside. */
	confirm(options: ConfirmOptions): Promise<boolean> {
		return queue.open<boolean>({
			title: options.title,
			message: options.message,
			detail: options.detail,
			tone: options.danger ? 'warning' : 'neutral',
			actions: [
				{ label: options.cancelLabel ?? 'Cancel', value: false },
				{ label: options.confirmLabel ?? 'OK', value: true, primary: true, danger: options.danger }
			],
			dismissValue: false
		})
	},

	/** A message with one OK. Resolves when it is dismissed. */
	notify(options: NotifyOptions): Promise<void> {
		return queue
			.open<boolean>({
				title: options.title,
				message: options.message,
				detail: options.detail,
				tone: options.tone ?? 'info',
				actions: [{ label: options.okLabel ?? 'OK', value: true, primary: true }],
				dismissValue: true
			})
			.then(() => undefined)
	},

	/** Three or more outcomes (e.g. Cancel / Discard / Save & switch). */
	choose<T>(options: ChooseOptions<T>): Promise<T> {
		return queue.open(options)
	}
}

/** The host reads `current` and calls `settle`. Nothing else should. */
export const dialogHost = { current, settle: queue.settle }

export function useDialog() {
	return dialog
}
