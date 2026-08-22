<template>
	<div class="relative flex flex-col min-h-0 gap-1.5" :style="{ width: width + 'px' }">
		<ResizeHandle direction="vertical" reverse class="absolute inset-y-0 -left-2.5 z-20"
			@resize="$emit('resize', $event)" @reset="$emit('reset-size')" />
		<div class="flex items-center gap-0.5 px-1 shrink-0">
			<button v-for="t in (['chat', 'revisions'] as const)" :key="t"
				class="px-2 py-1 rounded-lg text-[9px] font-bold uppercase tracking-widest transition relative"
				:class="tab === t
					? 'text-primary bg-primary/10'
					: 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'"
				@click="$emit('update:tab', t)">
				{{ t }}
				<span v-if="t === 'revisions' && revisionsBadge"
					class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-secondary animate-pulse-soft"></span>
			</button>
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
		<ChatPanel v-show="tab === 'chat'" class="flex-1 min-h-0" />
		<RevisionsPanel v-if="tab === 'revisions'" class="flex-1 min-h-0" />
	</div>
</template>

<script setup lang="ts">
import ChatPanel from './ChatPanel.vue'
import RevisionsPanel from './RevisionsPanel.vue'
import ResizeHandle from './ResizeHandle.vue'

/**
 * Chat/Revisions column. Rendered in ONE of two slots by VideoEditorPage:
 * inside the top zone (default) or as a full-height sibling of the workspace
 * column when `full` — the timeline then adapts to the remaining width.
 */
defineProps<{ width: number; full?: boolean; tab: 'chat' | 'revisions'; revisionsBadge?: boolean }>()
defineEmits<{
	(e: 'collapse'): void
	(e: 'toggle-full'): void
	(e: 'resize', deltaPx: number): void
	(e: 'reset-size'): void
	(e: 'update:tab', tab: 'chat' | 'revisions'): void
}>()
</script>
