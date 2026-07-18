<template>
	<div class="absolute top-1 bottom-1 rounded-lg overflow-hidden select-none group border transition-shadow"
		:class="[
			selected
				? 'border-primary ring-2 ring-primary/40 shadow-md shadow-primary/20 z-10'
				: 'border-zinc-300/60 dark:border-zinc-700/80 hover:border-primary/40',
			track?.locked ? 'pointer-events-none opacity-60' : 'cursor-grab active:cursor-grabbing'
		]"
		:style="{ transform: `translateX(${viewport.secToPx(item.timelineStart)}px)`, width: `${Math.max(viewport.secToPx(item.duration), 6)}px` }"
		role="option" :aria-selected="selected" tabindex="0"
		:aria-label="`${item.label || 'Clip'}, ${format(item.timelineStart)} to ${format(end)}, ${item.duration.toFixed(1)} seconds`"
		@pointerdown.stop="onPointerDown"
		@click.stop="onClick">

		<!-- Body: filmstrip (scene thumbnail) or context (visual text) -->
		<div class="absolute inset-0 bg-zinc-200 dark:bg-zinc-800">
			<template v-if="store.timelineView === 'filmstrip'">
				<img v-if="thumbSrc" :src="thumbSrc" class="w-full h-full object-cover" loading="lazy" draggable="false" />
				<div v-else class="w-full h-full flex items-center justify-center">
					<span class="iconify tabler--movie w-4 h-4 text-zinc-400"></span>
				</div>
				<div class="absolute bottom-0 inset-x-0 px-1.5 py-0.5 bg-gradient-to-t from-black/60 to-transparent">
					<p class="text-[9px] text-white/90 truncate font-medium">{{ item.label }}</p>
				</div>
			</template>
			<template v-else>
				<div class="w-full h-full px-2 py-1 bg-white/70 dark:bg-zinc-900/70 flex flex-col justify-center gap-0.5 overflow-hidden">
					<span class="text-[8px] font-mono text-zinc-400 leading-none">
						{{ format(item.in) }}–{{ format(item.out) }}
					</span>
					<p class="text-[10px] leading-tight text-zinc-700 dark:text-zinc-300 line-clamp-2"
						:class="{ 'italic text-zinc-400 dark:text-zinc-500': !contextText }">
						{{ contextText || 'No description — run enrichment' }}
					</p>
				</div>
			</template>

			<!-- Retime hatch + badge -->
			<div v-if="item.speed !== 1" class="absolute inset-0 pointer-events-none retime-hatch"></div>
			<span v-if="item.speed !== 1"
				class="absolute top-0.5 right-0.5 px-1 py-px rounded bg-secondary text-white text-[8px] font-bold font-mono pointer-events-none">
				{{ item.speed.toFixed(2).replace(/\.?0+$/, '') }}×
			</span>
			<!-- Item muted badge -->
			<span v-if="item.muted"
				class="absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded bg-black/50 flex items-center justify-center pointer-events-none">
				<span class="iconify tabler--volume-off w-2.5 h-2.5 text-white"></span>
			</span>
		</div>

		<!-- Trim handles -->
		<div v-if="selected || hovering" class="absolute inset-y-0 left-0 w-1.5 bg-primary/80 cursor-ew-resize z-20"
			@pointerdown.stop="interactions.beginTrim(item.id, 'left', $event)"></div>
		<div v-if="selected || hovering" class="absolute inset-y-0 right-0 w-1.5 bg-primary/80 cursor-ew-resize z-20"
			@pointerdown.stop="interactions.beginTrim(item.id, 'right', $event)"></div>
	</div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { TimelineItem } from '@shared/types'
import { itemEnd } from '@shared/timeline'
import { useEditorStore } from '../../../stores/editorStore'
import { TimelineViewportKey, TimelineInteractionsKey } from '../../composables/useTimelineViewport'

const props = defineProps<{ item: TimelineItem }>()

const store = useEditorStore()
const viewport = inject(TimelineViewportKey)!
const interactions = inject(TimelineInteractionsKey)!

const hovering = ref(false)

const selected = computed(() => store.selectedItemIds.includes(props.item.id))
const end = computed(() => itemEnd(props.item))
const track = computed(() => store.doc?.tracks.find((t) => t.id === props.item.trackId))

const sourceClip = computed(() => {
	const asset = store.doc?.media.find((a) => a.id === props.item.sourceAssetId)
	return asset?.clips.find((c) => c.id === props.item.sourceClipId) || null
})

const thumbSrc = computed(() =>
	sourceClip.value?.thumbnailPath ? `media://${sourceClip.value.thumbnailPath}` : null
)

const contextText = computed(() => sourceClip.value?.visual || props.item.label || '')

const format = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = (seconds % 60).toFixed(1)
	return `${m}:${s.padStart(4, '0')}`
}

const onPointerDown = (e: PointerEvent) => {
	hovering.value = true
	if (!selected.value) {
		if (e.shiftKey || e.metaKey || e.ctrlKey) store.toggleItemSelected(props.item.id)
		else store.selectItems([props.item.id])
	}
	interactions.beginMove(props.item.id, e)
}

const onClick = (e: MouseEvent) => {
	if (e.shiftKey || e.metaKey || e.ctrlKey) return // handled at pointerdown
	store.selectItems([props.item.id])
}
</script>

<style scoped>
.retime-hatch {
	background-image: repeating-linear-gradient(
		-45deg,
		transparent,
		transparent 6px,
		rgba(139, 92, 246, 0.15) 6px,
		rgba(139, 92, 246, 0.15) 8px
	);
}

</style>
