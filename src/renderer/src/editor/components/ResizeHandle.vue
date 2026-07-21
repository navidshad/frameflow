<template>
	<div class="group flex items-center justify-center select-none shrink-0"
		:class="direction === 'horizontal'
			? 'h-2 w-full cursor-row-resize'
			: 'w-2 h-full cursor-col-resize flex-col'"
		:style="{ touchAction: 'none' }"
		:title="`Drag to resize — double-click to reset`"
		@pointerdown="onPointerDown"
		@pointermove="onPointerMove"
		@pointerup="onPointerUp"
		@pointercancel="onPointerUp"
		@dblclick="$emit('reset')">
		<!-- Grip line: invisible until hover/drag so the layout stays clean -->
		<div class="rounded-full transition-colors"
			:class="[
				direction === 'horizontal' ? 'h-1 w-16' : 'w-1 h-16',
				dragging ? 'bg-primary/60' : 'bg-transparent group-hover:bg-primary/40'
			]"></div>
	</div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

/**
 * Slim drag bar between panels. Emits `resize(deltaPx)` per pointer move —
 * positive toward the bottom/right; pass the delta through your own clamp.
 * `reverse` flips the sign for panels anchored to the right/bottom edge so
 * "drag toward the panel" always means grow. Double-click emits `reset`.
 */
const props = defineProps<{ direction: 'horizontal' | 'vertical'; reverse?: boolean }>()
const emit = defineEmits<{ (e: 'resize', deltaPx: number): void; (e: 'reset'): void }>()

const dragging = ref(false)
let lastPos = 0

const onPointerDown = (e: PointerEvent) => {
	dragging.value = true
	lastPos = props.direction === 'horizontal' ? e.clientY : e.clientX
	try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
}

const onPointerMove = (e: PointerEvent) => {
	if (!dragging.value) return
	const pos = props.direction === 'horizontal' ? e.clientY : e.clientX
	const delta = pos - lastPos
	if (delta === 0) return
	lastPos = pos
	emit('resize', props.reverse ? -delta : delta)
}

const onPointerUp = (e: PointerEvent) => {
	if (!dragging.value) return
	dragging.value = false
	try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
}
</script>
