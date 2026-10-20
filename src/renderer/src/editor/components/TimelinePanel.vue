<template>
	<div class="hair-t flex flex-col overflow-hidden relative">
		<TimelineToolbar />
		<TimelineMinimap />

		<div class="flex-1 min-h-0 grid grid-cols-[128px_1fr]">
			<!-- Left: track headers. The ruler spacer stays pinned; the header
			     stack is translated to follow the lanes' vertical scroll. -->
			<div class="hair-r overflow-hidden flex flex-col">
				<div class="h-6 hair-b shrink-0"></div> <!-- ruler spacer -->
				<div :style="{ transform: `translateY(${-vScroll}px)` }">
					<template v-for="track in store.sortedTracks" :key="track.id">
						<TrackHeader :track="track" />
						<!-- The selected clip's keyframe lanes open under its own track. -->
						<KeyframeLaneHeaders v-if="lanesTrackId === track.id" />
					</template>
				</div>
			</div>

			<!-- Right: ONE scroll container shared by ruler + lanes (x AND y) -->
			<div ref="scrollRef"
				class="relative overflow-x-auto overflow-y-auto custom-scrollbar"
				role="application" aria-label="Timeline — Space to play, S to split, Delete to ripple-delete, arrows to step"
				@scroll="onScroll" @wheel="onWheel">
				<div class="relative" :style="{ width: `${viewport.contentWidth.value}px`, minWidth: '100%' }">
					<!-- Ruler pinned to the top while the lanes scroll vertically -->
					<div class="sticky top-0 z-30 bg-ground">
						<TimelineRuler />
					</div>
					<!-- Drag past the top of the stack and a video lane is offered.
					     Overlaid rather than inserted: adding a row here mid-drag
					     would shift every lane out from under the pointer. -->
					<div v-if="newTrackZone?.edge === 'above'"
						class="absolute inset-x-0 top-6 h-8 z-40 pointer-events-none flex items-center justify-center
						       rounded border-2 border-dashed border-accent bg-accent/15">
						<span class="text-[10px] font-semibold text-accent">Drop to add a video track</span>
					</div>

					<template v-for="track in store.sortedTracks" :key="track.id">
						<TrackLane :track="track" />
						<KeyframeLanes v-if="lanesTrackId === track.id && kf.item" :item="kf.item" />
					</template>

					<!-- The audio half, appended after the lanes so it takes its own
					     space without moving any of them. -->
					<div v-if="newTrackZone?.edge === 'below'"
						class="h-8 mx-px pointer-events-none flex items-center justify-center
						       rounded border-2 border-dashed border-accent bg-accent/15">
						<span class="text-[10px] font-semibold text-accent">Drop to add an audio track</span>
					</div>

					<TimelinePlayhead />
					<!-- Snap guide -->
					<!-- A dragged key's snap, in the same guide the clips use. -->
					<div v-if="kf.snapGuide !== null"
						class="absolute top-0 bottom-0 w-px bg-secondary z-20 pointer-events-none shadow-[0_0_6px_rgba(139,92,246,0.6)]"
						:style="{ transform: `translateX(${viewport.secToPx(kf.snapGuide)}px)` }"></div>
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
import KeyframeLanes from './timeline/KeyframeLanes.vue'
import KeyframeLaneHeaders from './timeline/KeyframeLaneHeaders.vue'
import { useKeyframeLanesStore } from '../../stores/keyframeLanesStore'

const store = useEditorStore()
const kf = useKeyframeLanesStore()

/** The track whose clip's lanes are open, if any. */
const lanesTrackId = computed(() => (kf.expanded ? kf.item?.trackId : null) ?? null)

const viewport = useTimelineViewport()
const interactions = useTimelineInteractions(viewport)

/** Shown only mid-drag: where letting go would put a brand-new lane. */
const newTrackZone = computed(() => interactions.newTrackZone.value)

provide(TimelineViewportKey, viewport)
provide(TimelineInteractionsKey, interactions)

// Global editor shortcuts (guarded against typing contexts) — the timeline
// panel is always mounted on the editor page and owns the zoom functions.
// Help and fullscreen belong to surfaces this panel does not own, so they go
// through the store rather than being plumbed up and back down.
useEditorShortcuts({
	zoomBy: (factor) => viewport.zoomBy(factor),
	onHelp: () => { store.shortcutsOpen = !store.shortcutsOpen },
	onFullscreen: () => { store.monitorFullscreen = !store.monitorFullscreen }
})

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
