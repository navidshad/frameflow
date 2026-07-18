<template>
	<div class="relative w-20 shrink-0 cursor-pointer group" @click="onClick">
		<!-- Thumb -->
		<div class="w-20 h-12 rounded-lg overflow-hidden border-2 transition bg-zinc-200 dark:bg-zinc-800"
			:class="clip.selected
				? 'border-primary ring-1 ring-primary/30'
				: active
					? 'border-secondary/60'
					: 'border-transparent group-hover:border-zinc-300 dark:group-hover:border-zinc-600'">
			<img v-if="clip.thumbnailPath" :src="`media://${clip.thumbnailPath}`"
				class="w-full h-full object-cover" loading="lazy" />
			<div v-else class="w-full h-full flex items-center justify-center">
				<span class="iconify tabler--photo w-4 h-4 text-zinc-400"></span>
			</div>
		</div>

		<!-- Selection toggle (always visible when selected; on hover otherwise) -->
		<button
			class="absolute top-0.5 right-0.5 w-4 h-4 rounded-full flex items-center justify-center shadow transition"
			:class="clip.selected
				? 'bg-primary'
				: 'bg-zinc-900/50 opacity-0 group-hover:opacity-100 hover:bg-primary/80'"
			title="Toggle piece selection"
			@click.stop="editorStore.toggleClipSelected(clip.id)">
			<span class="iconify tabler--check w-2.5 h-2.5 text-white"></span>
		</button>

		<!-- Index + timecode -->
		<div class="mt-1 flex items-center justify-between px-0.5">
			<span class="text-[9px] font-bold text-zinc-500">#{{ clip.index }}</span>
			<span class="text-[8px] font-mono text-zinc-400">{{ timecode }}</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Clip } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'

const props = defineProps<{
	clip: Clip
	active: boolean
}>()

const editorStore = useEditorStore()

const format = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	return `${m}:${String(s).padStart(2, '0')}`
}

const timecode = computed(() => `${format(props.clip.in)}–${format(props.clip.out)}`)

const onClick = (event: MouseEvent) => {
	// Plain click: focus the clip (preview + inspector). Cmd/Ctrl+click: toggle selection.
	if (event.metaKey || event.ctrlKey) {
		editorStore.toggleClipSelected(props.clip.id)
	} else {
		editorStore.selectClip(props.clip.id === editorStore.selectedClipId ? null : props.clip.id)
	}
}
</script>
