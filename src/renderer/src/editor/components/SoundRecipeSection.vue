<template>
	<div class="space-y-3 pt-1">
		<div class="flex items-center">
			<span class="lbl">Recipe</span>
			<div class="flex-1"></div>
			<span class="text-[10px] font-bold tracking-[.08em] text-accent-light">SYNTH</span>
		</div>

		<!-- The recipe, as a handful of numbers: nothing here is a recording -->
		<div v-if="preset.variants > 1" class="flex items-center gap-3 text-[11px]">
			<span class="w-14 text-zinc-500">Take</span>
			<div class="flex gap-3.5">
				<button v-for="v in preset.variants" :key="v" class="font-semibold pb-0.5 transition"
					:class="recipe.variant === v - 1 ? 'text-zinc-900 dark:text-zinc-50' : 'text-zinc-500 hover:text-zinc-300'"
					:style="recipe.variant === v - 1 ? { boxShadow: 'inset 0 -2px 0 rgb(var(--accent))' } : undefined"
					@click="change({ variant: v - 1 })">{{ v }}</button>
			</div>
		</div>

		<label v-for="row in rows" :key="row.key" class="flex items-center gap-3 text-[11px]">
			<span class="w-14 text-zinc-500">{{ row.label }}</span>
			<input type="range" class="flex-1 accent-accent" :min="row.min" :max="row.max" :step="row.step"
				:value="draft[row.key] ?? row.value" @input="draft[row.key] = Number(($event.target as HTMLInputElement).value)"
				@change="commit(row.key, Number(($event.target as HTMLInputElement).value))" />
			<span class="w-14 text-right tabular-nums">{{ row.format(draft[row.key] ?? row.value) }}</span>
		</label>

		<div class="flex items-center gap-3 text-[11px]">
			<span class="w-14 text-zinc-500">Seed</span>
			<span class="font-semibold tabular-nums">{{ recipe.seed }}</span>
			<button class="text-primary font-semibold hover:underline whitespace-nowrap" @click="store.rerollSound(item.id)">Roll again</button>
		</div>
		<p class="-mt-2 pl-[68px] text-[10px] text-zinc-500">Same seed, same sound, on every computer.</p>

		<div class="flex items-center gap-4">
			<button class="h-7 px-3 rounded-md bg-accent text-[#06281c] text-xs font-bold flex items-center gap-1.5 hover:bg-accent-light transition"
				@click="store.auditionSound(recipe)">
				<span class="iconify tabler--player-play-filled w-3 h-3"></span>Hear it
			</button>
			<span class="text-[10px] text-zinc-500">{{ describeRecipe(recipe) }}</span>
		</div>

		<!-- Which moment it follows -->
		<div class="hair-t pt-3 space-y-2">
			<span class="lbl">Follows</span>
			<template v-if="item.bind && target">
				<div class="flex items-center gap-2 text-[11px]">
					<span class="w-1.5 h-1.5 rounded-full bg-pink-400 shrink-0"></span>
					<span class="flex-1 truncate font-semibold">{{ targetLabel }}</span>
					<span class="tabular-nums text-zinc-500">lead −{{ Math.round((item.bind.leadSec ?? 0) * 1000) }} ms</span>
					<button class="text-primary font-semibold hover:underline" @click="store.bindSound(item.id, undefined)">Unbind</button>
				</div>
				<p class="text-[10px] leading-snug text-zinc-500">Retime or move that clip and this sound goes with it. Drag this one by hand to unbind it.</p>
			</template>
			<template v-else>
				<select class="w-full text-[11px] bg-transparent text-zinc-700 dark:text-zinc-200 cursor-pointer"
					:value="''" @change="follow(($event.target as HTMLSelectElement).value)">
					<option value="">Follow a moment…</option>
					<option v-for="c in openCues" :key="c.id" :value="c.id" class="text-zinc-900">{{ c.label }}</option>
				</select>
				<p class="text-[10px] leading-snug text-zinc-500">Choose a moment and this sound is placed on it, and stays there.</p>
			</template>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { TimelineItem } from '@shared/types'
import { describeRecipe, presetOf, type SoundRecipe } from '@shared/synth'
import { useEditorStore } from '../../stores/editorStore'

/**
 * The Inspect tab for a synthesised sound: what it is, as numbers you can move.
 * A change renders the new recipe (ffmpeg, a few tenths of a second) and points
 * the clip at it, as one undo step. Nothing here touches a recording: it
 * re-makes the sound.
 */
const props = defineProps<{ item: TimelineItem; recipe: Required<SoundRecipe> }>()
const store = useEditorStore()

const preset = computed(() => presetOf(props.recipe.kind))
const draft = reactive<Record<string, number>>({})

const AIR_KINDS = ['send', 'whoosh', 'swish', 'flight']

const sign = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0')

const rows = computed(() => {
	const r = props.recipe
	const list: { key: 'pitch' | 'levelDb' | 'air' | 'durationSec'; label: string; min: number; max: number; step: number; value: number; format: (n: number) => string }[] = [
		{ key: 'pitch', label: 'Pitch', min: -12, max: 12, step: 1, value: r.pitch, format: (n) => `${sign(n)} st` },
		{ key: 'levelDb', label: 'Level', min: -40, max: 0, step: 1, value: r.levelDb, format: (n) => `${n.toString().replace('-', '−')} dB` }
	]
	if (AIR_KINDS.includes(r.kind)) list.push({ key: 'air', label: 'Air', min: 0, max: 1, step: 0.05, value: r.air, format: (n) => `${Math.round(n * 100)} %` })
	if (preset.value.follows) list.push({ key: 'durationSec', label: 'Length', min: 0.2, max: 30, step: 0.1, value: r.durationSec || 1, format: (n) => `${n.toFixed(1)} s` })
	return list
})

const change = (patch: Partial<SoundRecipe>) => { void store.setSoundRecipe(props.item.id, patch) }
const commit = (key: string, value: number) => {
	delete draft[key]
	change({ [key]: value } as Partial<SoundRecipe>)
}

// ---- the moment it follows
const target = computed(() => store.doc?.timeline.find((i) => i.id === props.item.bind?.itemId))
const targetLabel = computed(() => {
	const t = target.value
	const b = props.item.bind
	if (!t || !b) return ''
	const track = store.doc?.tracks.find((x) => x.id === t.trackId)?.name ?? ''
	const moment = b.at === 'start' ? (t.motion ? 'in' : 'start') : b.at === 'out' ? 'out' : 'end'
	return `${track} · ${t.label || (t.motion ? 'Motion layer' : 'Clip')} · ${moment}`
})
const openCues = computed(() => store.soundCues.filter((c) => !c.taken))
const follow = (cueId: string) => {
	const cue = store.soundCues.find((c) => c.id === cueId)
	if (cue) store.bindSound(props.item.id, cue.bind)
}
</script>
