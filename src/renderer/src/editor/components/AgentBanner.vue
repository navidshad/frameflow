<template>
	<div v-if="session"
		class="flex items-center gap-2 h-[26px] px-3 hair-l hair-r">
		<span class="w-1.5 h-1.5 rounded-full bg-secondary-light shrink-0"></span>
		<span class="text-xs font-semibold text-violet-700 dark:text-violet-300 whitespace-nowrap">{{ session.clientName }}</span>
		<span class="text-[11px] text-zinc-500 whitespace-nowrap">is editing · via MCP · {{ steps }} · {{ elapsed }}</span>
		<button
			class="ml-1 text-[11px] font-semibold text-red-500 hover:text-red-400 transition"
			:title="`Disconnect ${session.clientName}`" @click="agent.disconnect(session.id)">
			Stop
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentStore } from '../../stores/agentStore'

/**
 * "Claude Code is editing · via MCP · 9 steps · 2:31" in the editor's top bar.
 * Stop disconnects that session — the same as Disconnect in the Agent tab.
 */

const agent = useAgentStore()
const session = computed(() => agent.editingSession)

const steps = computed(() => {
	const n = session.value?.steps ?? 0
	return `${n} step${n === 1 ? '' : 's'}`
})

/** Time since it connected, m:ss — ticks with the store's clock. */
const elapsed = computed(() => {
	if (!session.value) return ''
	const total = Math.max(0, Math.floor((agent.now - session.value.connectedAt) / 1000))
	const minutes = Math.floor(total / 60)
	return minutes >= 60
		? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
		: `${minutes}:${String(total % 60).padStart(2, '0')}`
})
</script>
