<template>
	<!-- No <Handle> here, unlike the chat-graph nodes, and that is deliberate:
	     with empty handleBounds Vue Flow falls back to bottom-centre -> top-centre
	     anchoring, which is exactly what this vertical tree layout wants. Verified
	     rendering as `M110,95 C… 110,170` for 220px nodes at ROW_H 170. Adding
	     handles would only put two invisible nodes in every card. -->
	<div class="group rounded-2xl border-2 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xl shadow-premium transition relative"
		:class="[
			compact ? 'w-[148px] p-2' : 'w-[220px] p-2.5',
			isCurrent
				? 'border-primary ring-2 ring-primary/30'
				: 'border-zinc-200 dark:border-zinc-700 hover:border-primary/40',
			disabled ? 'opacity-50 pointer-events-none' : 'cursor-pointer'
		]"
		:title="title"
		@click="switchTo">

		<!-- Header row -->
		<div class="flex items-center gap-1.5" :class="compact ? 'mb-1' : 'mb-1.5'">
			<span class="text-[10px] font-bold text-primary font-mono shrink-0">V{{ revision.seq }}</span>
			<span class="leading-none shrink-0" :title="origin.title">
				<span v-if="origin.icon" class="iconify w-3 h-3" :class="[origin.icon, origin.iconClass]"></span>
				<span v-else class="text-xs">{{ personaIcon }}</span>
			</span>
			<span class="flex-1 min-w-0 text-[10px] font-bold text-zinc-700 dark:text-zinc-300 truncate">
				{{ revision.label }}
				<span v-if="isDirtyHere" class="text-amber-500" title="Unsaved changes since this revision">*</span>
			</span>
			<span v-if="isCurrent" class="iconify tabler--check w-3 h-3 text-primary shrink-0"></span>
		</div>

		<!-- Thumb strip -->
		<div class="flex gap-1 mb-1" :class="compact ? 'h-7' : 'h-9'">
			<template v-if="thumbs.length">
				<img v-for="(thumb, i) in thumbs" :key="i" :src="thumb"
					class="flex-1 min-w-0 h-full object-cover rounded-md" loading="lazy" />
			</template>
			<div v-else class="flex-1 h-full rounded-md bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center">
				<span class="iconify tabler--movie w-3.5 h-3.5 text-zinc-400"></span>
			</div>
		</div>

		<!-- Compact cards drop the footer; the header already carries the identity -->
		<p v-if="!compact" class="text-[9px] text-zinc-400 leading-none">
			{{ itemCount }} clips · {{ time }}
		</p>

		<!-- Delete subtree. More legible here than in the list: you can see what goes. -->
		<button v-if="canDelete"
			class="absolute -top-2 -right-2 w-5 h-5 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:border-red-500/40 transition shadow-sm"
			title="Delete this revision and its descendants"
			@click.stop="remove">
			<span class="iconify tabler--trash w-3 h-3"></span>
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { EditorRevision } from '@shared/types'
import { useRevisionCard } from '../composables/useRevisionCard'

const props = defineProps<{
	/** Vue Flow passes node data through here. */
	data: { revision: EditorRevision; compact?: boolean }
}>()

const revision = computed(() => props.data.revision)
const compact = computed(() => !!props.data.compact)

const {
	isCurrent, isDirtyHere, disabled, canDelete,
	thumbs, time, itemCount, origin, personaIcon, title, switchTo, remove
} = useRevisionCard(revision, { thumbCount: compact.value ? 1 : 3 })
</script>
