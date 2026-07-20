<template>
	<div class="w-[220px] rounded-2xl border-2 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-xl shadow-premium p-2.5 cursor-pointer transition"
		:class="isCurrent
			? 'border-primary ring-2 ring-primary/30'
			: 'border-zinc-200 dark:border-zinc-700 hover:border-primary/40'"
		@click="onClick">
		<!-- Header row -->
		<div class="flex items-center gap-1.5 mb-1.5">
			<span class="text-[10px] font-bold text-primary font-mono">V{{ revision.seq }}</span>
			<span class="leading-none">
				<span v-if="revision.origin === 'ai'" class="text-xs">{{ personaIcon }}</span>
				<span v-else-if="revision.origin === 'manual'" class="iconify tabler--bookmark w-3 h-3 text-secondary"></span>
				<span v-else class="iconify tabler--flag w-3 h-3 text-zinc-400"></span>
			</span>
			<span class="flex-1 text-[10px] font-bold text-zinc-700 dark:text-zinc-300 truncate">{{ revision.label }}</span>
			<span v-if="isCurrent" class="iconify tabler--check w-3 h-3 text-primary shrink-0"></span>
		</div>

		<!-- Thumb strip -->
		<div class="flex gap-1 h-9 mb-1">
			<template v-if="thumbs.length">
				<img v-for="(thumb, i) in thumbs" :key="i" :src="thumb"
					class="flex-1 min-w-0 h-full object-cover rounded-md" loading="lazy" />
			</template>
			<div v-else class="flex-1 h-full rounded-md bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center">
				<span class="iconify tabler--movie w-3.5 h-3.5 text-zinc-400"></span>
			</div>
		</div>

		<p class="text-[9px] text-zinc-400 leading-none">
			{{ itemCount }} clips · {{ time }}
		</p>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { EditorRevision } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'
import { relativeTime, revisionThumbs } from '../utils/revisionThumbs'

const props = defineProps<{
	data: { revision: EditorRevision }
}>()

const store = useEditorStore()

const revision = computed(() => props.data.revision)
const isCurrent = computed(() => store.doc?.currentRevisionId === revision.value.id)
const thumbs = computed(() => revisionThumbs(revision.value, store.doc, 3))
const itemCount = computed(() => revision.value.snapshot.timeline.length)
const time = computed(() => relativeTime(revision.value.createdAt))

const personaIcon = computed(() =>
	store.personas.find((p) => p.id === revision.value.personaId)?.icon || '✨'
)

const onClick = () => {
	if (!isCurrent.value) store.switchRevision(revision.value.id)
}
</script>
