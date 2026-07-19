<template>
	<div class="relative border-b border-zinc-200/60 dark:border-zinc-800/60 transition-colors"
		:data-track-id="track.id"
		:style="{ height: `${track.height}px` }"
		:class="[laneTint, { 'opacity-40': track.hidden, 'bg-zinc-500/5': dragOver }]"
		role="group" :aria-label="`${track.name} ${track.kind} track`"
		@dragover="onDragOver" @dragleave="dragOver = false" @drop="onDrop"
		@pointerdown="onLanePointerDown">

		<!-- Windowed clip rendering -->
		<TimelineClip v-for="item in visibleItems" :key="item.id" :item="item" />

		<!-- Hints -->
		<div v-if="items.length === 0" class="absolute inset-0 flex items-center px-3 pointer-events-none">
			<span class="text-[10px] text-zinc-400 dark:text-zinc-600">{{ emptyHint }}</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { Track } from '@shared/types'
import { itemEnd } from '@shared/timeline'
import { useEditorStore } from '../../../stores/editorStore'
import { TimelineViewportKey } from '../../composables/useTimelineViewport'
import TimelineClip from './TimelineClip.vue'

const props = defineProps<{ track: Track }>()

const store = useEditorStore()
const viewport = inject(TimelineViewportKey)!

const dragOver = ref(false)

const items = computed(() => store.itemsByTrack[props.track.id] || [])

const visibleItems = computed(() =>
	items.value.filter((i) => viewport.intersectsVisible(i.timelineStart, itemEnd(i)))
)

const laneTint = computed(() => {
	switch (props.track.kind) {
		case 'video': return 'bg-primary/[0.03] dark:bg-primary/[0.05]'
		case 'audio': return 'bg-accent/[0.03] dark:bg-accent/[0.05]'
		default: return ''
	}
})

const emptyHint = computed(() => {
	switch (props.track.kind) {
		case 'video': return 'Drag pieces here'
		case 'audio': return 'Audio — preview arrives with export'
		default: return 'Overlay authoring arrives later'
	}
})

const acceptsDrop = computed(() =>
	props.track.kind === 'video' && !props.track.locked && !props.track.hidden
)

const onDragOver = (e: DragEvent) => {
	if (!e.dataTransfer?.types.includes('application/x-frameflow-clip') || !acceptsDrop.value) {
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
		return
	}
	e.preventDefault()
	e.dataTransfer.dropEffect = 'copy'
	dragOver.value = true
}

const onDrop = (e: DragEvent) => {
	dragOver.value = false
	if (!acceptsDrop.value) return
	const clipId = e.dataTransfer?.getData('application/x-frameflow-clip')
	if (!clipId) return
	e.preventDefault()
	const el = viewport.scrollEl.value
	if (!el) return
	const rect = el.getBoundingClientRect()
	const atSec = Math.max(0, viewport.pxToSec(el.scrollLeft + (e.clientX - rect.left)))
	store.addItemFromClip(clipId, props.track.id, atSec)
}

// Clicking empty lane space clears selection
const onLanePointerDown = (e: PointerEvent) => {
	if ((e.target as HTMLElement).dataset.trackId === props.track.id) {
		store.clearItemSelection()
	}
}
</script>
