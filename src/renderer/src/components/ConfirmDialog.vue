<template>
	<AppDialog :model-value="!!request" :title="request?.title ?? lastTitle" size="sm"
		@update:model-value="onDismiss">
		<div v-if="request" class="flex gap-3">
			<span v-if="tone" class="iconify w-4 h-4 mt-0.5 shrink-0" :class="[tone.icon, tone.cls]"></span>
			<div class="min-w-0 space-y-2">
				<p v-if="request.message" class="text-xs leading-relaxed text-zinc-700 dark:text-zinc-200 whitespace-pre-line break-words">{{ request.message }}</p>
				<p v-if="request.detail" class="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400 whitespace-pre-line break-words">{{ request.detail }}</p>
			</div>
		</div>

		<template #footer>
			<template v-if="request">
				<button v-for="action in request.actions" :key="action.label"
					:class="action.primary ? ['btn-fill', action.danger ? 'btn-fill-danger' : ''] : ['btn-text', action.danger ? 'btn-text-danger' : '']"
					@click="dialogHost.settle(request.id, action.value)">{{ action.label }}</button>
			</template>
		</template>
	</AppDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppDialog from './AppDialog.vue'
import { dialogHost } from '../composables/useDialog'

/**
 * The single host for `dialog.confirm / notify / choose`. Mounted once in
 * App.vue; it shows whatever request is at the head of the queue.
 */
const request = dialogHost.current

// Keep the title while the leave transition fades the panel out.
const lastTitle = ref('')
watch(request, (r) => { if (r) lastTitle.value = r.title })

const TONES = {
	info: { icon: 'tabler--info-circle', cls: 'text-primary' },
	warning: { icon: 'tabler--alert-triangle', cls: 'text-amber-500' },
	error: { icon: 'tabler--alert-circle', cls: 'text-red-500' },
	success: { icon: 'tabler--circle-check', cls: 'text-accent' }
} as const

const tone = computed(() => {
	const t = request.value?.tone
	return t && t !== 'neutral' ? TONES[t] : null
})

// Esc / backdrop / X: answer with the request's dismiss value.
const onDismiss = (open: boolean) => {
	if (!open && request.value) dialogHost.settle(request.value.id, request.value.dismissValue)
}
</script>
