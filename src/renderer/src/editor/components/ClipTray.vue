<template>
	<div class="border-t border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
		<div class="flex items-center justify-between mb-2">
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
				Pieces
				<span v-if="clips.length > 0" class="text-zinc-400 normal-case tracking-normal font-mono ml-1">
					{{ selectedCount }}/{{ clips.length }}
				</span>
			</span>
		</div>

		<!-- Skeletons while scene detection / thumbnails run -->
		<div v-if="isProcessing && clips.length === 0" class="flex gap-2 overflow-hidden">
			<div v-for="i in 4" :key="i"
				class="w-20 h-12 rounded-lg bg-zinc-200 dark:bg-zinc-800 animate-pulse-soft shrink-0"></div>
		</div>

		<!-- No scenes -->
		<p v-else-if="clips.length === 0 && asset?.preprocessState === 'completed'"
			class="text-[11px] text-zinc-400 py-2">
			No scenes detected in this video.
		</p>

		<p v-else-if="clips.length === 0" class="text-[11px] text-zinc-400 py-2">
			Pieces appear here after processing.
		</p>

		<!-- Clip tiles -->
		<div v-else class="flex gap-2 overflow-x-auto custom-scrollbar pb-1">
			<ClipTile v-for="clip in clips" :key="clip.id" :clip="clip"
				:active="clip.id === editorStore.selectedClipId" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import ClipTile from './ClipTile.vue'

const editorStore = useEditorStore()

const asset = computed(() => editorStore.selectedAsset)
const clips = computed(() => asset.value?.clips ?? [])
const selectedCount = computed(() => clips.value.filter((c) => c.selected).length)
const isProcessing = computed(() => asset.value?.preprocessState === 'running')
</script>
