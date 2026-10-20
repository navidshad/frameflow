<template>
	<Teleport to="body">
		<Transition name="app-dialog">
			<div v-if="modelValue" class="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/45"
				@mousedown.self="onBackdrop">
				<div ref="panelEl" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1"
					class="app-dialog-panel w-full max-h-full flex flex-col overflow-hidden rounded-md outline-none
					       bg-white dark:bg-[#101013] text-zinc-900 dark:text-zinc-50 shadow-[0_24px_60px_rgba(0,0,0,0.35)]"
					:class="WIDTH[size]" :style="{ border: '1px solid var(--ff-hairline-strong)' }">
					<!-- Title row -->
					<div class="flex items-center gap-3 pl-[18px] pr-3 pt-3.5 pb-2.5 shrink-0">
						<h2 :id="titleId" class="font-heading font-semibold text-base tracking-tight truncate flex-1 min-w-0">
							<slot name="title">{{ title }}</slot>
						</h2>
						<button v-if="closable" class="btn-icon !w-6 !h-6 text-zinc-400" aria-label="Close" title="Close (Esc)"
							@click="close">
							<span class="iconify tabler--x w-3.5 h-3.5"></span>
						</button>
					</div>

					<!-- Body -->
					<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-[18px] pb-3.5 text-xs leading-normal">
						<slot />
					</div>

					<!-- Footer: ghost actions, then the single filled one -->
					<div v-if="$slots.footer" class="flex items-center gap-[18px] px-[18px] py-2.5 shrink-0 hair-t">
						<slot name="footer-start" />
						<div class="flex-1"></div>
						<slot name="footer" />
					</div>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>

<script lang="ts">
// Esc closes only the dialog on top when two are open (a confirm over an editor).
const openStack: symbol[] = []
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

/**
 * The one dialog surface: solid background, one hairline, a soft shadow, 6px
 * corners, no blur. Title row, scrolling body, and a footer of ghost text
 * actions with a single filled primary. Every modal in the app is this.
 */
const props = withDefaults(defineProps<{
	modelValue: boolean
	title?: string
	size?: 'sm' | 'md' | 'lg' | 'xl'
	/** Show the X, and let Esc and a click outside close it. */
	closable?: boolean
}>(), { size: 'md', closable: true })

const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void
	(e: 'close'): void
}>()

const WIDTH = { sm: 'max-w-[380px]', md: 'max-w-[420px]', lg: 'max-w-[520px]', xl: 'max-w-[730px]' } as const

const titleId = `app-dialog-${Math.random().toString(36).slice(2, 8)}`
const panelEl = ref<HTMLElement | null>(null)
const token = Symbol('dialog')

const close = () => {
	if (!props.closable) return
	emit('update:modelValue', false)
	emit('close')
}

// Press and release on the backdrop only: a drag that starts in a text field
// and ends outside must not dismiss the dialog.
const onBackdrop = () => close()

const onKeydown = (event: KeyboardEvent) => {
	if (event.key !== 'Escape' || openStack[openStack.length - 1] !== token) return
	if (!props.closable) return
	event.stopPropagation()
	close()
}

const release = () => {
	const index = openStack.indexOf(token)
	if (index !== -1) openStack.splice(index, 1)
	window.removeEventListener('keydown', onKeydown, true)
}

watch(() => props.modelValue, async (open) => {
	if (open) {
		openStack.push(token)
		window.addEventListener('keydown', onKeydown, true)
		await nextTick()
		// Keep a field the dialog already focused (autofocus); else take focus so Esc works.
		if (panelEl.value && !panelEl.value.contains(document.activeElement)) panelEl.value.focus()
	} else {
		release()
	}
}, { immediate: true })

onBeforeUnmount(release)
</script>

<style scoped>
.app-dialog-enter-active,
.app-dialog-leave-active { transition: opacity 0.12s ease; }
.app-dialog-enter-active .app-dialog-panel,
.app-dialog-leave-active .app-dialog-panel { transition: transform 0.12s ease; }
.app-dialog-enter-from,
.app-dialog-leave-to { opacity: 0; }
.app-dialog-enter-from .app-dialog-panel,
.app-dialog-leave-to .app-dialog-panel { transform: scale(0.98); }
</style>
