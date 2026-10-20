<template>
	<!-- Board 2: one 26px row per property the selected clip can animate, drawn
	     straight under its track. The rows hold the keys as diamonds and the
	     value as a curve sampled from the export's own evaluator. -->
	<div class="relative" data-keyframe-lanes :data-item-id="item.id" @pointerdown.self="kf.clearSelection()">
		<div v-for="row in rows" :key="row.lane.path"
			class="relative border-b border-zinc-200/40 dark:border-zinc-800/40"
			:class="row.focused ? 'bg-primary/[0.08]' : item.motion ? 'bg-pink-500/[0.025]' : 'bg-primary/[0.025]'"
			:style="{ height: `${LANE_ROW_PX}px` }"
			:data-lane="row.lane.path"
			@pointerdown.self="kf.clearSelection()">

			<!-- A held lane (a colour, a choice): each value as a bar to the next key. -->
			<template v-if="row.held">
				<div v-for="(bar, i) in row.bars" :key="`b${i}`"
					class="absolute top-[9px] h-2 rounded-sm pointer-events-none"
					:style="{ left: `${bar.left}px`, width: `${bar.width}px`, background: bar.fill }"
					:title="bar.label"></div>
				<span v-for="(bar, i) in row.bars.slice(1)" :key="`h${i}`"
					class="absolute -top-px font-mono text-[7px] text-zinc-400 pointer-events-none"
					:style="{ left: `${bar.left + 8}px` }">hold</span>
			</template>

			<!-- The curve, only across the clip: nothing animates outside it. -->
			<svg v-else-if="row.path" class="absolute top-0 pointer-events-none overflow-visible"
				:style="{ left: `${clipLeft}px` }" :width="clipWidth" :height="LANE_ROW_PX" aria-hidden="true">
				<path :d="row.path" fill="none" stroke-width="1.5" :stroke="row.stroke" />
			</svg>

			<span v-if="!row.keys.length"
				class="absolute top-2 font-mono text-[9px] text-zinc-400 dark:text-zinc-600 pointer-events-none whitespace-nowrap"
				:style="{ left: `${emptyLeft}px` }">{{ row.empty }}</span>

			<!-- Diamonds. The selected one is bigger, white, ringed. -->
			<button v-for="key in row.keys" :key="key.t"
				class="absolute rotate-45 p-0 cursor-ew-resize focus:outline-none"
				:class="key.selected
					? 'w-2.5 h-2.5 bg-white border-2 border-primary shadow-[0_0_0_3px_rgba(59,130,246,0.35)] z-10'
					: ['w-2 h-2 border border-zinc-950', row.lane.own ? 'bg-pink-400' : 'bg-blue-400']"
				:style="{ left: `${key.x - (key.selected ? 5 : 4)}px`, top: `${key.y - (key.selected ? 5 : 4)}px` }"
				:aria-label="`${row.lane.label} key at ${formatKeyTime(item.timelineStart + key.t, 2)}, ${row.lane.format(key.value)}`"
				:aria-pressed="key.selected"
				@pointerdown.stop.prevent="kf.beginDrag({ path: row.lane.path, t: key.t }, $event)"
				@click.stop></button>
		</div>

		<!-- The key popover: the selected key's value, ease and nudges. -->
		<div v-if="popover"
			class="absolute z-40 w-[236px] rounded-xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl border border-zinc-200 dark:border-zinc-800
			       shadow-[0_10px_30px_rgba(0,0,0,0.5)] p-2.5 flex flex-col gap-2"
			:style="{ left: `${popover.left}px`, top: `${popover.top}px` }"
			role="dialog" :aria-label="`${popover.lane.label} key`"
			@pointerdown.stop>
			<div class="flex items-center justify-between">
				<span class="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200">{{ popover.lane.label }} key</span>
				<span class="font-mono text-[10px] text-blue-400">{{ formatKeyTime(item.timelineStart + popover.ref.t, 2) }}</span>
			</div>
			<div class="grid items-center gap-1.5" style="grid-template-columns: 52px minmax(0, 1fr)">
				<span class="lbl9">Value</span>
				<input class="kf-inp font-mono" :value="popover.lane.format(popover.value)" aria-label="Key value"
					@change="onValueInput(($event.target as HTMLInputElement))"
					@keydown.enter.prevent="($event.target as HTMLInputElement).blur()" />
			</div>
			<div class="grid items-center gap-1.5" style="grid-template-columns: 52px minmax(0, 1fr)">
				<span class="lbl9">Ease</span>
				<div class="flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800/60" role="radiogroup" aria-label="Ease into this key">
					<button v-for="e in EASES" :key="e.id"
						class="flex-1 flex flex-col items-center gap-px py-[3px] rounded-md text-[9px] font-semibold transition disabled:opacity-40"
						:class="popover.ease === e.id
							? 'bg-zinc-300 dark:bg-zinc-700 text-zinc-900 dark:text-white'
							: 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'"
						role="radio" :aria-checked="popover.ease === e.id"
						:disabled="!popover.easeEditable"
						:title="popover.easeEditable ? `${e.label} into this key` : popover.easeNote"
						@click="kf.setEase(popover.ref, e.id)">
						<svg width="22" height="10" viewBox="0 0 22 10" aria-hidden="true">
							<path :d="e.small" stroke="currentColor" stroke-width="1.5" fill="none" />
						</svg>{{ e.label }}
					</button>
				</div>
			</div>
			<div class="flex gap-1">
				<button class="kf-btn flex-1" @click="kf.nudge(-1)">−1 frame</button>
				<button class="kf-btn flex-1" @click="kf.nudge(1)">+1 frame</button>
				<button class="kf-btn !px-2 !border-red-900/40 !text-red-500" aria-label="Delete key" @click="kf.deleteSelected()">
					<span class="iconify tabler--trash w-3 h-3"></span>
				</button>
			</div>
			<span class="text-[9px] leading-snug text-zinc-500">
				Drag keys to move them; they snap to words, moments and cuts. Shift-click selects several.
			</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import type { TimelineItem } from '@shared/types'
import type { Ease } from '@shared/keyframes'
import {
	easeInto, emptyLaneText, formatKeyTime, heldSegments, isHeldLane, isSelected, keyToPx, lanePath,
	laneRange, valueToY, LANE_ROW_PX, type LaneDef
} from '@shared/keyframeLanes'
import { keyValueColour } from '@shared/motion'
import { useEditorStore } from '../../../stores/editorStore'
import { useKeyframeLanesStore } from '../../../stores/keyframeLanesStore'
import { TimelineViewportKey } from '../../composables/useTimelineViewport'

const props = defineProps<{ item: TimelineItem }>()
const store = useEditorStore()
const kf = useKeyframeLanesStore()

/** The three curves, as board 2 draws them in the popover and the inspector. */
const EASES: { id: Ease; label: string; small: string }[] = [
	{ id: 'linear', label: 'Linear', small: 'M1 9L21 1' },
	{ id: 'ease', label: 'Ease', small: 'M1 9C11 9 11 1 21 1' },
	{ id: 'hold', label: 'Hold', small: 'M1 9H15V1H21' }
]

const pps = computed(() => store.pxPerSecond)
const clipLeft = computed(() => keyToPx(props.item.timelineStart, 0, pps.value))
const clipWidth = computed(() => Math.max(1, props.item.duration * pps.value))

/**
 * "no keys · 78%" sits 8px into the clip, as drawn — or 8px into the view when
 * the clip's start has scrolled off, so a long clip's empty lanes still say so.
 */
const viewport = inject(TimelineViewportKey)!
const emptyLeft = computed(() => {
	const end = clipLeft.value + clipWidth.value - 110
	return Math.max(clipLeft.value, Math.min(viewport.scrollLeft.value, end)) + 8
})

/** Enum bars alternate pink and violet, the board's two held colours. */
const ENUM_FILLS = ['#ec4899', '#8b5cf6']

const rows = computed(() => kf.lanes.map((lane: LaneDef) => {
	const keys = kf.keysOn(lane.path)
	const range = laneRange(lane, keys)
	const held = isHeldLane(lane)
	const focused = kf.primary?.path === lane.path
	return {
		lane,
		held,
		focused,
		empty: emptyLaneText(lane),
		keys: keys.map((k) => ({
			t: k.t,
			value: k.value,
			x: keyToPx(props.item.timelineStart, k.t, pps.value),
			// A held lane's diamonds sit on its bars; a curve's on the curve.
			y: held ? 13 : valueToY(lane, range, k.value),
			selected: isSelected(kf.selection, { path: lane.path, t: k.t })
		})),
		path: !held && keys.length > 1
			? lanePath(lane, keys, { clipStart: props.item.timelineStart, pxPerSecond: pps.value, originPx: clipLeft.value })
			: '',
		stroke: lane.own
			? 'rgba(244,114,182,0.5)'
			: focused ? 'rgba(96,165,250,0.6)' : 'rgba(96,165,250,0.45)',
		bars: held
			? heldSegments(lane, keys, props.item.duration).map((s) => ({
				left: keyToPx(props.item.timelineStart, s.start, pps.value),
				width: Math.max(2, (s.end - s.start) * pps.value),
				fill: lane.kind === 'color' ? keyValueColour(s.value) : ENUM_FILLS[Math.round(s.value) % 2],
				label: s.label
			}))
			: []
	}
}))

/**
 * Exactly one key selected and not mid-drag: the popover sits just right of
 * it, rising above its row the way board 2 draws it, never off the top.
 */
const popover = computed(() => {
	if (kf.dragging || kf.selection.length !== 1) return null
	const ref = kf.primary!
	const index = kf.lanes.findIndex((l) => l.path === ref.path)
	const lane = kf.lanes[index]
	if (!lane) return null
	const key = kf.keysOn(ref.path).find((k) => Math.abs(k.t - ref.t) < 0.0005)
	if (!key) return null
	const held = isHeldLane(lane)
	const into = easeInto(kf.tracks, ref)
	return {
		ref, lane,
		value: key.value,
		ease: held ? 'hold' as Ease : into,
		easeEditable: !held && into !== null,
		easeNote: held ? 'A colour or a choice holds until the next key.' : 'Nothing arrives at the first key.',
		left: keyToPx(props.item.timelineStart, ref.t, pps.value) + 18,
		top: Math.max(4, index * LANE_ROW_PX - 38)
	}
})

const onValueInput = (input: HTMLInputElement) => {
	const p = popover.value
	if (!p) return
	const value = kf.parseValue(p.lane, input.value)
	if (value === null) { input.value = p.lane.format(p.value); return }
	kf.setValue(p.ref, value)
}

</script>

<style scoped>
.lbl9 {
	font-size: 9px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: #71717a;
}
</style>

<style>
.kf-inp {
	box-sizing: border-box;
	width: 100%;
	padding: 4px 6px;
	border-radius: 8px;
	border: 1px solid #e4e4e7;
	background: #fff;
	font-size: 11px;
	color: #27272a;
	outline: none;
}
.kf-inp:focus { border-color: rgb(59 130 246 / 0.6); }
.dark .kf-inp { border-color: #3f3f46; background: #18181b; color: #e4e4e7; }
.kf-btn {
	padding: 4px 6px;
	border-radius: 8px;
	border: 1px solid #e4e4e7;
	background: transparent;
	font-size: 10px;
	font-weight: 700;
	color: #52525b;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	transition: color 0.15s, border-color 0.15s;
}
.dark .kf-btn { border-color: #3f3f46; color: #d4d4d8; }
.kf-btn:hover { border-color: rgb(59 130 246 / 0.4); color: #3b82f6; }
</style>
