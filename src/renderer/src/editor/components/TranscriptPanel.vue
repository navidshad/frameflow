<template>
	<div class="flex flex-col min-h-0 overflow-hidden">
		<div class="px-3 pt-3 pb-1 flex items-center shrink-0">
			<span class="lbl">Transcript <span class="font-mono normal-case tracking-normal font-normal text-zinc-400 ml-1">{{ cues.length }}</span></span>
		</div>

		<div v-if="!store.transcriptCues.length" class="px-4 pb-3 shrink-0">
			<p class="text-[10px] leading-snug text-zinc-400">
				Nothing transcribed yet. Run Transcript on a clip from the Media panel and
				what was said shows up here.
			</p>
		</div>

		<template v-else>
			<div class="px-3 pb-2 shrink-0">
				<input v-model="query" type="search" placeholder="Find a word…"
					class="w-full px-2 py-1.5 rounded-lg text-xs bg-zinc-100 dark:bg-zinc-800
					       border border-zinc-200 dark:border-zinc-700 focus:border-primary outline-none" />
				<div v-if="query.trim()" class="mt-1.5 flex items-center justify-between gap-2">
					<span class="text-[10px] text-zinc-400">
						{{ cues.length }} of {{ store.transcriptCues.length }}
					</span>
					<button v-if="cues.length"
						class="px-2 py-1 rounded-md border border-red-200 dark:border-red-900/40
						       text-[10px] font-bold text-red-500 hover:bg-red-500/10 transition active:scale-95"
						:title="`Cut all ${cues.length} matches out of the timeline`"
						@click="cutAll">
						Cut all {{ cues.length }}
					</button>
				</div>
			</div>

			<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-3">
				<div v-for="cue in cues" :key="`${cue.start}-${cue.text}`"
					class="group flex items-start gap-1.5 px-1.5 py-1 rounded-lg transition"
					:class="isNow(cue) ? 'bg-primary/10' : 'hover:bg-zinc-500/5'">
					<button class="flex-1 min-w-0 text-left" @click="store.seekTo(cue.start)">
						<span class="font-mono text-[9px] text-zinc-400 mr-1.5">{{ clock(cue.start) }}</span>
						<span class="text-[11px] text-zinc-700 dark:text-zinc-200">{{ cue.text }}</span>
					</button>
					<button
						class="shrink-0 w-5 h-5 rounded text-zinc-300 dark:text-zinc-600 opacity-0
						       group-hover:opacity-100 hover:text-red-500 transition"
						title="Cut these words out of the timeline"
						@click="cut(cue)">
						<span class="iconify tabler--scissors w-3 h-3 block mx-auto"></span>
					</button>
				</div>
			</div>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import type { CaptionCue } from '@shared/captions'
import SlimTooltip from '../../components/SlimTooltip.vue'

/**
 * What was said, and where it is now.
 *
 * This is word-level editing's surface: the cues are already mapped onto the
 * timeline by the caption mapper — through trim, retime and duplicate — so
 * cutting one is `removeRanges` on its own span. Nothing here knows about
 * transcripts or ffmpeg; it is a list with a pair of times per row.
 */

defineProps<{ collapsed?: boolean }>()
defineEmits<{ (e: 'update:collapsed', value: boolean): void }>()

const store = useEditorStore()
const query = ref('')

const cues = computed(() => {
	const needle = query.value.trim().toLowerCase()
	if (!needle) return store.transcriptCues
	return store.transcriptCues.filter((c) => c.text.toLowerCase().includes(needle))
})

const isNow = (cue: CaptionCue) =>
	store.playheadSec >= cue.start && store.playheadSec < cue.end

const clock = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	return `${m}:${String(s).padStart(2, '0')}`
}

const cut = (cue: CaptionCue) => {
	store.removeRanges([{ start: cue.start, end: cue.end }], `Cut "${cue.text.slice(0, 20)}"`)
}

/**
 * Every match at once — "remove every 'um'" in one gesture.
 *
 * All the spans go in together rather than one call each: `removeRanges`
 * ripples afterwards, so removing them one at a time would shift the ones not
 * yet removed out from under their own timestamps.
 */
const cutAll = () => {
	const spans = cues.value.map((c) => ({ start: c.start, end: c.end }))
	if (spans.length) store.removeRanges(spans, `Cut ${spans.length} matches`)
}
</script>
