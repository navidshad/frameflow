<template>
	<!-- Frame-sized, carrying the layer's transform and look like every other
	     layer the monitor stacks; the page inside is laid out at the SEQUENCE's
	     own pixels and scaled down, so a page written in vw/vh lands exactly
	     where the export's full-size capture puts it. -->
	<div class="absolute inset-0 pointer-events-none" :style="wrapperStyle" :data-motion-layer="item.id">
		<!-- sandbox="allow-scripts" and nothing else: an opaque origin, no
		     parent access, no forms, no popups. The page's CSP bans the
		     network; the runtime answers seeks by postMessage. -->
		<iframe ref="frameRef"
			class="absolute left-0 top-0 border-0 bg-transparent"
			sandbox="allow-scripts"
			referrerpolicy="no-referrer"
			tabindex="-1"
			aria-hidden="true"
			:title="`Motion layer: ${item.label || 'motion'}`"
			:srcdoc="page"
			:style="frameStyle"
			@load="onLoad"></iframe>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { TimelineItem } from '@shared/types'
import { composeMotionPage, motionFrameState, normaliseDefinition, type MotionDefinition } from '@shared/motion'
import { useEditorStore } from '../../stores/editorStore'

/**
 * One motion layer in the monitor.
 *
 * Exact by construction rather than by approximation: the page is
 * `composeMotionPage` — the string the export's capture window loads — and
 * each seek carries `motionFrameState` at the playhead, which is what the
 * export evaluates for every frame. Only the scale differs.
 */

const props = defineProps<{
	item: TimelineItem
	/** The sequence frame, in its own pixels. */
	frameWidth: number
	frameHeight: number
	/** The frame box on screen, in CSS px. */
	boxWidth: number
	zIndex: number
	/** Transform and effects, the same helper the other layers use. */
	look: Record<string, string>
}>()

const store = useEditorStore()
const frameRef = ref<HTMLIFrameElement | null>(null)

/**
 * The page itself. Keyed only on what changes the DOCUMENT — the template, a
 * custom page's source, its definition, the frame — so editing a setting or
 * moving the playhead re-seeks the loaded page instead of reloading it.
 */
const pageKey = computed(() => JSON.stringify([
	props.item.motion?.template ?? null,
	props.item.motion?.template ? null : props.item.motion?.html ?? null,
	props.item.motion?.template ? null : props.item.motion?.definition ?? null,
	props.frameWidth, props.frameHeight
]))
const page = computed(() => {
	void pageKey.value
	return composeMotionPage(props.item.motion, { width: props.frameWidth, height: props.frameHeight })
})

const wrapperStyle = computed(() => ({ zIndex: String(props.zIndex), ...props.look }))

const frameStyle = computed(() => ({
	width: `${props.frameWidth}px`,
	height: `${props.frameHeight}px`,
	transform: `scale(${props.boxWidth / props.frameWidth || 0})`,
	transformOrigin: '0 0',
	// Matches the page's own scheme, so Chromium leaves the iframe's canvas
	// transparent instead of painting a dark-mode backdrop behind it.
	colorScheme: 'normal'
}))

// ===== Seeking =====

let ready = false
let seekId = 0

const state = computed(() =>
	motionFrameState(props.item, store.playheadSec - props.item.timelineStart))

const seek = () => {
	const win = frameRef.value?.contentWindow
	if (!win || !ready) return
	const s = state.value
	// Plain data across the boundary: the reactive proxy would not clone.
	win.postMessage({
		type: 'frameflow:seek', id: ++seekId,
		t: s.t, settings: JSON.parse(JSON.stringify(s.settings)), opacity: s.opacity
	}, '*')
}

watch(state, seek, { deep: true })
watch(page, () => { ready = false })

const onLoad = () => {
	// `frameflow:defined` is the real ready signal; a page that defines itself
	// synchronously may already have sent it before load fires, so try anyway.
	ready = true
	seek()
}

/**
 * Messages from THIS layer's page only — `event.source` is the one identity a
 * sandboxed frame cannot forge.
 */
const onMessage = (event: MessageEvent) => {
	if (!frameRef.value || event.source !== frameRef.value.contentWindow) return
	const data = event.data
	if (!data || typeof data.type !== 'string') return
	if (data.type === 'frameflow:defined') {
		ready = true
		seek()
		// A custom page is the authority on its own definition; keep the stored
		// copy in step so timing, the inspector and the export agree with it.
		if (!props.item.motion?.template && data.definition) {
			const own: MotionDefinition = normaliseDefinition(data.definition)
			store.setMotionDefinition(props.item.id, own)
		}
	} else if (data.type === 'frameflow:seeked') {
		if (data.id === seekId) store.motionBounds[props.item.id] = data.bounds ?? null
	} else if (data.type === 'frameflow:error') {
		console.warn(`[motion] ${props.item.label || props.item.id}:`, data.message)
	}
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => {
	window.removeEventListener('message', onMessage)
	delete store.motionBounds[props.item.id]
})
</script>
