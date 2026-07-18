<template>
	<div class="glass-card rounded-2xl flex flex-col overflow-hidden relative">
		<!-- Toolbar strip -->
		<div class="px-4 py-2 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 shrink-0">
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Timeline</span>
			<span
				class="px-2 py-0.5 rounded-full bg-secondary/10 text-secondary text-[9px] font-bold uppercase tracking-widest">
				Editing arrives in M2
			</span>
		</div>

		<!-- Track lanes (real track data, inert) -->
		<div class="flex-1 min-h-0 flex flex-col justify-center gap-1.5 px-3 py-2 opacity-60">
			<div v-for="track in tracks" :key="track.id" class="flex items-center gap-2 flex-1 min-h-0">
				<div
					class="w-10 shrink-0 flex items-center justify-center text-[9px] font-bold uppercase tracking-widest text-zinc-400">
					{{ track.name }}
				</div>
				<div class="flex-1 h-full rounded-lg border border-dashed flex items-center px-3"
					:class="laneClass(track.kind)">
					<span class="text-[10px] text-zinc-400 dark:text-zinc-500">
						{{ laneHint(track.kind) }}
					</span>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { TrackKind } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'

const editorStore = useEditorStore()

const tracks = computed(() =>
	[...(editorStore.doc?.tracks || [])].sort((a, b) => a.order - b.order)
)

const laneClass = (kind: TrackKind) => {
	switch (kind) {
		case 'video': return 'border-primary/25 bg-primary/[0.03]'
		case 'audio': return 'border-accent/25 bg-accent/[0.03]'
		default: return 'border-zinc-300/50 dark:border-zinc-700/50'
	}
}

const laneHint = (kind: TrackKind) => {
	switch (kind) {
		case 'video': return 'Video clips will land here'
		case 'audio': return 'Audio'
		default: return 'Overlays & other objects — later'
	}
}
</script>
