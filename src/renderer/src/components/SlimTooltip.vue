<template>
	<div ref="anchor"
		class="relative group/slim-tooltip inline-flex items-center justify-center"
		@mouseenter="show"
		@mouseleave="hide"
		@focusin="show"
		@focusout="hide"
		@pointerdown="hide">
		<!-- Trigger -->
		<slot />
	</div>

	<!--
		Teleported to the body on purpose.

		As a child of the trigger this was an absolutely positioned box, and any
		ancestor with `overflow: hidden` cut it off — which the timeline panel has,
		so every toolbar tooltip was sliced away at the panel's top edge. A z-index
		cannot climb out of an overflow clip; leaving the subtree can.
	-->
	<Teleport to="body">
		<div v-if="visible && text"
			ref="bubble"
			class="fixed z-[200] pointer-events-none px-2 py-1 rounded bg-zinc-900/90 backdrop-blur-md
			       border border-white/10 text-white text-[9px] font-black uppercase tracking-[0.05em]
			       whitespace-nowrap shadow-2xl flex items-center gap-1.5 transition-opacity duration-150"
			:style="style">
			{{ text }}
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'

const props = withDefaults(defineProps<{
	text: string
	placement?: 'left' | 'right' | 'top' | 'bottom'
}>(), {
	placement: 'left'
})

/** Space between the trigger and the bubble. */
const GAP = 8
/** How close the bubble may come to the window edge before it is pushed back. */
const MARGIN = 8

const anchor = ref<HTMLElement | null>(null)
const bubble = ref<HTMLElement | null>(null)
const visible = ref(false)
const style = ref<Record<string, string>>({})

/**
 * Place the bubble against the trigger, then pull it back inside the window.
 *
 * Measured rather than centred with a transform, because the clamp needs the
 * real width: the widest tooltips sit on the right-hand toolbar buttons, which
 * is exactly where an unclamped one would run off the screen.
 */
const position = () => {
	const trigger = anchor.value?.getBoundingClientRect()
	const box = bubble.value
	if (!trigger || !box) return

	const { offsetWidth: w, offsetHeight: h } = box
	let left: number
	let top: number

	switch (props.placement) {
		case 'top':
			left = trigger.left + trigger.width / 2 - w / 2
			top = trigger.top - h - GAP
			break
		case 'bottom':
			left = trigger.left + trigger.width / 2 - w / 2
			top = trigger.bottom + GAP
			break
		case 'right':
			left = trigger.right + GAP
			top = trigger.top + trigger.height / 2 - h / 2
			break
		default:
			left = trigger.left - w - GAP
			top = trigger.top + trigger.height / 2 - h / 2
	}

	const clamp = (v: number, max: number) => Math.max(MARGIN, Math.min(v, max - MARGIN))
	style.value = {
		left: `${clamp(left, window.innerWidth - w)}px`,
		top: `${clamp(top, window.innerHeight - h)}px`,
		opacity: '1'
	}
}

const show = async () => {
	if (!props.text) return
	// Rendered off-screen for one frame so it can be measured before it is seen.
	style.value = { left: '-9999px', top: '0px', opacity: '0' }
	visible.value = true
	await nextTick()
	position()
	window.addEventListener('scroll', hide, true)
	window.addEventListener('resize', hide)
}

const hide = () => {
	visible.value = false
	window.removeEventListener('scroll', hide, true)
	window.removeEventListener('resize', hide)
}

// A tooltip whose trigger disappears mid-hover would otherwise be stranded on
// the body with nothing left to close it.
onBeforeUnmount(hide)
</script>
