<template>
	<!-- Always-visible overview strip (§5.3): the whole sequence at a glance,
	     with a draggable viewport rectangle. Navigation only — it scrolls the
	     main timeline and never moves the playhead. -->
	<div ref="rootRef"
		class="relative h-5 shrink-0 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-100/60 dark:bg-zinc-900/60 cursor-pointer select-none touch-none"
		title="Timeline overview — click or drag to navigate"
		@pointerdown="onPointerDown">
		<!-- Item blocks, one thin row per track -->
		<div v-for="(track, row) in store.sortedTracks" :key="track.id">
			<div v-for="item in itemsByTrack[track.id] || []" :key="item.id"
				class="absolute rounded-[1px]"
				:class="trackTint(track.kind)"
				:style="{
					left: `${frac(item.timelineStart) * 100}%`,
					width: `${Math.max(frac(item.duration) * 100, 0.15)}%`,
					top: `${3 + row * 4}px`,
					height: '3px'
				}"></div>
		</div>

		<!-- Markers -->
		<div v-for="m in store.markers" :key="m.id"
			class="absolute top-0 bottom-0 w-px bg-amber-400/90"
			:style="{ left: `${frac(m.time) * 100}%` }"></div>

		<!-- Playhead -->
		<div class="absolute top-0 bottom-0 w-px bg-primary"
			:style="{ left: `${frac(store.playheadSec) * 100}%` }"></div>

		<!-- Visible-window rectangle -->
		<div class="absolute top-0 bottom-0 border border-primary/60 bg-primary/10 rounded-[2px] pointer-events-none"
			:style="{ left: `${windowLeftFrac * 100}%`, width: `${windowWidthFrac * 100}%` }"></div>
	</div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useEditorStore } from '../../../stores/editorStore'
import { TimelineViewportKey } from '../../composables/useTimelineViewport'

const store = useEditorStore()
const viewport = inject(TimelineViewportKey)!

const rootRef = ref<HTMLElement | null>(null)

// The minimap maps the SAME domain as the scroll content ([0, contentEnd+tail])
// so the window rectangle tracks scrollLeft/clientWidth exactly.
const totalSec = computed(() => Math.max(store.contentEnd + store.timelineTail, 1))
const frac = (sec: number) => Math.min(Math.max(sec / totalSec.value, 0), 1)

const itemsByTrack = computed(() => store.itemsByTrack)

const windowLeftFrac = computed(() =>
	viewport.contentWidth.value > 0 ? viewport.scrollLeft.value / viewport.contentWidth.value : 0
)
const windowWidthFrac = computed(() =>
	viewport.contentWidth.value > 0
		? Math.min(viewport.clientWidth.value / viewport.contentWidth.value, 1)
		: 1
)

const trackTint = (kind: string) =>
	kind === 'audio' ? 'bg-accent/70' : kind === 'video' ? 'bg-primary/70' : 'bg-secondary/60'

/** Scroll the main timeline so the clicked/dragged fraction is centered. */
const navigateTo = (clientX: number) => {
	const root = rootRef.value
	const el = viewport.scrollEl.value
	if (!root || !el) return
	const rect = root.getBoundingClientRect()
	const f = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
	el.scrollLeft = f * viewport.contentWidth.value - el.clientWidth / 2
	viewport.onScroll()
}

const onPointerDown = (e: PointerEvent) => {
	navigateTo(e.clientX)
	const el = rootRef.value
	if (!el) return
	el.setPointerCapture(e.pointerId)
	const onMove = (ev: PointerEvent) => navigateTo(ev.clientX)
	const onUp = () => {
		el.removeEventListener('pointermove', onMove)
		el.removeEventListener('pointerup', onUp)
	}
	el.addEventListener('pointermove', onMove)
	el.addEventListener('pointerup', onUp)
}
</script>
