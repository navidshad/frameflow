<template>
	<!-- An outside agent holds the project: say so across the whole editor, under
	     the top bar, for as long as its round is open. -->
	<div v-if="lock" role="status" aria-live="polite"
		class="agent-strip relative h-9 shrink-0 flex items-center gap-2.5 px-3.5 hair-b overflow-hidden bg-secondary/[0.09]"
		:class="{ 'agent-strip-nudge': nudging }">
		<span class="agent-sweep absolute inset-y-0 w-1/3 pointer-events-none" aria-hidden="true"></span>
		<span class="relative w-3.5 h-3.5 rounded-full border-2 border-secondary-light border-t-transparent animate-spin shrink-0"></span>
		<span class="relative text-xs font-bold text-violet-700 dark:text-violet-300 whitespace-nowrap">
			{{ lock.clientName }} is working on this project
		</span>
		<span class="relative text-[11px] text-zinc-500 dark:text-zinc-400 truncate min-w-0">
			Round {{ lock.seq }}<template v-if="lock.goal"> · {{ lock.goal }}</template>
		</span>
		<span class="relative font-mono text-[10px] text-zinc-500 whitespace-nowrap shrink-0">
			{{ lock.steps }} step{{ lock.steps === 1 ? '' : 's' }} · {{ elapsed }}
		</span>
		<span class="flex-1"></span>
		<span class="relative hidden lg:inline text-[11px] text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
			Hands off until it ends its round. The chat is read-only meanwhile.
		</span>
		<button
			class="relative shrink-0 px-2 h-6 rounded-md text-[11px] font-semibold text-red-500 hover:bg-red-500/10 transition"
			:title="`End ${lock.clientName}’s round and disconnect it`"
			@click="agent.stopRound()">
			Stop agent
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { elapsedClock } from '@shared/agentRounds'
import { useAgentStore } from '../../stores/agentStore'

/**
 * "Claude Code is working on this project · Round 3 · Tighten the intro ·
 * 12 steps · 4:12" — the editor-wide working state while an MCP agent holds
 * the project. Stop ends its round and disconnects it.
 */

const agent = useAgentStore()
const lock = computed(() => agent.mcpWorking)
const elapsed = computed(() => (lock.value ? elapsedClock(agent.now - lock.value.startedAt) : ''))

// A blocked edit (a click on the scrim, an editing shortcut) pulses the strip.
const nudging = ref(false)
watch(() => agent.nudges, () => {
	nudging.value = false
	requestAnimationFrame(() => { nudging.value = true })
	setTimeout(() => { nudging.value = false }, 700)
})
</script>

<style scoped>
.agent-sweep {
	background: linear-gradient(90deg, transparent, rgb(139 92 246 / 0.14), transparent);
	animation: agent-sweep 2.4s ease-in-out infinite;
}
@keyframes agent-sweep {
	from { left: -33%; }
	to { left: 100%; }
}
.agent-strip-nudge {
	animation: agent-nudge 0.7s ease-out;
}
@keyframes agent-nudge {
	0% { background-color: rgb(139 92 246 / 0.32); }
	100% { background-color: rgb(139 92 246 / 0.09); }
}
@media (prefers-reduced-motion: reduce) {
	.agent-sweep { animation: none; display: none; }
	.agent-strip-nudge { animation: none; }
}
</style>
