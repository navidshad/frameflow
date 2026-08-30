<template>
	<div class="relative border-b border-zinc-200/60 dark:border-zinc-800/60 transition-colors"
		:data-track-id="track.id"
		:style="{ height: `${track.height}px` }"
		:class="[laneTint, { 'opacity-40': track.hidden, 'opacity-50 saturate-50': track.muted && !track.hidden, 'bg-zinc-500/5': dragOver }]"
		role="group" :aria-label="`${track.name} ${track.kind} track`"
		@dragover="onDragOver" @dragleave="dragOver = false" @drop="onDrop"
		@pointerdown="onLanePointerDown">

		<!-- Windowed clip rendering -->
		<TimelineClip v-for="item in visibleItems" :key="item.id" :item="item" />

		<!-- Placed transitions, as a RIBBON along the top of the lane.
		     Not a full-height block: the two clips meet at the cut, so their trim
		     handles sit in the middle of the window. A full-height block both
		     painted over them and — because it is a sibling, so crossing onto it
		     fires the clip's pointerleave — unmounted them outright. The lower
		     two thirds of the lane stays clip, where the handles live. -->
		<div v-for="seam in placedSeams" :key="`t-${seam.junction.id}`"
			class="absolute top-1.5 h-3 z-20 rounded border overflow-hidden cursor-pointer transition-shadow"
			:class="store.conflictedSeamIds.has(seam.junction.id)
				? 'border-amber-500 bg-amber-500/25 ring-1 ring-amber-500/40'
				: seam.junction.id === store.selectedSeamId
					? 'border-secondary ring-2 ring-secondary/40 bg-secondary/30'
					: 'border-secondary/70 bg-secondary/20 hover:bg-secondary/30'"
			:style="blockStyle(seam)"
			role="option" :aria-selected="seam.junction.id === store.selectedSeamId" tabindex="0"
			:title="seamTitle(seam)"
			@pointerdown.stop
			@click.stop="onSeamClick(seam, $event)">
			<svg class="w-full h-full text-secondary" viewBox="0 0 40 40" preserveAspectRatio="none" aria-hidden="true">
				<path d="M0,3 L40,37 M0,37 L40,3" stroke="currentColor" stroke-width="1.5" fill="none" />
			</svg>
			<!-- The exact preview is still encoding. Shown HERE because this is
			     where you just dropped it and where you are looking; the monitor
			     only says so while the playhead is inside the window. -->
			<span v-if="previewStatus(seam) === 'rendering'"
				class="absolute inset-0 flex items-center justify-center bg-secondary/25">
				<span class="iconify tabler--loader-2 w-2.5 h-2.5 text-white animate-spin"></span>
			</span>
		</div>

		<!-- A transition that no longer fits. Struck through rather than vanishing,
		     so trimming a clip too short never silently drops the user's edit. -->
		<div v-for="seam in strandedSeams" :key="`s-${seam.junction.id}`"
			class="absolute top-1.5 h-3 z-20 -ml-[9px] w-[18px] rounded
			       border border-red-500/70 bg-red-500/20 flex items-center justify-center cursor-pointer"
			:style="{ transform: `translateX(${viewport.secToPx(seam.junction.cut)}px)` }"
			:title="`${transitionLabel(seam.requested!.kind)} does not fit this cut — the clips are too short. Alt-click to remove.`"
			@pointerdown.stop
			@click.stop="onSeamClick(seam, $event)">
			<span class="iconify tabler--alert-triangle w-2.5 h-2.5 text-red-500"></span>
		</div>

		<!-- Seam targets, shown only while a preset is being dragged. Each says how
		     long a transition it can take BEFORE frames start repeating — the thing
		     that stops the feature failing invisibly on untrimmed footage. -->
		<template v-if="showSeamTargets">
			<div v-for="seam in visibleSeams" :key="`h-${seam.junction.id}`"
				class="absolute top-1 bottom-1 z-30 -ml-[14px] w-[28px] rounded-lg border-2 border-dashed
				       flex items-end justify-center pb-0.5 transition-colors"
				:class="hoverSeamId === seam.junction.id
					? 'border-solid border-accent bg-accent/25'
					: 'border-zinc-400/60 dark:border-zinc-500/60 bg-zinc-500/10'"
				:style="{ transform: `translateX(${viewport.secToPx(seam.junction.cut)}px)` }"
				@dragover.stop="onSeamDragOver(seam, $event)"
				@dragleave.stop="hoverSeamId = null"
				@drop.stop="onSeamDrop(seam, $event)">
				<span class="text-[8px] font-mono font-semibold whitespace-nowrap px-1 rounded"
					:class="seam.limits.freeDuration > 0 ? 'text-zinc-500 dark:text-zinc-400' : 'text-red-500'">
					{{ seam.limits.freeDuration > 0 ? `${seam.limits.freeDuration.toFixed(1)}s` : 'repeats' }}
				</span>
			</div>
		</template>

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
import { DEFAULT_TRANSITION_SEC, type Seam } from '@shared/transitionPlan'
import { transitionLabel } from '@shared/transitionPresets'
import { useEditorStore } from '../../../stores/editorStore'
import { TimelineViewportKey } from '../../composables/useTimelineViewport'
import TimelineClip from './TimelineClip.vue'

const props = defineProps<{ track: Track }>()

const store = useEditorStore()
const viewport = inject(TimelineViewportKey)!

const dragOver = ref(false)
const hoverSeamId = ref<string | null>(null)

const items = computed(() => store.itemsByTrack[props.track.id] || [])

const visibleItems = computed(() =>
	items.value.filter((i) => viewport.intersectsVisible(i.timelineStart, itemEnd(i)))
)

// ===== Seams =====

const laneSeams = computed(() => store.seams.filter((s) => s.junction.trackId === props.track.id))

const visibleSeams = computed(() =>
	laneSeams.value.filter((s) => viewport.intersectsVisible(s.junction.cut, s.junction.cut))
)

/** Seams whose annotation resolved to a real window. */
const placedSeams = computed(() =>
	visibleSeams.value.filter((s) => s.window)
)

/** Annotated, but the geometry cannot reach the floor — must still be visible. */
const strandedSeams = computed(() =>
	visibleSeams.value.filter((s) => s.requested && !s.window)
)

const showSeamTargets = computed(() =>
	!!store.draggingTransitionKind && props.track.kind === 'video' && !props.track.locked && !props.track.hidden
)

const blockStyle = (seam: Seam) => {
	const w = seam.window!
	// Spans the true window. An earlier version inset this by 7px to spare the
	// trim handles, which could never work — the handles are at the CUT, i.e. the
	// middle of the window, never its edges. The ribbon height is what frees them,
	// and the inset only biased short transitions to the right of their cut.
	return {
		transform: `translateX(${viewport.secToPx(w.start)}px)`,
		width: `${Math.max(viewport.secToPx(w.duration), 6)}px`
	}
}

/** Readiness of the pre-rendered preview for this window, if any. */
const previewStatus = (seam: Seam) => store.transitionPreviews.get(seam.junction.id)?.status

const seamTitle = (seam: Seam) => {
	// The export refuses this outright, so the ribbon says it here — while you
	// are editing — rather than after you have waited for a render to fail.
	if (store.conflictedSeamIds.has(seam.junction.id)) {
		return 'A clip on another track crosses this transition. The export will refuse — move it clear, or remove the transition.'
	}
	const base = `${transitionLabel(seam.window!.kind)} — ${seam.window!.duration.toFixed(2)}s`
	const status = previewStatus(seam)
	if (status === 'rendering') return `${base}. Preparing an exact preview…`
	if (status === 'error') return `${base}. Preview could not be rendered; the monitor cross-fades instead.`
	return `${base}. Alt-click to remove.`
}

const onSeamClick = (seam: Seam, e: MouseEvent) => {
	// Alt-click removes, mirroring the ruler's marker idiom.
	if (e.altKey) {
		store.selectSeam(null)
		store.clearTransition(seam.junction.outgoing.id)
		return
	}
	store.selectSeam(seam.junction.id)
}

// ===== Drag & drop =====

const laneTint = computed(() => {
	switch (props.track.kind) {
		case 'video': return 'bg-primary/[0.03] dark:bg-primary/[0.05]'
		case 'audio': return 'bg-accent/[0.03] dark:bg-accent/[0.05]'
		default: return ''
	}
})

const emptyHint = computed(() => {
	switch (props.track.kind) {
		case 'video': return 'Drag a file or pieces here'
		case 'audio': return 'Drag an audio file or pieces here'
		default: return 'Overlay authoring arrives later'
	}
})

// A lane accepts video/audio drops when unlocked/visible AND the dragged item's
// kind (from the readable kind-hint type) matches the lane. Overlay/text lanes
// stay inert in v1.
const dropKind = computed<'video' | 'audio' | null>(() => {
	if (props.track.locked || props.track.hidden) return null
	if (props.track.kind === 'video') return 'video'
	if (props.track.kind === 'audio') return 'audio'
	return null
})

const canAcceptDrag = (dt: DataTransfer | null): boolean => {
	if (!dt || !dropKind.value) return false
	const isPayload = dt.types.includes('application/x-frameflow-clip') || dt.types.includes('application/x-frameflow-asset')
	return isPayload && dt.types.includes(`application/x-frameflow-kind-${dropKind.value}`)
}

const onDragOver = (e: DragEvent) => {
	if (!canAcceptDrag(e.dataTransfer)) {
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
		return
	}
	e.preventDefault()
	e.dataTransfer!.dropEffect = 'copy'
	dragOver.value = true
}

const onDrop = (e: DragEvent) => {
	dragOver.value = false
	if (!canAcceptDrag(e.dataTransfer)) return
	e.preventDefault()
	const el = viewport.scrollEl.value
	if (!el) return
	const rect = el.getBoundingClientRect()
	const atSec = Math.max(0, viewport.pxToSec(el.scrollLeft + (e.clientX - rect.left)))

	const assetId = e.dataTransfer!.getData('application/x-frameflow-asset')
	if (assetId) { store.addItemFromAsset(assetId, props.track.id, atSec); return }
	const clipId = e.dataTransfer!.getData('application/x-frameflow-clip')
	if (clipId) store.addItemFromClip(clipId, props.track.id, atSec)
}

// A seam target handles its own drag entirely — `.stop` keeps the event from
// reaching the lane, which would set dropEffect='none' and cancel the drop this
// zone just accepted.
const onSeamDragOver = (seam: Seam, e: DragEvent) => {
	if (!e.dataTransfer?.types.includes('application/x-frameflow-kind-transition')) return
	e.preventDefault()
	e.dataTransfer.dropEffect = 'copy'
	hoverSeamId.value = seam.junction.id
}

const onSeamDrop = (seam: Seam, e: DragEvent) => {
	hoverSeamId.value = null
	const kind = e.dataTransfer?.getData('application/x-frameflow-transition')
	if (!kind) return
	e.preventDefault()
	store.setTransition(seam.junction.outgoing.id, kind, DEFAULT_TRANSITION_SEC)
	store.selectSeam(seam.junction.id)
	store.draggingTransitionKind = null
}

// Clicking empty lane space clears selection
const onLanePointerDown = (e: PointerEvent) => {
	if ((e.target as HTMLElement).dataset.trackId === props.track.id) {
		store.clearItemSelection()
		store.selectSeam(null)
	}
}
</script>
