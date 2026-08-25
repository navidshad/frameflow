<template>
	<div class="group flex items-center gap-2 px-2 py-1.5 rounded-xl transition mb-1"
		:class="[
			isCurrent
				? 'ring-1 ring-primary/40 bg-primary/5 dark:bg-primary/10'
				: 'hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40',
			disabled ? 'opacity-50 pointer-events-none' : 'cursor-pointer'
		]"
		:style="{ paddingLeft: `${8 + Math.min(depth, 6) * 12}px` }"
		:title="title"
		@click="switchTo">

		<!-- Thumb -->
		<div class="w-10 h-6 rounded-md overflow-hidden bg-zinc-200 dark:bg-zinc-800 shrink-0 flex items-center justify-center">
			<img v-if="thumbs[0]" :src="thumbs[0]" class="w-full h-full object-cover" loading="lazy" />
			<span v-else class="iconify tabler--movie w-3 h-3 text-zinc-400"></span>
		</div>

		<!-- V pill + origin icon -->
		<span class="text-[10px] font-bold text-primary font-mono shrink-0">V{{ revision.seq }}</span>
		<span class="shrink-0 leading-none" :title="origin.title">
			<span v-if="origin.icon" class="iconify w-3 h-3" :class="[origin.icon, origin.iconClass]"></span>
			<span v-else class="text-xs">{{ personaIcon }}</span>
		</span>

		<!-- Label + time -->
		<div class="flex-1 min-w-0">
			<p class="text-[11px] font-medium text-zinc-700 dark:text-zinc-300 truncate leading-tight">
				{{ revision.label }}
				<span v-if="isDirtyHere" class="text-amber-500" title="Unsaved changes since this revision">*</span>
			</p>
			<p class="text-[9px] text-zinc-400 leading-tight">{{ time }}</p>
		</div>

		<!-- Delete subtree (root undeletable) -->
		<button v-if="canDelete"
			class="w-5 h-5 flex items-center justify-center rounded text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-500/10 transition shrink-0"
			title="Delete this revision and its descendants"
			@click.stop="remove">
			<span class="iconify tabler--trash w-3 h-3"></span>
		</button>
	</div>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import type { EditorRevision } from '@shared/types'
import { useRevisionCard } from '../composables/useRevisionCard'

const props = defineProps<{
	revision: EditorRevision
	depth: number
}>()

const {
	isCurrent, isDirtyHere, disabled, canDelete,
	thumbs, time, origin, personaIcon, title, switchTo, remove
} = useRevisionCard(toRef(props, 'revision'), { thumbCount: 1 })
</script>
