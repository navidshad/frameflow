<template>
	<div class="glass-card rounded-2xl flex flex-col overflow-hidden relative">
		<TimelineToolbar />
		<TimelineMinimap />

		<div class="flex-1 min-h-0 grid grid-cols-[112px_1fr]">
			<!-- Left: track headers (outside the scroll container) -->
			<div class="border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/40 overflow-hidden">
				<div class="h-6 border-b border-zinc-200 dark:border-zinc-800"></div> <!-- ruler spacer -->
				<TrackHeader v-for="track in store.sortedTracks" :key="track.id" :track="track" />
			</div>

			<!-- Right: ONE scroll container shared by ruler + lanes -->
			<div ref="scrollRef"
				class="relative overflow-x-auto overflow-y-hidden custom-scrollbar"
				role="application" aria-label="Timeline — Space to play, S to split, Delete to ripple-delete, arrows to step"
				@scroll="viewport.onScroll" @wheel="onWheel">
				<div class="relative" :style="{ width: `${viewport.contentWidth.value}px`, minWidth: '100%' }">
					<TimelineRuler />
					<TrackLane v-for="track in store.sortedTracks" :key="track.id" :track="track" />
					<TimelinePlayhead />
					<!-- Snap guide -->
					<div v-if="interactions.snapGuideSec.value !== null"
						class="absolute top-0 bottom-0 w-px bg-secondary z-20 pointer-events-none shadow-[0_0_6px_rgba(139,92,246,0.6)]"
						:style="{ transform: `translateX(${viewport.secToPx(interactions.snapGuideSec.value)}px)` }"></div>
				</div>
			</div>
		</div>

		<!-- Screen-reader announcements -->
		<div class="sr-only" aria-live="polite">{{ announcement }}</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, provide, ref, watch } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import {
	useTimelineViewport, TimelineViewportKey, TimelineInteractionsKey
} from '../composables/useTimelineViewport'
import { useTimelineInteractions } from '../composables/useTimelineInteractions'
import { useEditorShortcuts } from '../composables/useEditorShortcuts'
import TimelineToolbar from './timeline/TimelineToolbar.vue'
import TimelineMinimap from './timeline/TimelineMinimap.vue'
import TimelineRuler from './timeline/TimelineRuler.vue'
import TrackHeader from './timeline/TrackHeader.vue'
import TrackLane from './timeline/TrackLane.vue'
import TimelinePlayhead from './timeline/TimelinePlayhead.vue'

const store = useEditorStore()

const viewport = useTimelineViewport()
const interactions = useTimelineInteractions(viewport)

provide(TimelineViewportKey, viewport)
provide(TimelineInteractionsKey, interactions)

// Global editor shortcuts (guarded against typing contexts) — the timeline
// panel is always mounted on the editor page and owns the zoom functions.
useEditorShortcuts((factor) => viewport.zoomBy(factor))

const scrollRef = ref<HTMLElement | null>(null)

onMounted(() => viewport.setScrollEl(scrollRef.value))

const onWheel = (e: WheelEvent) => {
	if (e.ctrlKey || e.metaKey) {
		e.preventDefault()
		viewport.zoomAtCursor(e)
	}
}

// Keep the playhead in view while playing
watch(() => store.playheadSec, (t) => {
	if (store.isPlaying) viewport.scrollToTime(t)
})

const announcement = computed(() => {
	const m = Math.floor(store.playheadSec / 60)
	const s = (store.playheadSec % 60).toFixed(1)
	return `Playhead at ${m}:${s.padStart(4, '0')}`
})
</script>
