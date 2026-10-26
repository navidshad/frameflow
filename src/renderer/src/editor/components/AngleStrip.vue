<template>
	<!-- Every angle of the camera group under the playhead, at the same moment.
	     Clicking one cuts to it at the playhead — the number keys do the same. -->
	<div v-if="state" class="shrink-0 hair-t px-3.5 py-2 flex items-start gap-2 overflow-x-auto custom-scrollbar"
		data-testid="angle-strip">
		<button v-for="(a, i) in tiles" :key="a.camera.key"
			class="relative shrink-0 rounded-md overflow-hidden bg-stage transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed"
			:class="a.active ? 'ring-2 ring-primary' : 'ring-1 ring-black/10 dark:ring-white/10 hover:ring-primary/50'"
			:style="{ width: `${tileWidth}px`, aspectRatio: a.aspect }"
			:disabled="!!agent.mcpWorking || !a.recording"
			:title="a.recording ? `${a.camera.name}: cut here (${i + 1}) · Alt-click: the whole shot (Alt+${i + 1})` : `${a.camera.name} was not recording here`"
			:data-angle="i + 1"
			@click="pick(i + 1, $event)">
			<video :ref="(el) => setVideo(a.camera.key, el as HTMLVideoElement | null)"
				:src="a.src" muted playsinline preload="auto"
				class="w-full h-full object-cover" :class="a.recording ? '' : 'opacity-0'"></video>
			<span class="absolute top-1 left-1 min-w-[16px] h-4 px-1 rounded text-[10px] font-bold leading-4 text-center"
				:class="a.active ? 'bg-primary text-white' : 'bg-black/60 text-white'">{{ i + 1 }}</span>
			<span class="absolute bottom-0 inset-x-0 px-1.5 py-0.5 text-[10px] font-semibold text-white truncate text-left bg-gradient-to-t from-black/70 to-transparent">
				{{ a.camera.name }}
			</span>
			<span v-if="!a.recording" class="absolute inset-0 flex items-center justify-center text-[10px] text-zinc-500">
				not recording
			</span>
		</button>
		<div class="ml-1 self-center text-[10px] leading-snug text-zinc-500 min-w-[110px]">
			<p class="font-semibold text-zinc-600 dark:text-zinc-300 truncate">{{ state.group.name }}</p>
			<p>Press 1–{{ tiles.length }} to cut</p>
			<p v-if="sound" class="truncate"><span class="iconify tabler--microphone w-3 h-3 align-[-2px]"></span> {{ sound }}</p>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { anglesOf, memberAt, soundCameraOf, toSourceTime } from '@shared/multicam'
import { toMediaUrl } from '@shared/media-url'
import { useEditorStore } from '../../stores/editorStore'
import { useAgentStore } from '../../stores/agentStore'

const store = useEditorStore()
const agent = useAgentStore()
const tileWidth = 132

const state = computed(() => store.multicamAtPlayhead)
const sound = computed(() => state.value && store.doc ? soundCameraOf(state.value.group, store.doc.media)?.name : undefined)

/** One tile per camera, playing whichever of its files was recording at the playhead. */
const tiles = computed(() => {
	const s = state.value
	if (!s || !store.doc) return []
	const media = store.doc.media
	return anglesOf(s.group, media).map((camera) => {
		const member = s.groupTime === null ? undefined : memberAt(camera, s.groupTime, media)
		const asset = media.find((a) => a.id === (member ?? camera.members[0]).assetId)
		const length = asset?.metadata?.duration ?? 0
		const sourceSec = member && s.groupTime !== null ? toSourceTime(member, s.groupTime) : null
		const w = asset?.metadata?.width || 16, h = asset?.metadata?.height || 9
		return {
			camera,
			src: asset ? toMediaUrl(asset.proxyPath || asset.originalPath) : '',
			sourceSec,
			recording: sourceSec !== null && sourceSec >= 0 && sourceSec <= length,
			active: !!s.shot && camera.members.some((m) => m.assetId === s.shot!.sourceAssetId),
			aspect: `${w} / ${h}`
		}
	})
})

// ===== Keeping every angle on the playhead's moment =====
const videos = new Map<string, HTMLVideoElement>()
const setVideo = (key: string, el: HTMLVideoElement | null) => {
	if (el) videos.set(key, el)
	else videos.delete(key)
}

/** Seek when paused; when playing, let each run and only correct a real drift. */
const align = (hard: boolean) => {
	for (const t of tiles.value) {
		const el = videos.get(t.camera.key)
		if (!el || t.sourceSec === null || !t.recording) {
			el?.pause()
			continue
		}
		const drift = Math.abs(el.currentTime - t.sourceSec)
		if (hard ? drift > 0.03 : drift > 0.25) el.currentTime = t.sourceSec
		if (store.isPlaying && el.paused) el.play().catch(() => undefined)
		if (!store.isPlaying && !el.paused) el.pause()
	}
}

watch(() => [store.playheadSec, state.value?.groupTime], () => { if (!store.isPlaying) align(true) })
watch(() => store.isPlaying, () => align(true))
// A camera's next file swaps the source: seek the new one as soon as it can.
watch(() => tiles.value.map((t) => t.src).join('|'), () => requestAnimationFrame(() => align(true)))
let timer: number | null = window.setInterval(() => { if (store.isPlaying) align(false) }, 400)
onBeforeUnmount(() => {
	if (timer !== null) window.clearInterval(timer)
	timer = null
	for (const el of videos.values()) el.pause()
})

const pick = (n: number, event: MouseEvent) => {
	if (event.altKey) store.setShotAngleAtPlayhead(n)
	else store.switchAngleAtPlayhead(n)
}
</script>
