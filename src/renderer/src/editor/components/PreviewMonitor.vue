<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<!-- Empty state -->
		<div v-if="!videoSrc" class="flex-1 flex flex-col items-center justify-center gap-3 bg-zinc-950/[0.03] dark:bg-black/40">
			<div class="w-14 h-14 rounded-2xl bg-zinc-500/10 flex items-center justify-center text-zinc-400">
				<span class="iconify tabler--player-play w-7 h-7"></span>
			</div>
			<p class="text-xs text-zinc-500 dark:text-zinc-400 font-medium">Import media to preview</p>
		</div>

		<template v-else>
			<!-- Video well -->
			<div class="flex-1 min-h-0 bg-black flex items-center justify-center relative">
				<video ref="videoRef" :src="videoSrc" class="max-h-full max-w-full" preload="metadata"
					@loadedmetadata="onLoadedMetadata" @timeupdate="onTimeUpdate" @play="playing = true"
					@pause="playing = false"></video>

				<!-- Clip range badge -->
				<div v-if="activeClip"
					class="absolute top-2 left-2 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm text-[10px] font-mono text-white/90">
					Piece #{{ activeClip.index }} · {{ format(activeClip.in) }}–{{ format(activeClip.out) }}
				</div>
			</div>

			<!-- Transport -->
			<div class="px-4 py-2.5 flex items-center gap-3 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
				<button
					class="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-95"
					@click="togglePlay">
					<span :class="playing ? 'iconify tabler--player-pause-filled' : 'iconify tabler--player-play-filled'"
						class="w-3.5 h-3.5"></span>
				</button>
				<span class="text-[11px] font-mono text-zinc-600 dark:text-zinc-300">
					{{ format(currentTime) }} <span class="text-zinc-400">/ {{ format(duration) }}</span>
				</span>
				<!-- Scrub bar -->
				<input type="range" class="flex-1 accent-primary h-1 cursor-pointer" min="0" :max="duration || 0"
					step="0.05" :value="currentTime" @input="onScrub" />
			</div>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useEditorStore } from '../../stores/editorStore'

const editorStore = useEditorStore()

const videoRef = ref<HTMLVideoElement | null>(null)
const playing = ref(false)
const currentTime = ref(0)
const duration = ref(0)

const activeClip = computed(() => editorStore.selectedClip)

const videoSrc = computed(() => {
	const asset = activeClip.value
		? editorStore.assets.find((a) => a.id === activeClip.value!.sourceAssetId)
		: editorStore.selectedAsset
	if (!asset) return null
	const path = asset.proxyPath || asset.originalPath
	return path ? `media://${path}` : null
})

const format = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	const ms = Math.floor((seconds % 1) * 10)
	return `${m}:${String(s).padStart(2, '0')}.${ms}`
}

const onLoadedMetadata = () => {
	const video = videoRef.value
	if (!video) return
	duration.value = video.duration || 0
	if (activeClip.value) {
		video.currentTime = activeClip.value.in
	}
}

const onTimeUpdate = () => {
	const video = videoRef.value
	if (!video) return
	currentTime.value = video.currentTime
	// Pause at clip out-point when previewing a piece
	if (activeClip.value && playing.value && video.currentTime >= activeClip.value.out) {
		video.pause()
	}
}

const onScrub = (event: Event) => {
	const video = videoRef.value
	if (!video) return
	const value = parseFloat((event.target as HTMLInputElement).value)
	video.currentTime = value
	currentTime.value = value
}

const togglePlay = () => {
	const video = videoRef.value
	if (!video) return
	if (video.paused) {
		// Restart from clip in-point if we're at/past its end
		if (activeClip.value && video.currentTime >= activeClip.value.out - 0.05) {
			video.currentTime = activeClip.value.in
		}
		video.play()
	} else {
		video.pause()
	}
}

// Seek to the clip in-point whenever the focused clip changes
watch(activeClip, (clip) => {
	const video = videoRef.value
	if (!video || !clip) return
	video.currentTime = clip.in
	currentTime.value = clip.in
})
</script>
