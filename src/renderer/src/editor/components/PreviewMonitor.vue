<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<!-- Mode switch -->
		<div class="px-3 pt-2 pb-1 flex items-center justify-between shrink-0">
			<div class="flex items-center bg-zinc-100/80 dark:bg-zinc-900/80 rounded-lg p-0.5 border border-zinc-200 dark:border-zinc-800">
				<button v-for="m in (['source', 'timeline'] as const)" :key="m"
					class="px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-widest transition"
					:class="mode === m
						? 'bg-primary text-white shadow-md shadow-primary/20 ring-1 ring-primary/20'
						: 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'"
					@click="mode = m">
					{{ m }}
				</button>
			</div>
			<span v-if="mode === 'timeline' && edl.currentSegmentId.value" class="text-[9px] font-mono text-zinc-400 truncate max-w-[50%]">
				{{ activeSegmentLabel }}
			</span>
		</div>

		<!-- ============ SOURCE MODE ============ -->
		<template v-if="mode === 'source'">
			<div v-if="!sourceSrc" class="flex-1 flex flex-col items-center justify-center gap-3 bg-zinc-950/[0.03] dark:bg-black/40">
				<div class="w-14 h-14 rounded-2xl bg-zinc-500/10 flex items-center justify-center text-zinc-400">
					<span class="iconify tabler--player-play w-7 h-7"></span>
				</div>
				<p class="text-xs text-zinc-500 dark:text-zinc-400 font-medium">Import or select media to preview</p>
			</div>
			<template v-else>
				<div class="flex-1 min-h-0 bg-black flex items-center justify-center relative">
					<video ref="sourceVideoRef" :src="sourceSrc" class="max-h-full max-w-full" preload="metadata"
						@loadedmetadata="onSourceLoaded" @timeupdate="onSourceTimeUpdate"
						@play="sourcePlaying = true" @pause="sourcePlaying = false"></video>
					<div v-if="activeClip"
						class="absolute top-2 left-2 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm text-[10px] font-mono text-white/90">
						Piece #{{ activeClip.index }} · {{ format(activeClip.in) }}–{{ format(activeClip.out) }}
					</div>
				</div>
				<div class="px-4 py-2.5 flex items-center gap-3 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
					<button
						class="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-95"
						@click="toggleSourcePlay">
						<span :class="sourcePlaying ? 'iconify tabler--player-pause-filled' : 'iconify tabler--player-play-filled'"
							class="w-3.5 h-3.5"></span>
					</button>
					<span class="text-[11px] font-mono text-zinc-600 dark:text-zinc-300">
						{{ format(sourceTime) }} <span class="text-zinc-400">/ {{ format(sourceDuration) }}</span>
					</span>
					<input type="range" class="flex-1 accent-primary h-1 cursor-pointer" min="0" :max="sourceDuration || 0"
						step="0.05" :value="sourceTime" @input="onSourceScrub" />
				</div>
			</template>
		</template>

		<!-- ============ TIMELINE MODE (EDL) ============ -->
		<template v-else>
			<div v-if="!edl.hasContent.value"
				class="flex-1 flex flex-col items-center justify-center gap-3 bg-zinc-950/[0.03] dark:bg-black/40">
				<div class="w-14 h-14 rounded-2xl bg-zinc-500/10 flex items-center justify-center text-zinc-400">
					<span class="iconify tabler--layout-list w-7 h-7"></span>
				</div>
				<p class="text-xs text-zinc-500 dark:text-zinc-400 font-medium">Timeline is empty — drag pieces onto a track</p>
			</div>
			<template v-else>
				<div class="flex-1 min-h-0 bg-black relative">
					<video ref="videoARef" class="absolute inset-0 w-full h-full object-contain transition-opacity"
						:class="edl.activeIsA.value && !edl.inGap.value ? 'opacity-100' : 'opacity-0'"
						preload="auto"></video>
					<video ref="videoBRef" class="absolute inset-0 w-full h-full object-contain transition-opacity"
						:class="!edl.activeIsA.value && !edl.inGap.value ? 'opacity-100' : 'opacity-0'"
						preload="auto"></video>
					<div v-if="edl.inGap.value"
						class="absolute inset-0 flex items-center justify-center pointer-events-none">
						<span class="text-[10px] font-mono text-white/30 uppercase tracking-widest">gap</span>
					</div>
				</div>
				<div class="px-4 py-2.5 flex items-center gap-3 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
					<button
						class="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-95"
						@click="store.isPlaying = !store.isPlaying">
						<span :class="store.isPlaying ? 'iconify tabler--player-pause-filled' : 'iconify tabler--player-play-filled'"
							class="w-3.5 h-3.5"></span>
					</button>
					<span class="text-[11px] font-mono text-zinc-600 dark:text-zinc-300">
						{{ format(store.playheadSec) }} <span class="text-zinc-400">/ {{ format(store.contentEnd) }}</span>
					</span>
					<input type="range" class="flex-1 accent-primary h-1 cursor-pointer" min="0"
						:max="store.contentEnd || 0" step="0.05" :value="store.playheadSec"
						@input="onTimelineScrub" />
				</div>
			</template>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import { useEdlPlayback } from '../composables/useEdlPlayback'

const store = useEditorStore()

const mode = ref<'source' | 'timeline'>('source')

// ===== EDL (timeline) mode =====
const videoARef = ref<HTMLVideoElement | null>(null)
const videoBRef = ref<HTMLVideoElement | null>(null)
const edl = useEdlPlayback(videoARef, videoBRef)

onMounted(() => edl.start())

const activeSegmentLabel = computed(() => {
	const item = store.doc?.timeline.find((i) => i.id === edl.currentSegmentId.value)
	return item?.label || ''
})

const onTimelineScrub = (event: Event) => {
	store.seekTo(parseFloat((event.target as HTMLInputElement).value))
}

// Auto-switch: tray clip selection → source; timeline item selection / play → timeline
watch(() => store.selectedClipId, (id) => { if (id) mode.value = 'source' })
watch(() => store.selectedItemIds, (ids) => { if (ids.length) mode.value = 'timeline' })
watch(() => store.isPlaying, (playing) => { if (playing) mode.value = 'timeline' })

// ===== Source mode (single asset / piece preview, from M1) =====
const sourceVideoRef = ref<HTMLVideoElement | null>(null)
const sourcePlaying = ref(false)
const sourceTime = ref(0)
const sourceDuration = ref(0)

const activeClip = computed(() => store.selectedClip)

const sourceSrc = computed(() => {
	const asset = activeClip.value
		? store.assets.find((a) => a.id === activeClip.value!.sourceAssetId)
		: store.selectedAsset
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

const onSourceLoaded = () => {
	const video = sourceVideoRef.value
	if (!video) return
	sourceDuration.value = video.duration || 0
	if (activeClip.value) video.currentTime = activeClip.value.in
}

const onSourceTimeUpdate = () => {
	const video = sourceVideoRef.value
	if (!video) return
	sourceTime.value = video.currentTime
	if (activeClip.value && sourcePlaying.value && video.currentTime >= activeClip.value.out) {
		video.pause()
	}
}

const onSourceScrub = (event: Event) => {
	const video = sourceVideoRef.value
	if (!video) return
	const value = parseFloat((event.target as HTMLInputElement).value)
	video.currentTime = value
	sourceTime.value = value
}

const toggleSourcePlay = () => {
	const video = sourceVideoRef.value
	if (!video) return
	if (video.paused) {
		if (activeClip.value && video.currentTime >= activeClip.value.out - 0.05) {
			video.currentTime = activeClip.value.in
		}
		video.play()
	} else {
		video.pause()
	}
}

watch(activeClip, (clip) => {
	const video = sourceVideoRef.value
	if (!video || !clip) return
	video.currentTime = clip.in
	sourceTime.value = clip.in
})
</script>
