<template>
	<div class="flex flex-col min-h-0 overflow-hidden">
		<!-- Where a sound comes from. The synth is built in and free; the others
		     wait for a provider (Settings › Audio). -->
		<div class="h-8 shrink-0 hair-b flex items-end gap-3.5 px-3">
			<button class="tab-u !h-[31px] !text-[11px]" :class="{ 'tab-u-active': source === 'synth' }"
				:style="source === 'synth' ? { boxShadow: 'inset 0 -2px 0 rgb(var(--accent))' } : undefined"
				@click="source = 'synth'">Synth</button>
			<button class="tab-u !h-[31px] !text-[11px]" :class="{ 'tab-u-active': source === 'generate' }"
				@click="source = 'generate'">Generate</button>
			<button class="tab-u !h-[31px] !text-[11px]" :class="{ 'tab-u-active': source === 'voice' }"
				@click="source = 'voice'">Voice</button>
		</div>

		<template v-if="source === 'synth'">
			<SoundCues v-if="cuesOpen" class="flex-1 min-h-0" @close="cuesOpen = false" />
			<template v-else>
				<div class="px-3 pt-2.5 pb-1 flex items-center gap-3.5 text-[10px] font-semibold shrink-0">
					<button v-for="g in groups" :key="g" class="transition"
						:class="group === g ? 'text-accent-light' : 'text-zinc-500 hover:text-zinc-300'"
						@click="group = g">{{ g }}</button>
				</div>

				<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-1.5">
					<div v-for="preset in shown" :key="preset.kind"
						class="group flex items-center gap-2 h-[38px] px-1.5 rounded hair-t first:border-t-0 hover:bg-accent/[0.06] transition"
						:class="{ 'bg-accent/[0.10]': playing === preset.kind }"
						@dblclick="add(preset)">
						<button class="w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition"
							:class="playing === preset.kind ? 'text-accent-light' : 'text-zinc-400 hover:text-accent-light'"
							:aria-label="`Hear ${preset.label}`" @click="audition(preset)">
							<span class="iconify tabler--player-play-filled w-3 h-3"></span>
						</button>
						<span class="w-[68px] shrink-0 text-xs font-semibold truncate" :title="preset.description">{{ preset.label }}</span>
						<div class="flex-1 min-w-0 h-6 overflow-hidden">
							<svg v-if="peaks(preset)" :width="barsWidth" height="24" :viewBox="`0 0 ${barsWidth} 24`" aria-hidden="true">
								<path :d="barsPath(peaks(preset)!)" class="stroke-accent-light" stroke-width="2" stroke-linecap="round" fill="none" opacity=".7" />
							</svg>
							<div v-else class="h-full flex items-center"><div class="h-px w-full bg-zinc-500/20"></div></div>
						</div>
						<span class="w-[44px] text-right text-[10px] tabular-nums text-zinc-500 shrink-0">{{ lengthText(preset) }}</span>
						<button class="w-6 h-6 rounded flex items-center justify-center shrink-0 text-zinc-400 hover:text-accent-light hover:bg-accent/10 transition opacity-0 group-hover:opacity-100 focus:opacity-100"
							:aria-label="`Add ${preset.label} at the playhead`" :title="`Add at the playhead (or double-click)`" @click="add(preset)">
							<span class="iconify tabler--plus w-3.5 h-3.5"></span>
						</button>
					</div>
				</div>

				<!-- Make the picture's own moments heard -->
				<div class="shrink-0 hair-t px-3 py-3">
					<button class="text-xs font-semibold text-accent-light hover:text-accent transition flex items-center gap-1.5"
						:disabled="!store.soundCues.length" :class="{ 'opacity-40 cursor-not-allowed': !store.soundCues.length }"
						@click="cuesOpen = true">
						<span class="iconify tabler--sparkles w-3.5 h-3.5"></span>Sound the motion
					</button>
					<p class="mt-1 text-[11px] leading-snug text-zinc-500">
						{{ cueSummary }}
					</p>
				</div>
			</template>
		</template>

		<!-- Generate and Voice need a provider. Each says what it will be, and where to get it. -->
		<div v-else class="flex-1 min-h-0 px-4 py-4 space-y-4">
			<div class="flex gap-2.5 text-zinc-500">
				<span class="iconify tabler--lock w-4 h-4 mt-0.5 shrink-0"></span>
				<div class="text-[11px] leading-snug">
					<p class="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
						{{ source === 'generate' ? 'Sound effects from a prompt' : 'Voice-over from text' }}
					</p>
					<p class="mt-1">
						{{ source === 'generate'
							? 'Describe a sound and a provider makes it once; after that it is a file in your project. Needs a provider key.'
							: 'Type a line and a voice reads it. Needs a provider key.' }}
					</p>
					<button class="mt-2 font-semibold text-primary hover:underline" @click="router.push('/settings')">
						Add one in Settings
					</button>
				</div>
			</div>
			<p class="text-[11px] leading-snug text-zinc-500">
				The built-in synth never needs one: every sound on the Synth tab is made here, offline, the same on every computer.
			</p>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { SOUND_GROUPS, SOUND_PRESETS, soundLength, type SoundGroup, type SoundPreset } from '@shared/synth'
import { waveformPath } from '@shared/audio'
import { useEditorStore } from '../../stores/editorStore'
import SoundCues from './SoundCues.vue'

/**
 * The Sound tab: the palette of built-in sounds, each made by an ffmpeg graph.
 * Hear one with its play button; add it at the playhead with + or a
 * double-click. "Sound the motion" reads the timeline for moments that want a
 * sound and adds a set in one step.
 */
const store = useEditorStore()
const router = useRouter()

const source = ref<'synth' | 'generate' | 'voice'>('synth')
const groups = ['All', ...SOUND_GROUPS] as const
const group = ref<'All' | SoundGroup>('All')
const cuesOpen = ref(false)
const playing = ref<string | null>(null)

const shown = computed(() => SOUND_PRESETS.filter((p) => group.value === 'All' || p.group === group.value))

// Each row draws the sound it will make. They are rendered (and cached) one at
// a time as the panel opens, a few tenths of a second each, never all at once.
onMounted(async () => {
	for (const preset of SOUND_PRESETS) {
		if (!store.soundPreviews[preset.kind]) await store.previewSound({ kind: preset.kind, durationSec: preset.follows ? 1 : undefined })
	}
})

const keyOf = (preset: SoundPreset) => ({ kind: preset.kind, durationSec: preset.follows ? 1 : undefined })
const previewFor = (preset: SoundPreset) => {
	const r = keyOf(preset)
	return Object.entries(store.soundPreviews).find(([k]) => k.startsWith(`${r.kind}|`))?.[1]
}
const peaks = (preset: SoundPreset) => previewFor(preset)?.peaks

const barsWidth = 120
/** Each sound is drawn against its own loudest bar: a quiet sound is still readable. */
const barsPath = (values: number[]) => {
	const loudest = Math.max(1, ...values)
	return waveformPath(values.map((v) => (v / loudest) * 100), 24, barsWidth / values.length, 0.9)
}

const lengthText = (preset: SoundPreset) =>
	preset.follows ? 'follows' : `${soundLength({ kind: preset.kind }).toFixed(2)} s`

const audition = async (preset: SoundPreset) => {
	playing.value = preset.kind
	await store.auditionSound(keyOf(preset))
	setTimeout(() => { if (playing.value === preset.kind) playing.value = null }, Math.min(2500, soundLength(keyOf(preset)) * 1000 + 200))
}

const add = (preset: SoundPreset) => {
	// A bed lasts as long as the project; every other sound is as long as it is.
	const recipe = preset.kind === 'bed'
		? { kind: preset.kind, durationSec: Math.max(4, Math.round(store.contentEnd * 10) / 10) }
		: { kind: preset.kind }
	void store.addSound(recipe, preset.kind === 'bed' ? { atSec: 0 } : {})
}

const cueSummary = computed(() => {
	const open = store.soundCues.filter((c) => !c.taken)
	if (!store.soundCues.length) return 'Add a motion layer or a second clip, and the moments that want a sound show up here.'
	return open.length
		? `Found ${open.length} moment${open.length === 1 ? '' : 's'} without a sound.`
		: 'Every moment already has a sound.'
})
</script>
