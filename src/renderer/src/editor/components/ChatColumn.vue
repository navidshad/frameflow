<template>
	<aside class="relative flex flex-col min-h-0 shrink-0 hair-l" :style="{ width: width + 'px' }">
		<ResizeHandle direction="vertical" reverse class="absolute inset-y-0 -left-1 z-20"
			@resize="$emit('resize', $event)" @reset="$emit('reset-size')" />
		<div class="h-10 shrink-0 hair-b flex items-end gap-3.5 px-3.5">
			<button v-for="t in tabs" :key="t"
				class="tab-u capitalize flex items-center gap-1.5 !h-[39px]"
				:class="{ 'tab-u-active': tab === t }"
				@click="$emit('update:tab', t)">
				{{ t }}
				<span v-if="t === 'revisions' && revisionsBadge" class="w-1.5 h-1.5 rounded-full bg-primary-light"></span>
				<span v-if="t === 'agent' && agent.liveSession && tab !== 'agent'" class="w-1.5 h-1.5 rounded-full bg-accent-light"></span>
			</button>
			<div class="flex-1"></div>
			<SlimTooltip text="Fold to a composer under the picture" placement="bottom">
				<button class="w-6 h-[38px] flex items-center justify-center text-zinc-400 hover:text-primary transition"
					aria-label="Fold the chat to a composer strip" @click="$emit('collapse')">
					<span class="iconify tabler--layout-sidebar-right-collapse w-3.5 h-3.5"></span>
				</button>
			</SlimTooltip>
		</div>
		<ChatPanel v-show="tab === 'chat'" class="flex-1 min-h-0" />
		<RevisionsPanel v-if="tab === 'revisions'" class="flex-1 min-h-0" />
		<AgentPanel v-if="tab === 'agent'" class="flex-1 min-h-0" />
	</aside>
</template>

<script setup lang="ts">
import ChatPanel from './ChatPanel.vue'
import RevisionsPanel from './RevisionsPanel.vue'
import ResizeHandle from './ResizeHandle.vue'
import AgentPanel from './AgentPanel.vue'
import SlimTooltip from '../../components/SlimTooltip.vue'
import { computed } from 'vue'
import { useAgentStore } from '../../stores/agentStore'

/**
 * Chat / Revisions / Agent. A full-height column on the right of the window:
 * the timeline sits beside it, not under it, and nothing opens over it. It does
 * not close by itself — selecting a clip never opens, pushes or covers it. When
 * the person folds it, or the window is too narrow, the page shows a composer
 * strip under the picture instead (ComposerStrip).
 */
defineProps<{ width: number; tab: 'chat' | 'revisions' | 'agent'; revisionsBadge?: boolean }>()
defineEmits<{
	(e: 'collapse'): void
	(e: 'resize', deltaPx: number): void
	(e: 'reset-size'): void
	(e: 'update:tab', tab: 'chat' | 'revisions' | 'agent'): void
}>()

// The Agent tab (MCP) appears once agent access is on, or an agent has been here.
const agent = useAgentStore()
const tabs = computed(() =>
	agent.access?.enabled || agent.shownSession
		? (['chat', 'revisions', 'agent'] as const)
		: (['chat', 'revisions'] as const)
)
</script>
