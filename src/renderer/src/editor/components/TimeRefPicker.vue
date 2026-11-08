<template>
	<div class="absolute bottom-full left-0 mb-2 w-60 pop z-50 py-1 origin-bottom animate-menu" role="listbox"
		data-testid="time-ref-picker" @mousedown.prevent>
		<p class="px-3 pt-0.5 pb-1 text-[9px] font-bold uppercase tracking-widest text-zinc-400">Refer to a moment</p>
		<button v-for="(row, i) in options" :key="row.id" role="option" :aria-selected="i === active"
			class="w-full px-3 py-1.5 flex items-center gap-2 text-left transition"
			:class="i === active ? 'bg-primary/10' : 'hover:bg-primary/5'"
			@mouseenter="$emit('hover', i)" @click="$emit('pick', row)">
			<span class="iconify w-3 h-3 shrink-0"
				:class="row.frame ? 'tabler--camera text-accent' : row.id.startsWith('marker') ? 'tabler--bookmark text-secondary' : 'tabler--clock text-zinc-400'"></span>
			<span class="flex-1 min-w-0 truncate text-[11px] font-medium text-zinc-700 dark:text-zinc-300">{{ row.label }}</span>
			<span class="shrink-0 font-mono text-[10px]" :class="row.pastEnd ? 'text-amber-500' : 'text-zinc-400'"
				:title="row.pastEnd ? 'Past the end of the timeline' : undefined">
				{{ formatTimecode(row.sec) }}
			</span>
		</button>
		<p class="px-3 pt-1 text-[9px] text-zinc-400">Or type a time: @1:23, @83.5</p>
	</div>
</template>

<script setup lang="ts">
import { formatTimecode, type TimeRefOption } from '@shared/promptRefs'

/**
 * The list the @ picker shows above the composer. `mousedown.prevent` keeps
 * the field focused (and its caret where it was) while a row is clicked.
 */
defineProps<{ options: TimeRefOption[]; active: number }>()
defineEmits<{ (e: 'pick', row: TimeRefOption): void; (e: 'hover', index: number): void }>()
</script>
