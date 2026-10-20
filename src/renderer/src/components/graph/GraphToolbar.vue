<template>
	<!-- A vertical tool column bounded by one hairline -->
	<div class="absolute left-4 top-4 z-30 flex flex-col gap-0.5 pr-1.5 hair-r" role="toolbar" aria-orientation="vertical" aria-label="Graph tools">
		<SlimTooltip v-for="tool in TOOLS" :key="tool.mode" :text="tool.label" placement="right">
			<button @click="$emit('update:modelValue', tool.mode)" :aria-label="tool.label" :aria-pressed="modelValue === tool.mode"
				class="flex items-center justify-center w-8 h-8 rounded-md transition-colors"
				:class="modelValue === tool.mode
					? 'bg-primary/15 text-primary'
					: 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-900/5 dark:hover:bg-white/5'">
				<span class="iconify w-4 h-4" :class="tool.icon"></span>
			</button>
		</SlimTooltip>
	</div>
</template>

<script setup lang="ts">
import SlimTooltip from '../SlimTooltip.vue'
type ToolMode = 'pan' | 'select' | 'frame'

defineProps<{
	modelValue: ToolMode
}>()

defineEmits<{
	(e: 'update:modelValue', value: ToolMode): void
}>()

const TOOLS: { mode: ToolMode; label: string; icon: string }[] = [
	{ mode: 'pan', label: 'Pan Tool', icon: 'tabler--hand-stop' },
	{ mode: 'select', label: 'Select Tool', icon: 'tabler--pointer' },
	{ mode: 'frame', label: 'Group Frames', icon: 'tabler--layout-grid' }
]
</script>
