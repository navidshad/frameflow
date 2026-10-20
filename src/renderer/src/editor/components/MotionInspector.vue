<template>
	<div class="flex flex-col gap-3.5">
		<!-- What it is, where it is -->
		<div>
			<h3 class="mb-2 text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading truncate">{{ title }}</h3>
			<dl class="flex flex-col gap-1.5">
				<MetaRow label="Track" :value="trackName" />
				<MetaRow label="Start" :value="formatTime(item.timelineStart)" />
				<MetaRow label="Length" :value="`${item.duration.toFixed(2)}s`" />
			</dl>
		</div>

		<!-- The page's own fields, generated from its settings schema. Animatable
		     numbers live under Animate instead, beside their diamond. -->
		<div v-if="textFields.length || pairFields.length || numberFields.length" class="flex flex-col gap-2">
			<template v-for="field in textFields" :key="field.key">
				<label class="lbl block -mb-1" :for="`mf-${field.key}`">{{ field.label }}</label>
				<textarea v-if="field.multiline" :id="`mf-${field.key}`" rows="2"
					class="motion-inp resize-none" :value="String(values[field.key] ?? '')"
					@input="paintSetting(field.key, ($event.target as HTMLTextAreaElement).value)"
					@change="settleSetting(field.key, ($event.target as HTMLTextAreaElement).value)"></textarea>
				<input v-else :id="`mf-${field.key}`" class="motion-inp" :value="String(values[field.key] ?? '')"
					@input="paintSetting(field.key, ($event.target as HTMLInputElement).value)"
					@change="settleSetting(field.key, ($event.target as HTMLInputElement).value)" />
			</template>

			<div v-if="pairFields.length" class="grid grid-cols-2 gap-2">
				<div v-for="field in pairFields" :key="field.key" class="min-w-0">
					<span class="lbl block mb-1">{{ field.label }}</span>
					<label v-if="field.type === 'color'" class="flex items-center gap-1.5 cursor-pointer">
						<span class="relative w-7 h-6 rounded shrink-0 overflow-hidden" :style="{ background: String(values[field.key]) }">
							<input type="color" class="absolute inset-0 opacity-0 cursor-pointer" :aria-label="field.label"
								:value="String(values[field.key]).toLowerCase()"
								@input="paintSetting(field.key, ($event.target as HTMLInputElement).value.toUpperCase())"
								@change="settleSetting(field.key, ($event.target as HTMLInputElement).value.toUpperCase())" />
						</span>
						<span class="font-mono text-[11px] text-zinc-400">{{ String(values[field.key]).toUpperCase() }}</span>
					</label>
					<div v-else class="flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800/60" role="radiogroup" :aria-label="field.label">
						<button v-for="option in field.options" :key="option.value"
							class="flex-1 min-w-0 py-[3px] rounded-md text-[10px] font-semibold truncate transition"
							:class="values[field.key] === option.value
								? 'bg-white dark:bg-zinc-700 text-zinc-800 dark:text-white shadow-sm'
								: 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'"
							role="radio" :aria-checked="values[field.key] === option.value"
							@click="settleSetting(field.key, option.value)">
							{{ option.label }}
						</button>
					</div>
				</div>
			</div>

			<div v-for="field in numberFields" :key="field.key">
				<div class="flex items-baseline justify-between mb-1">
					<span class="lbl">{{ field.label }}</span>
					<span class="font-mono text-[9px] text-pink-400">{{ formatSetting(field, Number(values[field.key])) }}</span>
				</div>
				<input type="range" class="w-full accent-pink-500" :min="field.min" :max="field.max" :step="field.step ?? 0.01"
					:value="Number(values[field.key])"
					@input="paintSetting(field.key, Number(($event.target as HTMLInputElement).value))"
					@change="settleSetting(field.key, Number(($event.target as HTMLInputElement).value))" />
			</div>
		</div>

		<!-- Moments: the page's windows, retimed for this clip -->
		<div v-if="moments.length > 1">
			<div class="flex items-baseline justify-between mb-1.5">
				<span class="lbl">Moments</span>
				<span class="text-[9px] text-zinc-400">drag to retime</span>
			</div>
			<div ref="barRef" class="relative h-[30px] rounded-lg bg-zinc-200/70 dark:bg-zinc-800/60 select-none touch-none">
				<template v-for="(m, i) in moments" :key="m.name">
					<div v-if="!m.flex" class="absolute inset-y-0 bg-pink-500/30"
						:class="[i === 0 ? 'rounded-l-lg' : '', i === moments.length - 1 ? 'rounded-r-lg' : '']"
						:style="{ left: pct(m.start), width: pct(m.duration) }"></div>
					<span class="absolute top-[9px] text-[9px] whitespace-nowrap pointer-events-none"
						:class="m.flex ? 'text-zinc-400' : 'font-mono text-pink-700 dark:text-pink-200'"
						:style="labelStyle(m, i)">{{ m.name }}</span>
				</template>
				<!-- One handle per inner boundary. Dragging it retimes the fixed
				     window on its outer side; the hold takes up the difference. -->
				<template v-for="b in boundaries" :key="b.index">
					<div class="absolute -top-0.5 -bottom-0.5 w-0.5 bg-pink-400 pointer-events-none"
						:style="{ left: pct(b.at) }"></div>
					<div class="absolute -top-1.5 w-3 h-1.5 rounded-sm bg-pink-400 cursor-ew-resize"
						:style="{ left: `calc(${pct(b.at)} - 5px)` }"
						:aria-label="`Retime ${b.owner}`" role="slider"
						:aria-valuenow="Number(b.at.toFixed(2))"
						@pointerdown.stop.prevent="beginMomentDrag(b, $event)"></div>
				</template>
			</div>
			<div class="grid gap-1.5 mt-2" :style="{ gridTemplateColumns: `repeat(${moments.length}, minmax(0, 1fr))` }">
				<div v-for="m in moments" :key="m.name">
					<span class="lbl9 block mb-0.5 capitalize">{{ m.name }}</span>
					<input class="motion-inp mono !px-1.5 !py-1 !text-[11px]" :aria-label="`${m.name} duration`"
						:value="`${m.duration.toFixed(2)}s`"
						@change="onMomentInput(m.name, ($event.target as HTMLInputElement).value)"
						@keydown.enter.prevent="($event.target as HTMLInputElement).blur()" />
				</div>
			</div>
		</div>

		<!-- Animate -->
		<div>
			<div class="flex items-baseline justify-between mb-1.5">
				<span class="lbl">Animate</span>
				<span class="text-[9px] text-zinc-400">◆ adds a key at the playhead</span>
			</div>
			<div class="flex flex-col gap-1.5">
				<div v-for="row in animateRows" :key="row.path"
					class="grid items-center gap-1.5" style="grid-template-columns: 18px 70px minmax(0, 1fr) 40px">
					<button class="w-[18px] h-[18px] flex items-center justify-center transition"
						:class="keyCount(row.path) ? 'text-blue-400' : 'text-zinc-500 hover:text-blue-400'"
						:aria-label="`Keyframe ${row.label.toLowerCase()}`"
						:title="keyCount(row.path)
							? `${keyCount(row.path)} key(s) — click to add one at the playhead, alt-click to clear`
							: 'Add a key at the playhead'"
						@click="onDiamond(row, $event)">
						<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"
							:fill="keyCount(row.path) ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2"
							stroke-linejoin="round"><path d="M12 3l9 9-9 9-9-9z" /></svg>
					</button>
					<span class="lbl9 truncate" :class="row.own ? '!text-pink-400' : ''">{{ row.label }}</span>
					<div class="relative h-1 rounded-sm bg-zinc-300 dark:bg-zinc-700 cursor-ew-resize touch-none"
						role="slider" :aria-label="row.label" :aria-valuenow="row.value"
						@pointerdown.prevent="beginBarDrag(row, $event)">
						<div class="absolute left-0 inset-y-0 rounded-sm" :class="row.own ? 'bg-pink-500' : 'bg-primary'"
							:style="{ width: `${Math.max(0, Math.min(1, (row.value - row.min) / (row.max - row.min))) * 100}%` }"></div>
						<!-- A taller hit area than the 4px bar it drives. -->
						<div class="absolute -inset-y-1.5 inset-x-0"></div>
					</div>
					<span class="font-mono text-[9px] text-right" :class="row.own ? 'text-pink-400' : 'text-primary'">
						{{ row.format(row.value) }}
					</span>
				</div>
			</div>
			<p class="mt-1.5 text-[9px] leading-snug text-zinc-400">
				Pink rows are the template's own settings. Open the keyframe lanes on the timeline to move keys and set easing.
			</p>
		</div>

		<!-- Ask the AI, scoped to this layer -->
		<div class="rounded-xl bg-secondary/[0.08] border border-secondary/20 p-2.5">
			<div class="flex items-center gap-1.5 mb-2">
				<span class="iconify tabler--sparkles w-3 h-3 text-violet-400"></span>
				<span class="lbl9 !text-violet-400">Ask AI about this layer</span>
			</div>
			<div class="flex flex-wrap gap-1 mb-2">
				<button v-for="chip in suggestions" :key="chip"
					class="px-2 py-[3px] rounded-full border border-zinc-300 dark:border-zinc-700 text-[10px] font-medium
					       text-zinc-600 dark:text-zinc-300 hover:border-secondary/50 hover:text-secondary transition disabled:opacity-50"
					:disabled="store.promptRunning"
					@click="ask(chip)">{{ chip }}</button>
			</div>
			<form class="flex items-center gap-1.5 py-1.5 pr-1.5 pl-2.5 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700"
				@submit.prevent="ask(draft)">
				<input v-model="draft" class="flex-1 min-w-0 bg-transparent text-[11px] text-zinc-700 dark:text-zinc-200 placeholder:text-zinc-500 outline-none"
					placeholder="Tell the AI what to change…" aria-label="Tell the AI what to change about this layer" />
				<button type="submit" aria-label="Send to AI"
					class="w-[22px] h-[22px] rounded-full bg-secondary text-white flex items-center justify-center shrink-0 transition active:scale-95 disabled:opacity-50"
					:disabled="!draft.trim() || store.promptRunning">
					<span class="iconify w-[11px] h-[11px]" :class="store.promptRunning ? 'tabler--loader-2 animate-spin' : 'tabler--send'"></span>
				</button>
			</form>
		</div>

		<!-- The page itself. Read-only here; authoring is its own stage. -->
		<div>
			<button class="w-full flex items-center justify-between pt-2 border-t border-zinc-200 dark:border-zinc-800
			               text-[10px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400 hover:text-primary transition"
				:aria-expanded="showSource" @click="showSource = !showSource">
				<span class="flex items-center gap-1.5"><span class="iconify tabler--code w-3 h-3"></span>Advanced · HTML</span>
				<span class="iconify w-3 h-3 transition-transform" :class="showSource ? 'tabler--chevron-down' : 'tabler--chevron-right'"></span>
			</button>
			<template v-if="showSource">
				<p class="mt-2 text-[9px] leading-snug" :class="lint.ok ? 'text-accent' : 'text-amber-500'">
					{{ lint.ok
						? 'Checks pass: a pure function of t, no network.'
						: `${lint.issues.length} check${lint.issues.length === 1 ? '' : 's'} failed — the runtime neutralises these, but the page should not rely on them.` }}
				</p>
				<ul v-if="!lint.ok" class="mt-1 space-y-0.5">
					<li v-for="(issue, i) in lint.issues" :key="i" class="text-[9px] leading-snug text-zinc-500">
						<span class="font-mono text-amber-500">L{{ issue.line }}</span> {{ issue.message }}
					</li>
				</ul>
				<pre class="mt-2 max-h-64 overflow-auto custom-scrollbar rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800
				            p-2 font-mono text-[9px] leading-snug text-zinc-600 dark:text-zinc-400 whitespace-pre">{{ source }}</pre>
			</template>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, h, ref, type FunctionalComponent } from 'vue'
import type { TimelineItem } from '@shared/types'
import { normalise, valueAt, type Keyframe } from '@shared/keyframes'
import { OFFSET_RANGE, TRANSFORM_DEFAULTS } from '@shared/transform'
import {
	lintMotionHtml, motionFrameState, motionName, motionSettingPath, motionSource, resolveDefinition,
	resolveMoments, sanitiseSetting, settingValues, OPACITY_PATH,
	type MotionSettingDef, type MotionSettingValue, type MotionSpec, type ResolvedMoment
} from '@shared/motion'
import { useEditorStore } from '../../stores/editorStore'

/**
 * The inspector for a selected motion layer — board 1's right column.
 *
 * Every control writes through the store's gesture path: the picture moves
 * while you drag or type, and one release is one undo step. The fields come
 * from the page's settings schema, so a template or a custom page brings its
 * own inspector.
 */

const props = defineProps<{ item: TimelineItem }>()
const store = useEditorStore()

const spec = computed<MotionSpec>(() => props.item.motion ?? {})
const def = computed(() => resolveDefinition(spec.value))
const values = computed(() => settingValues(spec.value, def.value))
const title = computed(() => props.item.label || motionName(spec.value))
const trackName = computed(() => store.doc?.tracks.find((t) => t.id === props.item.trackId)?.name || '—')

/** Where the playhead sits inside the clip. */
const clipTime = computed(() => Math.max(0, Math.min(props.item.duration, store.playheadSec - props.item.timelineStart)))

// ===== Fields =====

const textFields = computed(() => def.value.settings.filter((s) => s.type === 'text'))
const pairFields = computed(() => def.value.settings.filter((s) => s.type === 'color' || s.type === 'enum'))
const numberFields = computed(() => def.value.settings.filter((s) => s.type === 'number' && !s.animate))

const withSetting = (key: string, value: MotionSettingValue): MotionSpec => {
	const setting = def.value.settings.find((s) => s.key === key)
	const clean = setting ? sanitiseSetting(setting, value) : value
	return { ...spec.value, settings: { ...spec.value.settings, [key]: clean } }
}

const paintSetting = (key: string, value: MotionSettingValue) => {
	store.beginItemGesture()
	store.updateItemGesture(props.item.id, { motion: withSetting(key, value) })
}

const settleSetting = (key: string, value: MotionSettingValue) => {
	paintSetting(key, value)
	store.endItemGesture('Edit motion')
}

const formatSetting = (s: MotionSettingDef, v: number) => {
	if (s.unit === '%') return `${Math.round(v * 100)}%`
	const places = s.step !== undefined && s.step < 1 ? Math.min(2, String(s.step).split('.')[1]?.length ?? 0) : 0
	return `${v.toFixed(places)}${s.unit ?? ''}`
}

// ===== Moments =====

const moments = computed(() => resolveMoments(spec.value, props.item.duration, def.value))
const D = computed(() => Math.max(1e-6, props.item.duration))
const pct = (seconds: number) => `${(seconds / D.value) * 100}%`

const labelStyle = (m: ResolvedMoment, i: number) => {
	if (i === 0) return { left: '4px' }
	if (i === moments.value.length - 1) return { right: '4px' }
	// The hold's label sits a little left of its middle, where the design puts it.
	return { left: m.flex ? pct(m.start + m.duration * 0.4) : `calc(${pct(m.start)} + 4px)` }
}

/** Inner boundaries, each owned by the fixed window on its outer side. */
const boundaries = computed(() => {
	const list = moments.value
	const flexIndex = list.findIndex((m) => m.flex)
	return list.slice(0, -1).map((m, i) => {
		const at = m.start + m.duration
		// Left of the hold, the boundary ends the window before it; right of
		// the hold, it starts the window after it.
		const ownerIndex = i < flexIndex ? i : i + 1
		return { index: i, at, owner: list[ownerIndex].name, ownerIndex, leftSide: i < flexIndex }
	})
})

const fixedMoments = () => Object.fromEntries(moments.value.filter((m) => !m.flex).map((m) => [m.name, m.duration]))

const parseSeconds = (text: string) => {
	const n = parseFloat(text.replace(/s\s*$/i, ''))
	return Number.isFinite(n) && n >= 0 ? n : null
}

const onMomentInput = (name: string, text: string) => {
	const seconds = parseSeconds(text)
	const m = moments.value.find((x) => x.name === name)
	if (seconds === null || !m) return
	if (m.flex) {
		// The hold is whatever the length leaves, so setting it sets the length.
		const others = moments.value.filter((x) => !x.flex).reduce((sum, x) => sum + x.duration, 0)
		store.setMotionTiming(props.item.id, fixedMoments(), others + seconds)
	} else {
		store.setMotionTiming(props.item.id, { ...fixedMoments(), [name]: Math.min(seconds, D.value) })
	}
}

const barRef = ref<HTMLElement | null>(null)

const beginMomentDrag = (b: { ownerIndex: number; leftSide: boolean; owner: string }, event: PointerEvent) => {
	const bar = barRef.value
	if (!bar) return
	const rect = bar.getBoundingClientRect()
	const list = moments.value
	const owner = list[b.ownerIndex]
	// The owner window can grow until the hold is gone, never further.
	const flex = list.find((m) => m.flex)
	const max = owner.duration + (flex?.duration ?? 0)
	const move = (e: PointerEvent) => {
		const t = ((e.clientX - rect.left) / rect.width) * D.value
		const length = b.leftSide ? t - owner.start : owner.start + owner.duration - t
		const next = Math.max(0, Math.min(max, Math.round(length * 100) / 100))
		store.beginItemGesture()
		store.updateItemGesture(props.item.id, {
			motion: { ...spec.value, moments: { ...spec.value.moments, ...fixedMoments(), [b.owner]: next } }
		})
	}
	const up = () => {
		window.removeEventListener('pointermove', move)
		store.endItemGesture('Retime motion')
	}
	window.addEventListener('pointermove', move)
	window.addEventListener('pointerup', up, { once: true })
}

// ===== Animate =====

interface AnimateRow {
	path: string
	label: string
	/** The template's own setting (pink), rather than one every layer has. */
	own: boolean
	value: number
	min: number
	max: number
	format: (v: number) => string
	/** Bar position → stored value, and back. */
	toStored: (v: number) => number
	still: () => number
}

const keyCount = (path: string) => normalise(props.item.keyframes?.[path]).length

/** The layer transform as stored, for the transform rows. */
const transformStill = (key: 'x' | 'y') => props.item.transform?.[key] ?? TRANSFORM_DEFAULTS[key]

const animateRows = computed<AnimateRow[]>(() => {
	const u = clipTime.value
	const keys = props.item.keyframes ?? {}
	const frame = motionFrameState(props.item, u)
	const pctFormat = (v: number) => `${Math.round(v * 100)}%`
	// Across / Down are where the layer's centre sits on the frame: 50% is
	// untouched. Stored as the transform's offset from centre, the same
	// `transform.x` / `transform.y` every layer animates and the export reads.
	const position = (key: 'x' | 'y', label: string): AnimateRow => ({
		path: `transform.${key}`, label, own: false,
		value: 0.5 + valueAt(keys[`transform.${key}`], u, transformStill(key)),
		min: 0, max: 1, format: pctFormat,
		toStored: (v) => Math.max(OFFSET_RANGE.min, Math.min(OFFSET_RANGE.max, v - 0.5)),
		still: () => transformStill(key)
	})
	const rows: AnimateRow[] = [
		position('x', 'Across'),
		position('y', 'Down'),
		{
			path: OPACITY_PATH, label: 'Opacity', own: false,
			value: frame.opacity, min: 0, max: 1, format: pctFormat,
			toStored: (v) => Math.max(0, Math.min(1, v)),
			still: () => 1
		}
	]
	for (const s of def.value.settings) {
		if (!s.animate || s.type !== 'number') continue
		const min = s.min ?? 0
		const max = s.max ?? 1
		rows.push({
			path: motionSettingPath(s.key), label: s.label, own: true,
			value: Number(frame.settings[s.key]), min, max,
			format: (v) => formatSetting(s, v),
			toStored: (v) => Number(sanitiseSetting(s, s.step ? Math.round(v / s.step) * s.step : v)),
			still: () => Number(values.value[s.key])
		})
	}
	return rows
})

/** The item's keyframes with one key at the playhead set to `value`. */
const keyedAt = (path: string, value: number): NonNullable<TimelineItem['keyframes']> => {
	const at = Math.round(clipTime.value * 100) / 100
	const existing: Keyframe[] = props.item.keyframes?.[path] ?? []
	const next = [...existing.filter((k) => Math.abs(k.t - at) > 0.005), { t: at, value }].sort((a, b) => a.t - b.t)
	return { ...props.item.keyframes, [path]: next }
}

/**
 * A value from the bar. Keyed → the key at the playhead (a person editing an
 * animated value is editing the curve, as the transform sliders already do).
 * Not keyed → the static value; opacity has none, so its first edit is a key.
 */
const paintRow = (row: AnimateRow, raw: number) => {
	const stored = row.toStored(raw)
	store.beginItemGesture()
	if (keyCount(row.path) || row.path === OPACITY_PATH) {
		store.updateItemGesture(props.item.id, { keyframes: keyedAt(row.path, stored) })
	} else if (row.path.startsWith('transform.')) {
		const axis = row.path.slice('transform.'.length) as 'x' | 'y'
		store.updateItemGesture(props.item.id, {
			transform: { ...TRANSFORM_DEFAULTS, ...props.item.transform, [axis]: stored }
		})
	} else {
		store.updateItemGesture(props.item.id, { motion: withSetting(row.path.slice('motion.'.length), stored) })
	}
}

const beginBarDrag = (row: AnimateRow, event: PointerEvent) => {
	const bar = event.currentTarget as HTMLElement
	const rect = bar.getBoundingClientRect()
	const valueFrom = (e: PointerEvent) =>
		row.min + Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * (row.max - row.min)
	paintRow(row, valueFrom(event))
	const move = (e: PointerEvent) => paintRow(row, valueFrom(e))
	const up = () => {
		window.removeEventListener('pointermove', move)
		store.endItemGesture(keyCount(row.path) ? 'Set keyframe' : 'Edit motion')
	}
	window.addEventListener('pointermove', move)
	window.addEventListener('pointerup', up, { once: true })
}

const onDiamond = (row: AnimateRow, event: MouseEvent) => {
	if (event.altKey) {
		store.clearKeyframes(props.item.id, row.path)
		return
	}
	store.setKeyframe(props.item.id, row.path, clipTime.value, row.toStored(row.value))
}

// ===== Ask AI =====

const draft = ref('')

/**
 * Three starting points. The first names a word from the layer's own text so
 * it reads as being about THIS layer ("Land on “founder”").
 */
const suggestions = computed(() => {
	const texts = textFields.value.map((s) => String(values.value[s.key] ?? '')).filter(Boolean)
	const source = texts[1] ?? texts[0] ?? ''
	const word = source.split(/[\s,.;:—-]+/).find((w) => w.length > 1)?.toLowerCase()
	return [
		word ? `Land on “${word}”` : 'Land on the right word',
		'Softer entrance',
		'Match brand colours'
	]
})

/** The editor prompt, scoped to this layer by the selection it already has. */
const ask = (text: string) => {
	const request = text.trim()
	if (!request || store.promptRunning) return
	if (!store.selectedItemIds.includes(props.item.id)) store.selectItems([props.item.id])
	void store.runPrompt(`About the motion layer "${title.value}" (item ${props.item.id}): ${request}`)
	draft.value = ''
}

// ===== Source =====

const showSource = ref(false)
const source = computed(() => motionSource(spec.value))
const lint = computed(() => lintMotionHtml(source.value))

// ===== Bits =====

const formatTime = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	const cs = Math.floor((seconds % 1) * 100)
	return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

const MetaRow: FunctionalComponent<{ label: string; value: string }> = (p) =>
	h('div', { class: 'flex justify-between' }, [
		// Utility classes, not `.lbl`: scoped styles never reach what a
		// functional component renders.
		h('dt', { class: 'text-[10px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400' }, p.label),
		h('dd', { class: 'font-mono text-xs text-zinc-700 dark:text-zinc-200' }, p.value)
	])
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
/* Unscoped, and prefixed instead: the dark variant has to match `.dark` on
   <html>, which a scoped selector cannot reach. */
.motion-inp {
	box-sizing: border-box;
	width: 100%;
	padding: 6px 8px;
	border-radius: 8px;
	border: 1px solid #e4e4e7;
	background: #fff;
	font-size: 12px;
	color: #27272a;
	outline: none;
}
.motion-inp:focus { border-color: rgb(59 130 246 / 0.6); }
.dark .motion-inp {
	border-color: #3f3f46;
	background: #18181b;
	color: #e4e4e7;
}
</style>
