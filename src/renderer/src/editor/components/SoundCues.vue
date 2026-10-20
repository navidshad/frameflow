<template>
	<div class="flex flex-col min-h-0 overflow-hidden">
		<div class="px-3 pt-3 pb-2 shrink-0">
			<div class="flex items-center gap-2">
				<button class="text-zinc-400 hover:text-zinc-200 transition" aria-label="Back to the palette" @click="$emit('close')">
					<span class="iconify tabler--chevron-left w-4 h-4"></span>
				</button>
				<span class="lbl !text-zinc-900 dark:!text-zinc-50">Sound the motion</span>
			</div>
			<p class="mt-1.5 text-[11px] leading-snug text-zinc-500">
				These are the moments on your timeline that want a sound. Each gets one from the palette, started a little early so its hit lands on the moment, and follows it if you move it.
			</p>
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3">
			<div v-for="cue in cues" :key="cue.id" class="flex items-start gap-2.5 py-2 hair-t first:border-t-0"
				:class="{ 'opacity-50': cue.taken }">
				<button class="mt-0.5 w-4 h-4 rounded flex items-center justify-center shrink-0 transition"
					:class="ticked[cue.id] && !cue.taken ? 'bg-accent text-[#06281c]' : 'border border-zinc-500/50'"
					:disabled="cue.taken" :aria-pressed="!!ticked[cue.id]" :aria-label="`Add a sound at ${cue.label}`"
					@click="ticked[cue.id] = !ticked[cue.id]">
					<span v-if="ticked[cue.id] && !cue.taken" class="iconify tabler--check w-3 h-3"></span>
				</button>
				<div class="min-w-0 flex-1">
					<div class="flex items-baseline gap-2">
						<span class="text-[10px] tabular-nums text-zinc-500 w-9 shrink-0">{{ clock(cue.atSec) }}</span>
						<span class="text-[11px] truncate">{{ cue.label }}</span>
					</div>
					<div class="mt-0.5 flex items-center gap-2 pl-11 text-[11px]">
						<template v-if="cue.taken"><span class="text-zinc-500">has a sound</span></template>
						<template v-else>
							<select class="bg-transparent text-accent-light font-semibold outline-none cursor-pointer"
								:value="kinds[cue.id] ?? cue.kind"
								@change="kinds[cue.id] = ($event.target as HTMLSelectElement).value as SoundKind">
								<option v-for="p in SOUND_PRESETS.filter((x) => !x.follows)" :key="p.kind" :value="p.kind" class="text-zinc-900">{{ p.label }}</option>
							</select>
							<span class="text-zinc-500 truncate">{{ cue.reason }}</span>
							<button class="ml-auto text-zinc-400 hover:text-accent-light transition shrink-0" aria-label="Hear it"
								@click="store.auditionSound({ kind: kinds[cue.id] ?? cue.kind })">
								<span class="iconify tabler--player-play-filled w-3 h-3"></span>
							</button>
						</template>
					</div>
				</div>
			</div>
			<p v-if="!cues.length" class="py-4 text-[11px] text-zinc-500">Nothing on the timeline wants a sound yet.</p>
		</div>

		<div class="shrink-0 hair-t px-3 py-3 flex items-center gap-3">
			<button class="h-8 px-3.5 rounded-md bg-primary text-white text-xs font-semibold hover:bg-primary-dark transition disabled:opacity-40 disabled:cursor-not-allowed"
				:disabled="!count || busy" @click="addTicked">
				{{ busy ? 'Making sounds…' : `Add ${count} sound${count === 1 ? '' : 's'}` }}
			</button>
			<span class="text-[11px] text-zinc-500 leading-snug">One step: undo takes them all back.</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { SOUND_PRESETS, type SoundKind } from '@shared/synth'
import { useEditorStore } from '../../stores/editorStore'

/**
 * The cue list: the moments `suggestCues` found, ticked by default where a
 * sound is worth having, each with the palette sound it would get. Adding makes
 * every sound at once, on free effects lanes, in a single undo step.
 */
defineEmits<{ (e: 'close'): void }>()
const store = useEditorStore()

const cues = computed(() => store.soundCues)
const ticked = reactive<Record<string, boolean>>({})
const kinds = reactive<Record<string, SoundKind>>({})
const busy = ref(false)

// A moment seen for the first time takes its default; one the person has already
// ticked or unticked keeps what they chose when the list refreshes.
watch(cues, (list) => {
	for (const c of list) if (!(c.id in ticked)) ticked[c.id] = c.suggested && !c.taken
}, { immediate: true })

const count = computed(() => cues.value.filter((c) => ticked[c.id] && !c.taken).length)

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`

const addTicked = async () => {
	busy.value = true
	try {
		const picked = cues.value.filter((c) => ticked[c.id] && !c.taken)
		await store.addSounds(
			picked.map((c) => ({ recipe: { kind: kinds[c.id] ?? c.kind }, bind: c.bind })),
			`Sound the motion (${picked.length})`
		)
	} finally {
		busy.value = false
	}
}
</script>
