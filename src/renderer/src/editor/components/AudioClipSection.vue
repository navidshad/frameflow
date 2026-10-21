<template>
	<div class="mt-3 space-y-3">
		<!-- The part of the source this clip plays, with its fades as the envelope -->
		<div ref="boxRef" class="h-14 hair-t hair-b overflow-hidden bg-accent/[0.05]">
			<AudioWaveform v-if="width > 0" :asset-id="item.sourceAssetId" :in-sec="item.in" :out-sec="item.out"
				:width="width" :height="56" :gain="item.gain ?? 1" :muted="item.muted" auto-scale
				:fade-in-px="fadePx(item.fadeInSec)" :fade-out-px="fadePx(item.fadeOutSec)" />
		</div>
		<div v-if="item.fadeInSec || item.fadeOutSec" class="flex justify-between text-[10px] text-zinc-500 -mt-1.5 tabular-nums">
			<span>{{ item.fadeInSec ? `fade in ${item.fadeInSec.toFixed(1)}s` : '' }}</span>
			<span>{{ item.fadeOutSec ? `fade out ${item.fadeOutSec.toFixed(1)}s` : '' }}</span>
		</div>

		<!-- What this track is for. A track-level fact, so the control says so. -->
		<div v-if="track" class="flex items-center gap-3">
			<span class="lbl">Track role</span>
			<div class="flex-1"></div>
			<div class="flex gap-3.5 text-[11px]">
				<button v-for="r in TRACK_ROLES" :key="r.id" class="font-semibold pb-0.5 transition"
					:class="track.role === r.id ? 'text-zinc-900 dark:text-zinc-50' : 'text-zinc-500 hover:text-zinc-300'"
					:style="track.role === r.id ? { boxShadow: 'inset 0 -2px 0 rgb(var(--accent))' } : undefined"
					:title="r.description"
					@click="store.setTrackRole(track!.id, track!.role === r.id ? undefined : r.id)">
					{{ r.label }}
				</button>
			</div>
		</div>

		<!-- How loud it is. Measured on the whole source, then moved by this clip's gain. -->
		<div class="flex items-baseline justify-between text-[11px]">
			<span class="text-zinc-500">Loudness</span>
			<span v-if="analysis === undefined" class="text-zinc-400">measuring…</span>
			<span v-else-if="!analysis.hasAudio" class="text-zinc-400">no sound in this file</span>
			<span v-else class="tabular-nums" :title="`The source measures ${formatLufs(analysis.lufs)}; this clip's gain moves it.`">
				{{ formatLufs(clipLufs) }}
				<span v-if="analysis.truePeakDb !== null" class="text-zinc-500 ml-2">peak {{ analysis.truePeakDb.toFixed(1).replace('-', '−') }} dB</span>
			</span>
		</div>
		<p v-if="roleHint" class="text-[10px] leading-snug text-zinc-500">{{ roleHint }}</p>

		<!-- A sound a provider made: where it came from and what it cost. It is a plain file now. -->
		<div v-if="made" class="hair-t pt-3 space-y-1.5">
			<div class="flex items-center">
				<span class="lbl">Made by</span>
				<div class="flex-1"></div>
				<span class="text-[10px] font-bold tracking-[.08em] text-secondary uppercase">{{ madeBy }}</span>
			</div>
			<p class="text-[11px] leading-snug text-zinc-700 dark:text-zinc-300">“{{ made.prompt }}”</p>
			<p class="text-[10px] text-zinc-500">
				{{ CAPABILITY_LABEL[made.capability] }}<template v-if="made.model"> · {{ made.model }}</template> · {{ formatCost(made) }}
				· a file in this project: it plays and exports without {{ madeBy }}.
			</p>
		</div>

		<!-- A synthesised sound is a recipe: its numbers, and the moment it follows -->
		<div v-if="recipe" class="hair-t pt-3">
			<SoundRecipeSection :item="item" :recipe="recipe" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { TimelineItem } from '@shared/types'
import { formatLufs, gainToDb, roleSpec, TRACK_ROLES } from '@shared/audio'
import { useEditorStore } from '../../stores/editorStore'
import AudioWaveform from './AudioWaveform.vue'
import { CAPABILITY_LABEL, formatCost, providerInfo } from '@shared/audioProviders'
import SoundRecipeSection from './SoundRecipeSection.vue'

/**
 * What the Inspect tab shows for a clip on an audio track, above the shared
 * controls (gain, fades, effects): what it looks like, what the track is for,
 * and how loud it is. Video-only controls do not appear for audio.
 */
const props = defineProps<{ item: TimelineItem }>()
const store = useEditorStore()

const track = computed(() => store.doc?.tracks.find((t) => t.id === props.item.trackId))
const analysis = computed(() => store.audioAnalysis[props.item.sourceAssetId])
const recipe = computed(() => store.soundRecipeOf(props.item.id))
const made = computed(() => store.doc?.media.find((a) => a.id === props.item.sourceAssetId)?.generated)
const madeBy = computed(() => (made.value ? providerInfo(made.value.provider)?.label ?? made.value.provider : ''))

onMounted(() => store.ensureAudioAnalysis(props.item.sourceAssetId))

/** The clip's loudness: the source's, moved by this clip's gain. */
const clipLufs = computed(() => {
	const a = analysis.value
	if (!a || a.lufs === null) return null
	const db = gainToDb(props.item.gain ?? 1)
	return Number.isFinite(db) ? a.lufs + db : null
})

/** Where this role should sit relative to the master, so the readout means something. */
const roleHint = computed(() => {
	const spec = roleSpec(track.value?.role)
	if (!spec || spec.id === 'voice') return ''
	return `${spec.label} sits ${Math.abs(spec.offsetLU)} LU under the voice, so it is heard without competing with a word.`
})

// The strip draws at the column's real width, so the envelope is to scale.
const boxRef = ref<HTMLElement | null>(null)
const width = ref(0)
let observer: ResizeObserver | null = null
onMounted(() => {
	if (!boxRef.value) return
	observer = new ResizeObserver(([entry]) => { width.value = Math.floor(entry.contentRect.width) })
	observer.observe(boxRef.value)
	width.value = Math.floor(boxRef.value.clientWidth)
})
onBeforeUnmount(() => observer?.disconnect())

/** A fade as pixels of the strip: its share of the clip's length. */
const fadePx = (sec?: number) => (sec && props.item.duration > 0 ? (sec / props.item.duration) * width.value : 0)

</script>
