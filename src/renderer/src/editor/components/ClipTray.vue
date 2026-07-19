<template>
	<div class="border-t border-zinc-200 dark:border-zinc-800 px-3 py-2.5">
		<div class="flex items-center justify-between mb-2">
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
				Pieces
				<span v-if="clips.length > 0" class="text-zinc-400 normal-case tracking-normal font-mono ml-1">
					{{ selectedCount }}/{{ clips.length }}
				</span>
			</span>

			<div class="flex items-center gap-0.5">
				<!-- Merge / split selected pieces (§5.2 corrections) -->
				<button v-if="selectedCount >= 2" title="Merge selected pieces"
					class="p-1 rounded-md text-zinc-400 hover:text-primary hover:bg-primary/10 transition"
					@click="onMerge">
					<span class="iconify tabler--arrows-join w-3.5 h-3.5 block"></span>
				</button>
				<button v-if="selectedCount >= 1" title="Split selected pieces in half"
					class="p-1 rounded-md text-zinc-400 hover:text-primary hover:bg-primary/10 transition"
					@click="onSplit">
					<span class="iconify tabler--arrows-split-2 w-3.5 h-3.5 block"></span>
				</button>
				<!-- Detector sensitivity toggle (scene-based; N/A for audio) -->
				<button v-if="!isAudio" title="Scene detector sensitivity"
					class="p-1 rounded-md transition"
					:class="showDetector ? 'text-primary bg-primary/10' : 'text-zinc-400 hover:text-primary hover:bg-primary/10'"
					@click="showDetector = !showDetector">
					<span class="iconify tabler--adjustments-horizontal w-3.5 h-3.5 block"></span>
				</button>
			</div>
		</div>

		<!-- Detector sensitivity (§5.2) — re-runs scene detection -->
		<div v-if="showDetector && !isAudio" class="mb-2 p-2 rounded-lg bg-zinc-100/70 dark:bg-zinc-900/50">
			<div class="flex items-center gap-2">
				<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400 shrink-0">Threshold</span>
				<input type="range" min="5" max="60" step="1" v-model.number="threshold"
					class="flex-1 accent-primary min-w-0" />
				<span class="font-mono text-[11px] text-zinc-600 dark:text-zinc-300 w-6 text-right">{{ threshold }}</span>
			</div>
			<div class="mt-1.5 flex items-center justify-between gap-2">
				<p class="text-[9px] text-zinc-400 leading-snug">
					Lower finds more pieces. Re-detecting rebuilds the tray (manual merges/splits are lost).
				</p>
				<button
					class="shrink-0 px-2 py-1 rounded-lg border border-primary/40 text-primary text-[10px] font-bold hover:bg-primary/10 transition active:scale-95 disabled:opacity-50"
					:disabled="isProcessing || !asset" @click="onRedetect">
					Re-detect
				</button>
			</div>
		</div>

		<p v-if="trayError" class="mb-1.5 text-[10px] text-red-500">{{ trayError }}</p>

		<!-- Skeletons while scene detection / thumbnails run -->
		<div v-if="isProcessing && clips.length === 0" class="flex gap-2 overflow-hidden">
			<div v-for="i in 4" :key="i"
				class="w-20 h-12 rounded-lg bg-zinc-200 dark:bg-zinc-800 animate-pulse-soft shrink-0"></div>
		</div>

		<!-- No pieces -->
		<p v-else-if="clips.length === 0 && asset?.preprocessState === 'completed'"
			class="text-[11px] text-zinc-400 py-2">
			{{ isAudio ? 'No pieces in this audio.' : 'No scenes detected in this video.' }}
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
import { computed, ref, watch } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import ClipTile from './ClipTile.vue'

const editorStore = useEditorStore()

const asset = computed(() => editorStore.selectedAsset)
const isAudio = computed(() => asset.value?.kind === 'audio')
const clips = computed(() => asset.value?.clips ?? [])
const selectedCount = computed(() => clips.value.filter((c) => c.selected).length)
const isProcessing = computed(() => asset.value?.preprocessState === 'running')

const showDetector = ref(false)
const threshold = ref(27) // PySceneDetect detect-content default
const trayError = ref<string | null>(null)

watch(() => asset.value?.id, () => { trayError.value = null })

const onRedetect = () => {
	if (!asset.value) return
	trayError.value = null
	editorStore.redetectScenes(asset.value.id, threshold.value)
}

const onMerge = async () => {
	if (!asset.value) return
	trayError.value = await editorStore.mergeSelectedClips(asset.value.id)
}

const onSplit = async () => {
	if (!asset.value) return
	trayError.value = await editorStore.splitSelectedClips(asset.value.id)
}
</script>
