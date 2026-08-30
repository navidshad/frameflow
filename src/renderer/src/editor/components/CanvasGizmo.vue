<template>
	<!-- The selected item, editable ON the picture.
	     A clip's gizmo is the frame box carrying the clip's own transform, so
	     the outline sits exactly where the picture is; a title's is an anchor at
	     the title's position. Everything writes FRACTIONS of the frame — the
	     unit every placement in this app already speaks — through gesture
	     actions, so one drag is one history step. -->
	<div v-if="mode === 'clip'"
		class="absolute inset-0 z-30"
		:style="{ transform: clipCss || undefined }">
		<!-- The face: grab anywhere on the picture to move it. -->
		<div class="absolute inset-0 cursor-move border-2 border-primary/70"
			@pointerdown.stop.prevent="begin('move', $event)"></div>
		<!-- Corners: uniform scale about the centre. -->
		<div v-for="corner in CORNERS" :key="corner.key"
			class="absolute w-2.5 h-2.5 rounded-sm bg-primary border border-white/80 cursor-nwse-resize"
			:style="corner.style"
			@pointerdown.stop.prevent="begin('scale', $event)"></div>
		<!-- The rotation stalk, above the top edge. -->
		<div class="absolute left-1/2 -top-6 -translate-x-1/2 flex flex-col items-center"
			@pointerdown.stop.prevent="begin('rotate', $event)">
			<div class="w-2.5 h-2.5 rounded-full bg-primary border border-white/80 cursor-grab"></div>
			<div class="w-px h-3.5 bg-primary/70"></div>
		</div>
	</div>

	<template v-else-if="mode === 'title'">
		<!-- The title anchor: ring the text's centre, drag to place it. -->
		<div class="absolute z-30 -translate-x-1/2 -translate-y-1/2 cursor-move"
			:style="{ left: `${titleX * 100}%`, top: `${titleY * 100}%` }"
			@pointerdown.stop.prevent="begin('move', $event)">
			<div class="w-4 h-4 rounded-full border-2 border-primary bg-primary/20"></div>
		</div>
		<!-- The size handle, offset from the anchor so the two never overlap. -->
		<div class="absolute z-30 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize"
			:style="{ left: `calc(${titleX * 100}% + 26px)`, top: `calc(${titleY * 100}% + 26px)` }"
			title="Drag to resize the text"
			@pointerdown.stop.prevent="begin('scale', $event)">
			<div class="w-2.5 h-2.5 rounded-sm bg-primary border border-white/80"></div>
		</div>
	</template>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import { transformCss, OFFSET_RANGE, SCALE_RANGE, TRANSFORM_DEFAULTS } from '@shared/transform'
import { valueAt } from '@shared/keyframes'

/**
 * On-canvas editing for the selected item: move, scale and rotate a clip, or
 * move and resize a title, by dragging the thing itself instead of finding its
 * sliders in the inspector. The sliders remain — this writes through the same
 * store state they read, so the two views cannot disagree.
 */

const props = defineProps<{
	/** The frame box's current size on screen, so pixel deltas become fractions. */
	frameWidth: number
	frameHeight: number
}>()

const store = useEditorStore()

const selected = computed(() => {
	if (store.selectedItemIds.length !== 1) return null
	return store.doc?.timeline.find((i) => i.id === store.selectedItemIds[0]) ?? null
})

const mode = computed<'clip' | 'title' | null>(() => {
	const item = selected.value
	if (!item) return null
	if (item.text) return 'title'
	// Only things with a picture on the frame: video-track clips and generators.
	const track = store.doc?.tracks.find((t) => t.id === item.trackId)
	return track?.kind === 'video' ? 'clip' : null
})

// ---- What the gizmo shows ----

/** A clip whose position is keyframed follows the curve; the gizmo must too. */
const clipTime = computed(() =>
	Math.max(0, store.playheadSec - (selected.value?.timelineStart ?? 0))
)

const liveTransform = computed(() => {
	const item = selected.value
	if (!item) return { ...TRANSFORM_DEFAULTS }
	const still = { ...TRANSFORM_DEFAULTS, ...item.transform }
	const keys = item.keyframes
	return {
		x: valueAt(keys?.['transform.x'], clipTime.value, still.x),
		y: valueAt(keys?.['transform.y'], clipTime.value, still.y),
		scale: still.scale,
		rotation: valueAt(keys?.['transform.rotation'], clipTime.value, still.rotation)
	}
})

const clipCss = computed(() =>
	mode.value === 'clip' ? transformCss(selected.value?.transform, {
		tracks: selected.value?.keyframes,
		t: clipTime.value
	}) : ''
)

const titleX = computed(() => selected.value?.text?.x ?? 0.5)
const titleY = computed(() => selected.value?.text?.y ?? 0.85)

const CORNERS = [
	{ key: 'tl', style: { left: '-5px', top: '-5px' } },
	{ key: 'tr', style: { right: '-5px', top: '-5px' } },
	{ key: 'bl', style: { left: '-5px', bottom: '-5px' } },
	{ key: 'br', style: { right: '-5px', bottom: '-5px' } }
]

// ---- The gestures ----

type Gesture = 'move' | 'scale' | 'rotate'

interface Drag {
	gesture: Gesture
	startX: number
	startY: number
	/** The values when the pointer went down — deltas apply to these. */
	base: { x: number; y: number; scale: number; rotation: number; tx: number; ty: number; size: number }
	/** Centre of the frame box in viewport px, for scale/rotate geometry. */
	centreX: number
	centreY: number
}

let drag: Drag | null = null

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

const begin = (gesture: Gesture, event: PointerEvent) => {
	const item = selected.value
	if (!item || !props.frameWidth) return
	// The frame box is this component's offset parent; its centre in viewport
	// coordinates anchors the scale and rotation maths.
	const host = (event.currentTarget as HTMLElement).closest('[data-canvas-frame]')
	const rect = host?.getBoundingClientRect()
	if (!rect) return
	const t = { ...TRANSFORM_DEFAULTS, ...item.transform }
	drag = {
		gesture,
		startX: event.clientX,
		startY: event.clientY,
		base: {
			x: t.x, y: t.y, scale: t.scale, rotation: t.rotation,
			tx: item.text?.x ?? 0.5, ty: item.text?.y ?? 0.85, size: item.text?.size ?? 0.07
		},
		// The clip may already be translated; the untransformed frame centre is
		// what scale distances and rotation angles are measured from.
		centreX: rect.left + rect.width / 2 - t.x * props.frameWidth,
		centreY: rect.top + rect.height / 2 - t.y * props.frameHeight
	}
	store.beginItemGesture()
	window.addEventListener('pointermove', onMove)
	window.addEventListener('pointerup', onUp, { once: true })
}

const onMove = (event: PointerEvent) => {
	const item = selected.value
	if (!drag || !item) return
	const dx = (event.clientX - drag.startX) / props.frameWidth
	const dy = (event.clientY - drag.startY) / props.frameHeight

	if (mode.value === 'title') {
		if (drag.gesture === 'move') {
			store.updateItemGesture(item.id, {
				text: { x: clamp(drag.base.tx + dx, 0, 1), y: clamp(drag.base.ty + dy, 0, 1) }
			})
		} else {
			// Down-right grows, up-left shrinks — the direction the handle sits in.
			store.updateItemGesture(item.id, {
				text: { size: clamp(drag.base.size + (dx + dy) / 2, 0.02, 0.3) }
			})
		}
		return
	}

	if (drag.gesture === 'move') {
		store.updateItemGesture(item.id, {
			transform: {
				...drag.base,
				x: clamp(drag.base.x + dx, OFFSET_RANGE.min, OFFSET_RANGE.max),
				y: clamp(drag.base.y + dy, OFFSET_RANGE.min, OFFSET_RANGE.max)
			}
		})
	} else if (drag.gesture === 'scale') {
		// Uniform, about the centre: the ratio of the pointer's distance now to
		// its distance when the drag began.
		const cx = drag.centreX + drag.base.x * props.frameWidth
		const cy = drag.centreY + drag.base.y * props.frameHeight
		const then = Math.hypot(drag.startX - cx, drag.startY - cy) || 1
		const now = Math.hypot(event.clientX - cx, event.clientY - cy)
		store.updateItemGesture(item.id, {
			transform: {
				...drag.base,
				scale: clamp(drag.base.scale * (now / then), SCALE_RANGE.min, SCALE_RANGE.max)
			}
		})
	} else {
		const cx = drag.centreX + drag.base.x * props.frameWidth
		const cy = drag.centreY + drag.base.y * props.frameHeight
		const then = Math.atan2(drag.startY - cy, drag.startX - cx)
		const now = Math.atan2(event.clientY - cy, event.clientX - cx)
		let rotation = drag.base.rotation + ((now - then) * 180) / Math.PI
		// Snap near the cardinal angles — a hair off square reads as a mistake.
		const nearest = Math.round(rotation / 90) * 90
		if (Math.abs(rotation - nearest) < 3) rotation = nearest
		store.updateItemGesture(item.id, {
			transform: { ...drag.base, rotation: clamp(rotation, -180, 180) }
		})
	}
}

const onUp = () => {
	window.removeEventListener('pointermove', onMove)
	if (!drag) return
	const label = mode.value === 'title'
		? (drag.gesture === 'move' ? 'Move title' : 'Resize title')
		: drag.gesture === 'move' ? 'Move clip' : drag.gesture === 'scale' ? 'Scale clip' : 'Rotate clip'
	drag = null
	store.endItemGesture(label)
}

onBeforeUnmount(() => {
	window.removeEventListener('pointermove', onMove)
	if (drag) { drag = null; store.endItemGesture('Transform clip') }
})
</script>
