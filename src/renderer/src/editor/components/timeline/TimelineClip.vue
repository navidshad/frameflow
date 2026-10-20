<template>
	<div class="absolute top-1 bottom-1 rounded-lg overflow-hidden select-none group border transition-shadow"
		:class="[
			selected
				? 'border-primary ring-2 ring-primary/40 shadow-md shadow-primary/20 z-10'
				: item.motion
					? 'border-pink-500/45 hover:border-pink-500/70'
					: 'border-zinc-300/60 dark:border-zinc-700/80 hover:border-primary/40',
			track?.locked ? 'pointer-events-none opacity-60' : 'cursor-grab active:cursor-grabbing',
			effectHover ? 'ring-2 ring-accent border-accent' : '',
			dragging ? 'opacity-80 shadow-lg shadow-black/30 z-30' : ''
		]"
		:style="{ transform: `translateX(${viewport.secToPx(item.timelineStart)}px)`, width: `${Math.max(viewport.secToPx(item.duration), 6)}px` }"
		role="option" :aria-selected="selected" tabindex="0"
		:aria-label="`${item.label || 'Clip'}, ${format(item.timelineStart)} to ${format(end)}, ${item.duration.toFixed(1)} seconds`"
		@pointerenter="hovering = true"
		@pointerleave="hovering = false"
		@pointerdown.stop="onPointerDown"
		@click.stop="onClick"
		@dragover.stop="onEffectDragOver"
		@dragleave.stop="effectHover = false"
		@drop.stop="onEffectDrop">

		<!-- A motion layer: pink, its in/out windows drawn where they fall, and
		     every keyframe it carries as a diamond along the bottom. -->
		<div v-if="item.motion" class="absolute inset-0"
			:class="selected ? 'bg-pink-500/[0.16]' : 'bg-pink-500/[0.12]'"
			:data-motion-clip="item.id">
			<template v-if="selected">
				<template v-for="zone in motionZones" :key="zone.name">
					<div class="absolute inset-y-0 bg-pink-500/[0.28] pointer-events-none"
						:style="{ left: `${zone.left}px`, width: `${zone.width}px` }"></div>
					<div class="absolute inset-y-0 w-px bg-pink-900/30 dark:bg-white/45 pointer-events-none"
						:style="{ left: `${zone.edge}px` }"></div>
					<span v-if="motionWidth > 60"
						class="absolute top-0.5 font-mono text-[7px] text-pink-900/60 dark:text-white/60 pointer-events-none"
						:style="zone.side === 'left' ? { left: `${zone.edge + 2}px` } : { left: `${zone.edge - 2}px`, transform: 'translateX(-100%)' }">
						{{ zone.name }}
					</span>
				</template>
			</template>
			<div class="absolute top-4 flex items-center gap-1 text-[9px] font-semibold whitespace-nowrap overflow-hidden pointer-events-none"
				:class="selected
					? 'left-3 right-3 text-pink-900 dark:text-white/90'
					: 'left-1.5 right-1 text-pink-900/80 dark:text-white/85'">
				<span v-if="selected" class="iconify tabler--sparkles w-2.5 h-2.5 text-pink-400 shrink-0"></span>
				<span class="truncate">{{ motionLabel }}</span>
			</div>
			<div v-for="key in motionKeys" :key="key"
				class="absolute bottom-1.5 w-[7px] h-[7px] bg-blue-400 rotate-45 pointer-events-none"
				:style="{ left: `${key - 3.5}px` }"></div>
		</div>

		<!-- Body: filmstrip (scene thumbnail) or context (visual text) -->
		<div v-else class="absolute inset-0 bg-zinc-200 dark:bg-zinc-800">
			<template v-if="store.timelineView === 'filmstrip'">
				<!-- Dense strip (§5.5): frames from the batched per-asset filmstrip,
				     one per ~64px slot; falls back to the scene thumbnail. -->
				<div v-if="stripFrames.length" class="w-full h-full flex">
					<img v-for="(src, i) in stripFrames" :key="i" :src="src"
						class="flex-1 min-w-0 h-full object-cover" loading="lazy" draggable="false" />
				</div>
				<img v-else-if="thumbSrc" :src="thumbSrc" class="w-full h-full object-cover" loading="lazy" draggable="false" />
				<div v-else class="w-full h-full flex items-center justify-center"
					:class="isAudio ? 'bg-accent/10' : ''">
					<span class="iconify w-4 h-4" :class="[isAudio ? 'tabler--music text-accent' : 'tabler--movie text-zinc-400']"></span>
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
import { toMediaUrl } from '@shared/media-url'
import { computed, inject, ref } from 'vue'
import type { TimelineItem } from '@shared/types'
import { itemEnd } from '@shared/timeline'
import { motionClipLabel, resolveMoments } from '@shared/motion'
import { useEditorStore } from '../../../stores/editorStore'
import { TimelineViewportKey, TimelineInteractionsKey } from '../../composables/useTimelineViewport'

const props = defineProps<{ item: TimelineItem }>()

/**
 * An effect's drop target is the clip BODY, where a transition's is the cut.
 * `.stop` on all three keeps the event off the lane, whose own handler would
 * set dropEffect='none' and cancel the drop this element just accepted — the
 * lesson the seam targets already learned.
 */
const effectHover = ref(false)

const onEffectDragOver = (e: DragEvent) => {
	if (!e.dataTransfer?.types.includes('application/x-frameflow-kind-effect')) return
	e.preventDefault()
	e.dataTransfer.dropEffect = 'copy'
	effectHover.value = true
}

const onEffectDrop = (e: DragEvent) => {
	effectHover.value = false
	const kind = e.dataTransfer?.getData('application/x-frameflow-effect')
	if (!kind) return
	e.preventDefault()
	store.addEffect(props.item.id, kind)
	store.selectItems([props.item.id])
	store.draggingEffectKind = null
}

const store = useEditorStore()
const viewport = inject(TimelineViewportKey)!
const interactions = inject(TimelineInteractionsKey)!

/** Lifted while it is the one being dragged, so it reads as picked up. */
const dragging = computed(() =>
	interactions.mode.value === 'movingItem' && interactions.activeItemId.value === props.item.id
)

const hovering = ref(false)

const selected = computed(() => store.selectedItemIds.includes(props.item.id))
const end = computed(() => itemEnd(props.item))
const track = computed(() => store.doc?.tracks.find((t) => t.id === props.item.trackId))
const isAudio = computed(() =>
	store.doc?.media.find((a) => a.id === props.item.sourceAssetId)?.kind === 'audio')

const sourceClip = computed(() => {
	const asset = store.doc?.media.find((a) => a.id === props.item.sourceAssetId)
	return asset?.clips.find((c) => c.id === props.item.sourceClipId) || null
})

const thumbSrc = computed(() =>
	sourceClip.value?.thumbnailPath ? toMediaUrl(sourceClip.value.thumbnailPath) : null
)

// Dense filmstrip (§5.5): pick the nearest batched-strip frame for each
// ~64px slot across the clip's SOURCE range. Density adapts to zoom via the
// on-screen width; entries are asset-cached, so this is pure lookup.
const TARGET_FRAME_PX = 64
const stripFrames = computed<string[]>(() => {
	const entries = store.doc?.media.find((a) => a.id === props.item.sourceAssetId)?.filmstrip
	if (!entries?.length) return []
	const widthPx = viewport.secToPx(props.item.duration)
	const count = Math.min(Math.max(Math.floor(widthPx / TARGET_FRAME_PX), 1), 60)
	const span = props.item.out - props.item.in
	const frames: string[] = []
	for (let i = 0; i < count; i++) {
		const t = props.item.in + ((i + 0.5) / count) * span
		// entries are sorted by time — nearest lookup
		let best = entries[0]
		for (const e of entries) {
			if (Math.abs(e.time - t) < Math.abs(best.time - t)) best = e
			if (e.time > t) break
		}
		frames.push(toMediaUrl(best.thumbnailPath))
	}
	return frames
})

const contextText = computed(() => sourceClip.value?.visual || props.item.label || '')

// ===== Motion =====

const motionWidth = computed(() => Math.max(viewport.secToPx(props.item.duration), 6))
const motionLabel = computed(() => motionClipLabel(props.item))

/**
 * The first and last windows (the entrance and the exit), in px from the
 * clip's left edge. Only the ends are drawn: the middle is the hold, which is
 * the clip's body.
 */
const motionZones = computed(() => {
	if (!props.item.motion) return []
	const moments = resolveMoments(props.item.motion, props.item.duration)
	if (moments.length < 2) return []
	const first = moments[0]
	const last = moments[moments.length - 1]
	const px = (s: number) => viewport.secToPx(s)
	return [
		{ name: first.name, side: 'left', left: 0, width: px(first.duration), edge: px(first.duration) },
		{ name: last.name, side: 'right', left: px(last.start), width: px(last.duration), edge: px(last.start) }
	].filter((z) => z.width > 0.5)
})

/** Every keyframe time on the clip, any path, in px from its left edge. */
const motionKeys = computed(() => {
	const tracks = props.item.keyframes ?? {}
	const times = new Set<number>()
	for (const keys of Object.values(tracks)) {
		for (const k of keys ?? []) if (k.t >= 0 && k.t <= props.item.duration) times.add(Math.round(k.t * 100) / 100)
	}
	return [...times].sort((a, b) => a - b).map((t) => viewport.secToPx(t))
})

const format = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = (seconds % 60).toFixed(1)
	return `${m}:${s.padStart(4, '0')}`
}

const onPointerDown = (e: PointerEvent) => {
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
