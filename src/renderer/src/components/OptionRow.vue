<template>
	<!-- A radio or checkbox row: the mark, a title, one line of explanation. -->
	<button type="button" :role="kind" :aria-checked="checked" :disabled="disabled"
		class="w-full text-left flex gap-2.5 py-[7px] disabled:opacity-50" @click="$emit('toggle')">
		<span v-if="kind === 'radio'" class="w-4 h-4 mt-px rounded-full box-border shrink-0 transition-colors"
			:class="checked ? `border-[5px] ${accentBorder}` : 'border-2 border-zinc-400 dark:border-zinc-600'"></span>
		<span v-else-if="checked" class="w-4 h-4 mt-px rounded flex items-center justify-center text-white shrink-0" :class="accentBg">
			<span class="iconify tabler--check w-3 h-3"></span>
		</span>
		<span v-else class="w-4 h-4 mt-px rounded border border-zinc-400 dark:border-zinc-600 shrink-0"></span>
		<span class="min-w-0">
			<span class="block text-xs font-semibold text-zinc-900 dark:text-zinc-50">
				<slot name="label">{{ label }}</slot>
			</span>
			<span v-if="description" class="block text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{{ description }}</span>
		</span>
	</button>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
	checked: boolean
	kind?: 'radio' | 'checkbox'
	label?: string
	description?: string
	/** primary (default) or violet for AI options. */
	tone?: 'primary' | 'ai'
	disabled?: boolean
}>(), { kind: 'checkbox', tone: 'primary' })

defineEmits<{ (e: 'toggle'): void }>()

const accentBorder = computed(() => (props.tone === 'ai' ? 'border-secondary' : 'border-primary'))
const accentBg = computed(() => (props.tone === 'ai' ? 'bg-secondary' : 'bg-primary'))
</script>
