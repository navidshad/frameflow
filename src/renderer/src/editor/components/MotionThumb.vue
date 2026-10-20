<template>
	<div ref="box" class="w-full h-11 rounded-lg bg-zinc-900 relative overflow-hidden" aria-hidden="true">
		<!-- The page itself, drawn small: a custom or saved layer has no hand-drawn
		     preview, so the tile shows what the page really draws. Sandboxed like
		     the monitor's, and seeked to the middle of its hold. -->
		<iframe ref="frame" sandbox="allow-scripts" tabindex="-1" referrerpolicy="no-referrer"
			class="absolute top-0 border-0 bg-transparent pointer-events-none"
			:srcdoc="page" :style="style" @load="seek"></iframe>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { composeMotionPage, motionFrameState, type MotionDefinition } from '@shared/motion'

const props = defineProps<{ html: string; definition: MotionDefinition }>()

const W = 1280
const H = 720
const BOX_H = 44

const box = ref<HTMLElement | null>(null)
const frame = ref<HTMLIFrameElement | null>(null)
const width = ref(110)

const spec = computed(() => ({ html: props.html, definition: props.definition, passed: { html: props.html, definition: props.definition } }))
const page = computed(() => composeMotionPage(spec.value, { width: W, height: H }))

const scale = BOX_H / H
const style = computed(() => ({
	width: `${W}px`, height: `${H}px`,
	left: `${Math.max(0, (width.value - W * scale) / 2)}px`,
	transform: `scale(${scale})`, transformOrigin: '0 0', colorScheme: 'normal'
}))

const seek = () => {
	const d = props.definition
	const state = motionFrameState({ motion: spec.value, duration: d.duration, keyframes: undefined }, d.duration / 2)
	frame.value?.contentWindow?.postMessage({
		type: 'frameflow:seek', id: 1, t: state.t, settings: JSON.parse(JSON.stringify(state.settings)), opacity: 1
	}, '*')
}

let observer: ResizeObserver | null = null
onMounted(() => {
	if (!box.value) return
	width.value = box.value.clientWidth || width.value
	observer = new ResizeObserver(() => { width.value = box.value?.clientWidth || width.value })
	observer.observe(box.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>
