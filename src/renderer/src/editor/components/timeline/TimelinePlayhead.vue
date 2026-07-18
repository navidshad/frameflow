<template>
	<div class="absolute top-0 bottom-0 z-30 pointer-events-none"
		:style="{ transform: `translateX(${viewport.secToPx(store.playheadSec)}px)` }"
		role="slider" aria-label="Playhead"
		:aria-valuetext="ariaTime" :aria-valuenow="Math.round(store.playheadSec)"
		:aria-valuemin="0" :aria-valuemax="Math.round(store.contentEnd)">
		<!-- Grab handle (on the ruler) -->
		<div class="absolute -top-0 -ml-[5px] w-[11px] h-3.5 bg-primary rounded-b-sm cursor-ew-resize pointer-events-auto shadow"
			@pointerdown.stop="interactions.beginScrub($event)"></div>
		<!-- Line -->
		<div class="absolute top-0 bottom-0 w-px bg-primary shadow-[0_0_6px_rgba(59,130,246,0.6)]"></div>
	</div>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { useEditorStore } from '../../../stores/editorStore'
import { TimelineViewportKey, TimelineInteractionsKey } from '../../composables/useTimelineViewport'

const store = useEditorStore()
const viewport = inject(TimelineViewportKey)!
const interactions = inject(TimelineInteractionsKey)!

const ariaTime = computed(() => {
	const m = Math.floor(store.playheadSec / 60)
	const s = (store.playheadSec % 60).toFixed(1)
	return `${m} minutes ${s} seconds`
})
</script>
