<template>
	<div class="relative h-6 border-b border-zinc-200 dark:border-zinc-800 cursor-pointer select-none bg-zinc-50/80 dark:bg-zinc-950/60"
		@pointerdown="interactions.beginScrub($event)">
		<!-- Ticks -->
		<div v-for="tick in ticks" :key="tick.time"
			class="absolute top-0 bottom-0 pointer-events-none"
			:style="{ transform: `translateX(${viewport.secToPx(tick.time)}px)` }">
			<div class="w-px bg-zinc-300 dark:bg-zinc-700" :class="tick.major ? 'h-full' : 'h-1.5 mt-auto absolute bottom-0'"></div>
			<span v-if="tick.major" class="absolute top-0.5 left-1 text-[8px] font-mono text-zinc-400 whitespace-nowrap">
				{{ tick.label }}
			</span>
		</div>

		<!-- Markers -->
		<button v-for="marker in store.markers" :key="marker.id"
			class="absolute -bottom-px w-2.5 h-2.5 -ml-[5px] rotate-45 bg-secondary border border-white/50 dark:border-zinc-900/50 hover:scale-125 transition-transform z-10"
			:style="{ left: `${viewport.secToPx(marker.time)}px` }"
			:title="`${marker.label || 'Marker'} — click to seek, Alt-click to remove`"
			@pointerdown.stop
			@click.stop="onMarkerClick(marker.id, marker.time, $event)"></button>
	</div>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { useEditorStore } from '../../../stores/editorStore'
import { TimelineViewportKey, TimelineInteractionsKey } from '../../composables/useTimelineViewport'

const store = useEditorStore()
const viewport = inject(TimelineViewportKey)!
const interactions = inject(TimelineInteractionsKey)!

const TICK_STEPS = [0.5, 1, 2, 5, 10, 30, 60, 300]

const ticks = computed(() => {
	// Choose the smallest step giving >= 60px between major ticks
	const step = TICK_STEPS.find((s) => viewport.secToPx(s) >= 60) || 300
	const minor = step / 5
	const [visStart, visEnd] = viewport.visibleRange.value
	const start = Math.max(0, Math.floor(visStart / minor) * minor)
	const end = Math.min(store.contentEnd + store.timelineTail, visEnd)

	const out: { time: number; major: boolean; label: string }[] = []
	for (let t = start; t <= end + 1e-9; t += minor) {
		const time = Math.round(t * 1000) / 1000
		const major = Math.abs(time / step - Math.round(time / step)) < 1e-6
		out.push({ time, major, label: major ? format(time, step) : '' })
	}
	return out
})

// Label precision follows the tick step so sub-second majors stay distinct
// (step 0.5 -> "0s, 0.5s, 1s" — not "0s, 0s, 1s").
const format = (seconds: number, step: number) => {
	if (seconds >= 60 || step >= 60) {
		const m = Math.floor(seconds / 60)
		const s = Math.floor(seconds % 60)
		return `${m}:${String(s).padStart(2, '0')}`
	}
	return step < 1 ? `${(Math.round(seconds * 10) / 10)}s` : `${Math.round(seconds)}s`
}

const onMarkerClick = (id: string, time: number, e: MouseEvent) => {
	if (e.altKey) store.removeMarker(id)
	else store.seekTo(time)
}
</script>
