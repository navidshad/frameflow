<template>
	<div class="relative flex flex-col min-h-0 gap-1.5" :style="{ width: width + 'px' }">
		<ResizeHandle direction="vertical" reverse class="absolute inset-y-0 -left-2.5 z-20"
			@resize="$emit('resize', $event)" @reset="$emit('reset-size')" />
		<div class="flex items-center gap-1 px-1 shrink-0">
			<span class="text-[9px] font-bold uppercase tracking-widest text-primary bg-primary/10 px-2 py-1 rounded-lg">inspect</span>
			<button :title="full ? 'Back to top row' : 'Expand to full height'"
				class="ml-auto w-7 h-7 flex items-center justify-center rounded-lg transition active:scale-95 shrink-0"
				:class="full ? 'text-primary bg-primary/10' : 'text-zinc-400 hover:text-primary hover:bg-primary/10'"
				@click="$emit('toggle-full')">
				<span class="iconify tabler--arrow-autofit-height w-4 h-4"></span>
			</button>
			<button title="Collapse panel"
				class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-primary hover:bg-primary/10 transition active:scale-95 shrink-0"
				@click="$emit('collapse')">
				<span class="iconify tabler--layout-sidebar-right-collapse w-4 h-4"></span>
			</button>
		</div>
		<InspectorPanel class="flex-1 min-h-0" />
	</div>
</template>

<script setup lang="ts">
import InspectorPanel from './InspectorPanel.vue'
import ResizeHandle from './ResizeHandle.vue'

/**
 * Inspector column. Rendered in ONE of two slots by VideoEditorPage:
 * inside the top zone (default) or as a full-height sibling of the workspace
 * column when `full` — the timeline then adapts to the remaining width.
 */
defineProps<{ width: number; full?: boolean }>()
defineEmits<{
	(e: 'collapse'): void
	(e: 'toggle-full'): void
	(e: 'resize', deltaPx: number): void
	(e: 'reset-size'): void
}>()
</script>
