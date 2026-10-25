<template>
	<!-- Over the editing surfaces while an outside agent works: the picture stays
	     visible (and Space still plays it), but nothing can be dragged, trimmed or
	     typed into under the agent mid-round. -->
	<div v-if="lock" class="absolute inset-0 z-40 agent-scrim ring-2 ring-inset ring-secondary/35"
		@pointerdown.prevent.stop="agent.nudgeWorking()" @wheel.passive.stop @contextmenu.prevent.stop>
		<div class="absolute left-1/2 -translate-x-1/2 bottom-4 flex items-center gap-2 px-3 h-8 rounded-full pop shadow-lg pointer-events-none">
			<span class="iconify tabler--lock w-3.5 h-3.5 text-secondary-light"></span>
			<span class="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 whitespace-nowrap">
				Editing paused · {{ lock.clientName }} is working over MCP
			</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentStore } from '../../stores/agentStore'

const agent = useAgentStore()
const lock = computed(() => agent.mcpWorking)
</script>

<style scoped>
.agent-scrim {
	cursor: not-allowed;
	background: repeating-linear-gradient(-45deg, rgb(139 92 246 / 0.035) 0 10px, transparent 10px 20px);
}
</style>
