<template>
	<svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" aria-hidden="true"
		class="block pointer-events-none" :class="{ 'opacity-40': muted }">
		<path v-if="d" :d="d" class="stroke-accent-light" stroke-width="2" stroke-linecap="round" fill="none"
			:opacity="analysis ? 0.85 : 0.35" />
		<!-- No analysis yet, or no audio in it: a flat line rather than an empty box -->
		<line v-else :x1="0" :x2="width" :y1="height / 2" :y2="height / 2" class="stroke-accent-light" stroke-opacity=".35" />
		<!-- The fades, as the level envelope they apply -->
		<polyline v-if="envelope" :points="envelope" fill="none" stroke="currentColor" stroke-opacity=".55"
			stroke-width="1" stroke-dasharray="3 3" class="text-blue-400" />
	</svg>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { peaksForRange, waveformPath } from '@shared/audio'
import { useEditorStore } from '../../stores/editorStore'

/**
 * A source's waveform, for the part of it a clip plays. It asks the store for
 * the analysis the first time it mounts (measured in the main process, cached
 * on disk) and draws a flat line until that lands.
 *
 * `inSec`/`outSec` are SOURCE seconds, so retiming needs no handling: a faster
 * clip plays the same range in fewer pixels.
 */
const props = defineProps<{
	assetId: string
	inSec: number
	outSec: number
	width: number
	height: number
	/** The clip's own gain scales the bars, so a boosted clip looks it. */
	gain?: number
	/** Scale a quiet sound up so its shape is readable (for the inspector's strip, not the lane). */
	autoScale?: boolean
	muted?: boolean
	/** Fade lengths in px, to draw the envelope. */
	fadeInPx?: number
	fadeOutPx?: number
}>()

const store = useEditorStore()
onMounted(() => store.ensureAudioAnalysis(props.assetId))
watch(() => props.assetId, (id) => store.ensureAudioAnalysis(id))

const analysis = computed(() => store.audioAnalysis[props.assetId])

/** A bar every 3px, capped: a clip zoomed to thousands of px would be tens of KB of path. */
const MAX_BARS = 3000
const d = computed(() => {
	const a = analysis.value
	if (!a?.hasAudio || props.width < 3) return ''
	const bars = Math.min(MAX_BARS, Math.max(1, Math.floor(props.width / 3)))
	const peaks = peaksForRange(a, props.inSec, props.outSec, bars)
	const loudest = Math.max(1, ...peaks)
	const lift = props.autoScale ? Math.min(8, Math.max(1, 70 / loudest)) : 1
	return waveformPath(peaks, props.height, props.width / bars, (props.gain ?? 1) * lift)
})

const envelope = computed(() => {
	const fi = Math.max(0, props.fadeInPx ?? 0)
	const fo = Math.max(0, props.fadeOutPx ?? 0)
	if (!fi && !fo) return ''
	const w = props.width
	const h = props.height
	return `0,${h - 1} ${Math.min(fi, w)},1 ${Math.max(w - fo, 0)},1 ${w},${h - 1}`
})
</script>
