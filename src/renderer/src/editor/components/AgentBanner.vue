<template>
	<div v-if="session"
		class="flex items-center gap-2.5 py-[5px] pl-3 pr-1.5 rounded-xl bg-secondary/[0.12] border border-secondary/[0.35]">
		<span class="w-2 h-2 rounded-full bg-secondary-light shadow-[0_0_0_3px_rgba(167,139,250,0.25)] shrink-0"></span>
		<span class="text-xs font-bold text-violet-700 dark:text-violet-200 whitespace-nowrap">{{ session.clientName }} is editing</span>
		<span class="font-mono text-[10px] text-secondary-light whitespace-nowrap">via MCP · {{ steps }} · {{ elapsed }}</span>
		<button
			class="px-2.5 py-[3px] rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-[10px] font-bold flex items-center gap-1 transition hover:bg-red-500/20"
			:title="`Disconnect ${session.clientName}`" @click="agent.disconnect(session.id)">
			<svg width="10" height="10" viewBox="0 0 24 24" class="fill-current" aria-hidden="true"><path d="M6 6h12v12H6z"></path></svg>
			Stop
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentStore } from '../../stores/agentStore'

/**
 * "Claude Code is editing · via MCP · 9 steps · 2:31" in the editor header
 * (board 3). Stop disconnects that session — the same as Disconnect in the
 * Agent tab.
 */

const agent = useAgentStore()
const session = computed(() => agent.liveSession)

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
