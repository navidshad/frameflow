<template>
	<!-- Board 2: where the layer travels, drawn on the frame while one of its
	     position keys is selected — a dashed line through every position key,
	     a dot and a timecode at each place it stops. -->
	<svg v-if="geometry" class="absolute inset-0 z-30 pointer-events-none overflow-visible"
		:width="frameWidth" :height="frameHeight" aria-hidden="true" data-motion-path>
		<polyline :points="geometry.line" fill="none" stroke="#60a5fa" stroke-width="1" stroke-dasharray="3 2" />
		<g v-for="stop in geometry.stops" :key="stop.t">
			<circle :cx="stop.x" :cy="stop.y" r="3" fill="#60a5fa" />
			<text :x="stop.x + 3" :y="stop.y + 14" font-size="8" fill="#93c5fd"
				font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace">{{ stop.label }}</text>
		</g>
	</svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatKeyTime, motionPath } from '@shared/keyframeLanes'
import { TRANSFORM_DEFAULTS } from '@shared/transform'
import { useEditorStore } from '../../stores/editorStore'
import { useKeyframeLanesStore } from '../../stores/keyframeLanesStore'

const props = defineProps<{ frameWidth: number; frameHeight: number }>()
const store = useEditorStore()
const kf = useKeyframeLanesStore()

/** Whether a key on Across or Down is the one selected. */
const positionKeySelected = (path: string | undefined) => path === 'transform.x' || path === 'transform.y'

/**
 * A timecode is about 32px wide at 8px: on a small monitor two stops can sit
 * closer than that, and their labels would print over each other. The later
 * one keeps its dot and drops its label.
 */
const LABEL_PX = 32
const labelled = <T extends { x: number; y: number; label: string }>(stops: T[]): T[] => {
	const shown: T[] = []
	return stops.map((s) => {
		const clash = shown.some((o) => Math.abs(o.x - s.x) < LABEL_PX && Math.abs(o.y - s.y) < 10)
		if (clash) return { ...s, label: '' }
		shown.push(s)
		return s
	})
}

const geometry = computed(() => {
	const item = kf.item
	if (!kf.expanded || !item || !positionKeySelected(kf.primary?.path)) return null
	const still = { ...TRANSFORM_DEFAULTS, ...item.transform }
	// The point that travels: a motion page's own content (its lower-left, where
	// board 2 hangs the path), or the middle of the frame for footage.
	const box = item.motion ? store.motionBounds[item.id] : null
	const anchor = box ? { x: box.x, y: box.y + box.h } : { x: 0.5, y: 0.5 }
	const path = motionPath(item.keyframes, still, anchor)
	if (path.points.length < 1) return null
	const px = (p: { x: number; y: number }) => ({ x: p.x * props.frameWidth, y: p.y * props.frameHeight })
	return {
		line: path.points.map((p) => { const q = px(p); return `${q.x.toFixed(1)},${q.y.toFixed(1)}` }).join(' '),
		stops: labelled(path.stops.map((s) => ({ t: s.t, ...px(s), label: formatKeyTime(item.timelineStart + s.t) })))
	}
})
</script>
