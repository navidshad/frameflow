<template>
	<!-- Board 1: "5 steps" with the tool calls, mono, one per line -->
	<div v-if="steps.length"
		class="px-2.5 py-1.5 rounded-lg bg-zinc-500/5 border border-zinc-500/10 flex flex-col gap-1">
		<button class="flex items-center justify-between text-left" @click="open = !open">
			<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400">
				{{ steps.length }} step{{ steps.length === 1 ? '' : 's' }}
			</span>
			<span class="iconify w-3 h-3 text-zinc-500" :class="open ? 'tabler--chevron-up' : 'tabler--chevron-down'"></span>
		</button>
		<template v-if="open">
			<div v-for="step in steps" :key="step.id"
				class="font-mono text-[10px] text-zinc-400 flex gap-1.5 min-w-0"
				:title="step.error || step.title">
				<span v-if="step.status === 'done'" class="text-emerald-500 shrink-0">✓</span>
				<span v-else-if="step.status === 'running'"
					class="w-2.5 h-2.5 mt-[2px] rounded-full border-[1.5px] border-violet-400 border-t-transparent animate-spin shrink-0"></span>
				<span v-else class="text-red-500 shrink-0">✗</span>
				<span class="truncate" :class="{ 'text-red-400': step.foreign }">{{ step.title }}</span>
			</div>
		</template>
	</div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { PromptTurnEngine } from '@shared/types'

defineProps<{ steps: PromptTurnEngine['steps'] }>()

const open = ref(true)
</script>
