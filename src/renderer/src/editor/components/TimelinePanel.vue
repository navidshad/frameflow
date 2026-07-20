<template>
	<div class="glass-card rounded-2xl flex flex-col overflow-hidden relative">
		<TimelineToolbar />
		<TimelineMinimap />

		<div class="flex-1 min-h-0 grid grid-cols-[112px_1fr]">
			<!-- Left: track headers. The ruler spacer stays pinned; the header
			     stack is translated to follow the lanes' vertical scroll. -->
			<div class="border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/40 overflow-hidden flex flex-col">
				<div class="h-6 border-b border-zinc-200 dark:border-zinc-800 shrink-0"></div> <!-- ruler spacer -->
				<div :style="{ transform: `translateY(${-vScroll}px)` }">
					<TrackHeader v-for="track in store.sortedTracks" :key="track.id" :track="track" />
				</div>
			</div>

			<!-- Right: ONE scroll container shared by ruler + lanes (x AND y) -->
			<div ref="scrollRef"
				class="relative overflow-x-auto overflow-y-auto custom-scrollbar"
				role="application" aria-label="Timeline — Space to play, S to split, Delete to ripple-delete, arrows to step"
				@scroll="onScroll" @wheel="onWheel">
				<div class="relative" :style="{ width: `${viewport.contentWidth.value}px`, minWidth: '100%' }">
					<!-- Ruler pinned to the top while the lanes scroll vertically -->
					<div class="sticky top-0 z-30 bg-zinc-50/95 dark:bg-zinc-950/95 backdrop-blur-sm">
						<TimelineRuler />
					</div>
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
const vScroll = ref(0) // vertical scroll of the lanes, mirrored onto the headers

onMounted(() => viewport.setScrollEl(scrollRef.value))

// The lanes container owns both axes; forward horizontal scroll to the viewport
// and mirror vertical scroll onto the (transform-driven) header column.
const onScroll = (e: Event) => {
	viewport.onScroll()
	vScroll.value = (e.target as HTMLElement).scrollTop
}

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
