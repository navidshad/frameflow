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
		<!-- The box the handles sit on: the whole frame for footage, the
		     content a motion page reported for a motion layer (a lower third is
		     a small thing in the corner, not the frame). Either way the gestures
		     drive the same layer transform, about the frame's centre. -->
		<div class="absolute" :class="motionBox ? '' : 'inset-0'" :style="motionBox ?? undefined">
			<!-- The face: grab anywhere on the picture to move it. -->
			<div class="absolute inset-0 cursor-move border-2"
				:class="motionBox ? 'border-dashed border-primary/80' : 'border-primary/70'"
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
			<!-- Which window the playhead is in, and how far through. -->
			<div v-if="moment"
				class="absolute top-1/2 left-full ml-1.5 -translate-y-1/2 px-1.5 py-0.5 rounded bg-pink-500/90
				       font-mono text-[8px] text-white whitespace-nowrap pointer-events-none">
				{{ moment.name }} · {{ Math.round(moment.progress * 100) }}%
			</div>
		</div>
	</div>

	<!-- A title gets the SAME handles as a clip — the user's point being that
	     anything drawn on the frame should be editable on the frame the same
	     way. Only the box differs: a clip's is the frame, a title's is whatever
	     the text occupies, measured from the node the monitor actually rendered
	     and carrying the same centre-origin rotation the burn applies. -->
	<div v-else-if="mode === 'title' && titleBox"
		class="absolute z-30"
		:style="{
			left: `${titleX * 100}%`,
			top: `${titleY * 100}%`,
			width: `${titleBox.w}px`,
			height: `${titleBox.h}px`,
			transform: `translate(-50%, -50%)${titleRotation ? ` rotate(${titleRotation}deg)` : ''}`
		}">
		<div class="absolute inset-0 cursor-move border-2 border-primary/70"
			@pointerdown.stop.prevent="begin('move', $event)"></div>
		<div v-for="corner in CORNERS" :key="corner.key"
			class="absolute w-2.5 h-2.5 rounded-sm bg-primary border border-white/80 cursor-nwse-resize"
			:style="corner.style"
			@pointerdown.stop.prevent="begin('scale', $event)"></div>
		<div class="absolute left-1/2 -top-6 -translate-x-1/2 flex flex-col items-center"
			@pointerdown.stop.prevent="begin('rotate', $event)">
			<div class="w-2.5 h-2.5 rounded-full bg-primary border border-white/80 cursor-grab"></div>
			<div class="w-px h-3.5 bg-primary/70"></div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import { transformCss, OFFSET_RANGE, SCALE_RANGE, TRANSFORM_DEFAULTS } from '@shared/transform'
import { valueAt } from '@shared/keyframes'
import { momentAt } from '@shared/motion'

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

/** A motion layer's content box, as fractions of the frame — from its page. */
const motionBox = computed(() => {
	const item = selected.value
	if (!item?.motion) return null
	const b = store.motionBounds[item.id]
	if (!b) return null
	// A few pixels of air, so the dashed outline does not sit on the artwork.
	const padX = 6 / (props.frameWidth || 1)
	const padY = 6 / (props.frameHeight || 1)
	return {
		left: `${(b.x - padX) * 100}%`,
		top: `${(b.y - padY) * 100}%`,
		width: `${(b.w + 2 * padX) * 100}%`,
		height: `${(b.h + 2 * padY) * 100}%`
	}
})

const moment = computed(() => {
	const item = selected.value
	if (!item?.motion) return null
	return momentAt(item.motion, item.duration, store.playheadSec - item.timelineStart)
})

const titleX = computed(() => selected.value?.text?.x ?? 0.5)
const titleY = computed(() => selected.value?.text?.y ?? 0.85)
const titleRotation = computed(() => selected.value?.text?.rotation ?? 0)

/**
 * The text's own box, in the frame's pixels.
 *
 * Measured from the rendered node rather than computed from the font size,
 * because the width depends on the string, the wrapping and the face the
 * browser actually resolved — none of which this component can predict. Layout
 * size, not `getBoundingClientRect`: the rect of a rotated element is its
 * bounding square, which would make the handles drift as the title turned.
 */
const titleBox = ref<{ w: number; h: number } | null>(null)

const measureTitle = () => {
	const item = selected.value
	if (!item?.text) { titleBox.value = null; return }
	const node = document.querySelector<HTMLElement>(`[data-title-id="${item.id}"]`)
	// No node means the playhead is not inside the title, so there is nothing on
	// the frame to put handles on.
	titleBox.value = node ? { w: node.offsetWidth, h: node.offsetHeight } : null
}

// Re-measure whenever anything that changes the text's size changes — including
// the frame itself, since the font scales with it.
watch(
	() => [
		selected.value?.id,
		selected.value?.text?.content,
		selected.value?.text?.size,
		selected.value?.text?.bold,
		props.frameWidth,
		props.frameHeight,
		store.playheadSec
	],
	() => nextTick(measureTitle),
	{ immediate: true }
)

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
	base: {
		x: number; y: number; scale: number; rotation: number
		tx: number; ty: number; size: number; trotation: number
	}
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
			tx: item.text?.x ?? 0.5, ty: item.text?.y ?? 0.85,
			size: item.text?.size ?? 0.07, trotation: item.text?.rotation ?? 0
		},
		// A title turns and grows about ITS centre, wherever that sits on the
		// frame; a clip about the frame's, undoing any translation already
		// applied. Same geometry below, different origin.
		centreX: mode.value === 'title'
			? rect.left + (item.text?.x ?? 0.5) * props.frameWidth
			: rect.left + rect.width / 2 - t.x * props.frameWidth,
		centreY: mode.value === 'title'
			? rect.top + (item.text?.y ?? 0.85) * props.frameHeight
			: rect.top + rect.height / 2 - t.y * props.frameHeight
	}
	store.beginItemGesture()
	window.addEventListener('pointermove', onMove)
	window.addEventListener('pointerup', onUp, { once: true })
}

/** Where the gesture pivots, in viewport pixels. */
const pivot = () => ({
	x: drag!.centreX + (mode.value === 'title' ? 0 : drag!.base.x * props.frameWidth),
	y: drag!.centreY + (mode.value === 'title' ? 0 : drag!.base.y * props.frameHeight)
})

/** How much further from the pivot the pointer is now than when it went down. */
const scaleRatio = (event: PointerEvent): number => {
	const { x, y } = pivot()
	const then = Math.hypot(drag!.startX - x, drag!.startY - y) || 1
	return Math.hypot(event.clientX - x, event.clientY - y) / then
}

/** Degrees swept about the pivot since the pointer went down. */
const angleDelta = (event: PointerEvent): number => {
	const { x, y } = pivot()
	const then = Math.atan2(drag!.startY - y, drag!.startX - x)
	const now = Math.atan2(event.clientY - y, event.clientX - x)
	return ((now - then) * 180) / Math.PI
}

/** A hair off square reads as a mistake, so the cardinals pull. */
const snapAngle = (deg: number): number => {
	const nearest = Math.round(deg / 90) * 90
	return Math.abs(deg - nearest) < 3 ? nearest : deg
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
		} else if (drag.gesture === 'scale') {
			// The same ratio-of-distances a clip scales by, so a corner behaves
			// identically whichever kind of thing it belongs to.
			store.updateItemGesture(item.id, {
				text: { size: clamp(drag.base.size * scaleRatio(event), 0.02, 0.5) }
			})
		} else {
			store.updateItemGesture(item.id, {
				text: { rotation: clamp(snapAngle(drag.base.trotation + angleDelta(event)), -180, 180) }
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
		store.updateItemGesture(item.id, {
			transform: {
				...drag.base,
				scale: clamp(drag.base.scale * scaleRatio(event), SCALE_RANGE.min, SCALE_RANGE.max)
			}
		})
	} else {
		store.updateItemGesture(item.id, {
			transform: {
				...drag.base,
				rotation: clamp(snapAngle(drag.base.rotation + angleDelta(event)), -180, 180)
			}
		})
	}
}

const onUp = () => {
	window.removeEventListener('pointermove', onMove)
	if (!drag) return
	const noun = mode.value === 'title' ? 'title' : selected.value?.motion ? 'motion layer' : 'clip'
	const verb = drag.gesture === 'move' ? 'Move' : drag.gesture === 'scale' ? 'Resize' : 'Rotate'
	const label = `${verb} ${noun}`
	drag = null
	store.endItemGesture(label)
}

onBeforeUnmount(() => {
	window.removeEventListener('pointermove', onMove)
	if (drag) { drag = null; store.endItemGesture('Transform clip') }
})
</script>
