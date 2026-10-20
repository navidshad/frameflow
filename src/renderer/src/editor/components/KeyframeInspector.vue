<template>
	<!-- Board 2's right column: the selected key, its value and the ease that
	     arrives at it, and what to do with the lane it is on. -->
	<div v-if="info" class="flex flex-col gap-3.5">
		<div>
			<h3 class="mb-2 text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading truncate">
				{{ info.lane.label }} · key {{ info.index + 1 }} of {{ info.count }}
			</h3>
			<dl class="flex flex-col gap-1.5">
				<div class="flex justify-between gap-2">
					<dt class="lbl !text-zinc-500 dark:!text-zinc-400">Layer</dt>
					<dd class="text-xs font-medium text-zinc-700 dark:text-zinc-200 truncate">{{ layerName }}</dd>
				</div>
				<div class="flex justify-between gap-2">
					<dt class="lbl !text-zinc-500 dark:!text-zinc-400">At</dt>
					<dd class="mono text-xs text-zinc-700 dark:text-zinc-200">
						{{ formatKeyTime(item.timelineStart + info.ref.t, 2) }}
						<span class="text-zinc-500">(+{{ info.ref.t.toFixed(2) }}s)</span>
					</dd>
				</div>
				<div class="flex justify-between gap-2">
					<dt class="lbl !text-zinc-500 dark:!text-zinc-400">Snapped to</dt>
					<dd class="text-xs font-medium truncate" :class="snapClass">{{ snapped?.label ?? '—' }}</dd>
				</div>
			</dl>
		</div>

		<!-- The value: a slider on a number lane, the swatch or the options on a held one. -->
		<div>
			<span class="lbl block mb-1">Value
				<span class="mono normal-case tracking-normal ml-1" :class="info.lane.own ? 'text-pink-400' : 'text-primary'">
					{{ info.lane.format(info.key.value) }}
				</span>
			</span>
			<label v-if="info.lane.kind === 'color'" class="flex items-center gap-1.5 cursor-pointer mt-1">
				<span class="relative w-7 h-6 rounded shrink-0 overflow-hidden" :style="{ background: keyValueColour(info.key.value) }">
					<input type="color" class="absolute inset-0 opacity-0 cursor-pointer" aria-label="Key colour"
						:value="keyValueColour(info.key.value).toLowerCase()"
						@change="kf.setValue(info.ref, colourKeyValue(($event.target as HTMLInputElement).value))" />
				</span>
				<span class="mono text-[11px] text-zinc-400">{{ keyValueColour(info.key.value) }}</span>
			</label>
			<div v-else-if="info.lane.kind === 'enum'" class="flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800/60 mt-1" role="radiogroup" aria-label="Key value">
				<button v-for="(option, i) in info.lane.options" :key="option.value"
					class="flex-1 min-w-0 py-[3px] rounded-md text-[10px] font-semibold truncate transition"
					:class="Math.round(info.key.value) === i
						? 'bg-white dark:bg-zinc-700 text-zinc-800 dark:text-white shadow-sm'
						: 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'"
					role="radio" :aria-checked="Math.round(info.key.value) === i"
					@click="kf.setValue(info.ref, i)">{{ option.label }}</button>
			</div>
			<div v-else class="relative h-1 my-2 rounded-sm bg-zinc-300 dark:bg-zinc-700 cursor-ew-resize touch-none"
				role="slider" aria-label="Key value" :aria-valuenow="info.key.value"
				@pointerdown.prevent="beginValueDrag($event)">
				<div class="absolute left-0 inset-y-0 rounded-sm" :class="info.lane.own ? 'bg-pink-500' : 'bg-primary'"
					:style="{ width: `${fraction * 100}%` }"></div>
				<div class="absolute -top-1 w-3 h-3 rounded-full -ml-1.5" :class="info.lane.own ? 'bg-pink-500' : 'bg-primary'"
					:style="{ left: `${fraction * 100}%` }"></div>
				<div class="absolute -inset-y-1.5 inset-x-0"></div>
			</div>
		</div>

		<!-- Ease INTO this key — stored on the key before it, see easeInto(). -->
		<div>
			<span class="lbl block mb-1.5">Ease into this key</span>
			<div class="grid grid-cols-3 gap-1.5">
				<button v-for="e in EASES" :key="e.id"
					class="py-2 px-1 rounded-lg border flex flex-col items-center gap-1 text-[10px] font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed"
					:class="info.ease === e.id
						? 'border-primary bg-primary/10 text-primary'
						: 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-primary/40 hover:text-primary'"
					:aria-pressed="info.ease === e.id"
					:disabled="!info.easeEditable"
					:title="info.easeEditable ? `${e.label} into this key` : info.easeNote"
					@click="kf.setEase(info.ref, e.id)">
					<svg width="40" height="20" viewBox="0 0 40 20" aria-hidden="true">
						<path :d="e.large" stroke="currentColor" stroke-width="1.5" fill="none" />
					</svg>
					{{ e.label }}
				</button>
			</div>
			<p class="mt-1.5 text-[9px] leading-snug text-zinc-400">
				The same three curves the export uses — what you see in the lane is what renders.
			</p>
		</div>

		<button class="kf-wide" :disabled="!info.easeEditable || info.count < 2"
			@click="kf.easeWholeLane(info.ref.path, info.ease ?? 'linear')">Apply this ease to the whole lane</button>
		<button class="kf-wide" :disabled="info.count < 1" @click="kf.mirror(info.ref.path)">Mirror entrance onto exit</button>

		<div class="rounded-xl bg-secondary/[0.08] border border-secondary/20 p-2.5">
			<span class="lbl9 block mb-2 !text-violet-400">Ask AI about these keys</span>
			<div class="flex flex-wrap gap-1">
				<button v-for="chip in CHIPS" :key="chip"
					class="px-2 py-[3px] rounded-full border border-zinc-300 dark:border-zinc-700 text-[10px] font-medium
					       text-zinc-600 dark:text-zinc-300 hover:border-secondary/50 hover:text-secondary transition disabled:opacity-50"
					:disabled="editor.promptRunning"
					@click="kf.ask(chip)">{{ chip }}</button>
			</div>
		</div>

		<button class="kf-wide !border-red-900/40 !text-red-500" @click="kf.deleteSelected()">
			Delete key{{ kf.selection.length > 1 ? `s (${kf.selection.length})` : '' }}
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { TimelineItem } from '@shared/types'
import type { Ease } from '@shared/keyframes'
import { easeInto, formatKeyTime, isHeldLane, keyIndex, laneRange } from '@shared/keyframeLanes'
import { colourKeyValue, keyValueColour, motionName } from '@shared/motion'
import { useEditorStore } from '../../stores/editorStore'
import { useKeyframeLanesStore } from '../../stores/keyframeLanesStore'

const props = defineProps<{ item: TimelineItem }>()
const editor = useEditorStore()
const kf = useKeyframeLanesStore()

const EASES: { id: Ease; label: string; large: string }[] = [
	{ id: 'linear', label: 'Linear', large: 'M2 18L38 2' },
	{ id: 'ease', label: 'Ease', large: 'M2 18C20 18 20 2 38 2' },
	{ id: 'hold', label: 'Hold', large: 'M2 18H28V2H38' }
]

/** Board 2's two starting points; each runs the editor prompt scoped to these keys. */
const CHIPS = ['Snappier entrance', 'Fade on the breath']

const layerName = computed(() => props.item.label || (props.item.motion ? motionName(props.item.motion) : 'Clip'))

const info = computed(() => {
	const ref = kf.primary
	const lane = kf.primaryLane
	if (!ref || !lane) return null
	const found = keyIndex(kf.tracks, ref)
	if (!found) return null
	const held = isHeldLane(lane)
	const into = easeInto(kf.tracks, ref)
	return {
		ref, lane, key: found.key, index: found.index, count: found.count,
		ease: held ? 'hold' as Ease : into,
		easeEditable: !held && into !== null,
		easeNote: held ? 'A colour or a choice holds until the next key.' : 'Nothing arrives at the first key — pick a later one.'
	}
})

const snapped = computed(() => (info.value ? kf.snappedTo(info.value.ref) : null))

/** Each kind of snap in the colour it has everywhere else: pink moments, green words. */
const snapClass = computed(() => {
	switch (snapped.value?.kind) {
		case 'moment': return 'text-pink-400'
		case 'word': return 'text-emerald-400'
		case 'playhead': case 'key': return 'text-primary'
		default: return 'text-zinc-700 dark:text-zinc-200'
	}
})

const fraction = computed(() => {
	const i = info.value
	if (!i) return 0
	const range = laneRange(i.lane, kf.keysOn(i.ref.path))
	const span = range.max - range.min
	return span > 0 ? Math.max(0, Math.min(1, (i.lane.toDisplay(i.key.value) - range.min) / span)) : 0.5
})

/** Drag the value: painted live, one undo step on release. */
const beginValueDrag = (event: PointerEvent) => {
	const i = info.value
	if (!i) return
	const bar = event.currentTarget as HTMLElement
	const rect = bar.getBoundingClientRect()
	const range = laneRange(i.lane, kf.keysOn(i.ref.path))
	const ref = { ...i.ref }
	const lane = i.lane
	const valueAt = (e: PointerEvent) => {
		const u = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
		return lane.fromDisplay(range.min + u * (range.max - range.min))
	}
	kf.paintValue(ref, valueAt(event))
	const move = (e: PointerEvent) => kf.paintValue(ref, valueAt(e))
	const up = () => {
		window.removeEventListener('pointermove', move)
		kf.endValueGesture()
	}
	window.addEventListener('pointermove', move)
	window.addEventListener('pointerup', up, { once: true })
}
</script>

<style scoped>
.lbl {
	font-size: 10px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: #71717a;
}
.lbl9 {
	font-size: 9px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: #71717a;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
</style>

<style>
.kf-wide {
	width: 100%;
	box-sizing: border-box;
	padding: 8px 12px;
	border-radius: 12px;
	border: 1px solid #e4e4e7;
	background: transparent;
	font-size: 12px;
	font-weight: 700;
	color: #52525b;
	transition: color 0.15s, border-color 0.15s;
}
.dark .kf-wide { border-color: #3f3f46; color: #d4d4d8; }
.kf-wide:hover:not(:disabled) { border-color: rgb(59 130 246 / 0.4); color: #3b82f6; }
.kf-wide:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
