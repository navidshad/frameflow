<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<!-- Mode switch -->
		<div class="px-3 pt-2 pb-1 flex items-center justify-between shrink-0">
			<div class="flex items-center bg-zinc-100/80 dark:bg-zinc-900/80 rounded-lg p-0.5 border border-zinc-200 dark:border-zinc-800">
				<button v-for="m in (['source', 'timeline'] as const)" :key="m"
					class="px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-widest transition"
					:class="mode === m
						? 'bg-primary text-white shadow-md shadow-primary/20 ring-1 ring-primary/20'
						: 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'"
					@click="mode = m">
					{{ m }}
				</button>
			</div>
			<span v-if="mode === 'timeline' && edl.currentSegmentId.value" class="text-[9px] font-mono text-zinc-400 truncate max-w-[50%]">
				{{ activeSegmentLabel }}
			</span>
		</div>

		<!-- ============ SOURCE MODE ============ -->
		<template v-if="mode === 'source'">
			<div v-if="!sourceSrc" class="flex-1 flex flex-col items-center justify-center gap-3 bg-zinc-950/[0.03] dark:bg-black/40">
				<div class="w-14 h-14 rounded-2xl bg-zinc-500/10 flex items-center justify-center text-zinc-400">
					<span class="iconify tabler--player-play w-7 h-7"></span>
				</div>
				<p class="text-xs text-zinc-500 dark:text-zinc-400 font-medium">Import or select media to preview</p>
			</div>
			<template v-else>
				<div class="flex-1 min-h-0 bg-black flex items-center justify-center relative">
					<video ref="sourceVideoRef" :src="sourceSrc" class="max-h-full max-w-full" preload="metadata"
						@loadedmetadata="onSourceLoaded" @timeupdate="onSourceTimeUpdate"
						@play="sourcePlaying = true" @pause="sourcePlaying = false"></video>
					<div v-if="activeClip"
						class="absolute top-2 left-2 px-2 py-1 rounded-lg bg-black/60 backdrop-blur-sm text-[10px] font-mono text-white/90">
						Piece #{{ activeClip.index }} · {{ format(activeClip.in) }}–{{ format(activeClip.out) }}
					</div>
				</div>
				<div class="px-4 py-2.5 flex items-center gap-3 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
					<button
						class="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-95"
						@click="toggleSourcePlay">
						<span :class="sourcePlaying ? 'iconify tabler--player-pause-filled' : 'iconify tabler--player-play-filled'"
							class="w-3.5 h-3.5"></span>
					</button>
					<span class="text-[11px] font-mono text-zinc-600 dark:text-zinc-300">
						{{ format(sourceTime) }} <span class="text-zinc-400">/ {{ format(sourceDuration) }}</span>
					</span>
					<input type="range" class="flex-1 accent-primary h-1 cursor-pointer" min="0" :max="sourceDuration || 0"
						step="0.05" :value="sourceTime" @input="onSourceScrub" />
				</div>
			</template>
		</template>

		<!-- ============ TIMELINE MODE (EDL) ============ -->
		<template v-else>
			<div v-if="!edl.hasContent.value"
				class="flex-1 flex flex-col items-center justify-center gap-3 bg-zinc-950/[0.03] dark:bg-black/40">
				<div class="w-14 h-14 rounded-2xl bg-zinc-500/10 flex items-center justify-center text-zinc-400">
					<span class="iconify tabler--layout-list w-7 h-7"></span>
				</div>
				<p class="text-xs text-zinc-500 dark:text-zinc-400 font-medium">Timeline is empty — drag pieces onto a track</p>
			</div>
			<template v-else>
				<div ref="stageRef" class="flex-1 min-h-0 bg-zinc-950 relative flex items-center justify-center">
					<!-- The sequence frame: what actually gets exported. Sized here
					     rather than in CSS because letterboxing a plain element
					     against BOTH axes is not something CSS can express. -->
					<div class="relative overflow-hidden bg-black ring-1 ring-white/10" :style="frameStyle">
						<!-- Opacity is a NUMBER written every tick, not a CSS transition:
						     inside a transition the blend has to hold its exact frame
						     when you pause or scrub, which a CSS ramp cannot do. -->
						<video ref="videoARef" class="absolute inset-0 w-full h-full"
							:style="{ opacity: edl.inGap.value ? 0 : edl.opacityA.value, ...framingStyle(edl.itemA.value) }"
							preload="auto"></video>
						<video ref="videoBRef" class="absolute inset-0 w-full h-full"
							:style="{ opacity: edl.inGap.value ? 0 : edl.opacityB.value, ...framingStyle(edl.itemB.value) }"
							preload="auto"></video>
						<!-- The exact transition, pre-rendered by the main process with the
						     real filter. Already at sequence geometry with the framing
						     baked in, so it fills the frame flat. -->
						<video ref="videoTRef" class="absolute inset-0 w-full h-full object-contain"
							:style="{ opacity: edl.showCached.value ? 1 : 0 }"
							preload="auto"></video>
						<!-- Titles. Position and size are fractions of the frame in both
						     places, so this and the burned-in version land together
						     without either side converting to the other's units. -->
						<div v-for="title in store.activeTitles" :key="title.id"
							class="absolute pointer-events-none whitespace-pre-wrap text-center"
							:style="titleStyle(title)">{{ title.text!.content }}</div>

						<!-- Captions, laid out from the same metrics the burn uses, so
						     this is a preview rather than an impression of one. -->
						<div v-if="activeCue" class="absolute inset-x-0 bottom-0 flex justify-center
							pointer-events-none" :style="captionBoxStyle">
							<span :style="captionTextStyle">{{ activeCue.text }}</span>
						</div>
						<!-- Audio tracks play through an element pool in the composable
						     (one per track), heard in parallel with the video. -->
						<div v-if="edl.inGap.value"
							class="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
							<template v-if="edl.audioActive.value">
								<span class="iconify tabler--music w-6 h-6 text-white/40"></span>
								<span class="text-[10px] font-mono text-white/30 uppercase tracking-widest">audio only</span>
							</template>
							<span v-else class="text-[10px] font-mono text-white/30 uppercase tracking-widest">gap</span>
						</div>
					</div>
					<div v-if="edl.previewPending.value"
						class="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2 py-1
						       rounded-md bg-black/60 backdrop-blur-sm pointer-events-none">
						<span class="iconify tabler--loader-2 w-3 h-3 text-white/70 animate-spin"></span>
						<span class="text-[9px] font-mono uppercase tracking-widest text-white/60">
							preparing transition
						</span>
					</div>
					<!-- The frame's own label IS the frame picker. It used to live in
					     the inspector's empty state, which an auto-selected asset made
					     unreachable — nobody could ever have found it. -->
					<div class="absolute top-2 right-2">
						<button
							class="px-1.5 py-0.5 rounded-md text-[9px] font-mono transition
							       text-white/30 hover:text-white/80 hover:bg-white/10"
							:title="frameChosen ? 'Sequence frame' : 'Sequence frame — following the footage'"
							@click="frameMenuOpen = !frameMenuOpen">
							{{ seqWidth }}×{{ seqHeight }}
							<span v-if="!frameChosen" class="text-white/25">auto</span>
						</button>
						<template v-if="frameMenuOpen">
							<div class="fixed inset-0 z-40" @click="frameMenuOpen = false"></div>
							<div class="absolute right-0 top-6 z-50 w-40 glass-card rounded-xl border
							            border-zinc-200 dark:border-zinc-800 shadow-lg p-1 origin-top animate-menu">
								<button v-for="preset in FRAME_PRESETS" :key="preset.short"
									class="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-left transition"
									:class="frameChosen && preset.w === seqWidth && preset.h === seqHeight
										? 'bg-primary/10 text-primary'
										: 'text-zinc-600 dark:text-zinc-300 hover:bg-primary/10'"
									@click="chooseFrame(preset)">
									<span class="text-[11px] font-semibold">{{ preset.label }}</span>
									<span class="font-mono text-[9px] text-zinc-400">{{ preset.short }}</span>
								</button>
								<button v-if="frameChosen"
									class="w-full px-2 py-1.5 mt-0.5 rounded-lg text-left text-[11px]
									       text-zinc-500 hover:bg-primary/10 transition"
									@click="store.clearSequenceFrame(); frameMenuOpen = false">
									Match footage
								</button>
								<p class="px-2 pt-1.5 pb-1 text-[9px] text-zinc-400 leading-snug">
									Clips of another shape letterbox unless you set them to fill.
								</p>
							</div>
						</template>
					</div>
				</div>
				<div class="px-4 py-2.5 flex items-center gap-3 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
					<button
						class="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-95"
						@click="store.isPlaying = !store.isPlaying">
						<span :class="store.isPlaying ? 'iconify tabler--player-pause-filled' : 'iconify tabler--player-play-filled'"
							class="w-3.5 h-3.5"></span>
					</button>
					<span class="text-[11px] font-mono text-zinc-600 dark:text-zinc-300">
						{{ format(store.playheadSec) }} <span class="text-zinc-400">/ {{ format(store.contentEnd) }}</span>
					</span>
					<input type="range" class="flex-1 accent-primary h-1 cursor-pointer" min="0"
						:max="store.contentEnd || 0" step="0.05" :value="store.playheadSec"
						@input="onTimelineScrub" />
				</div>
			</template>
		</template>
	</div>
</template>

<script setup lang="ts">
import { captionMetrics, cueAt } from '@shared/captions'
import { effectCss } from '@shared/effects'
import { FRAME_PRESETS, panObjectPosition } from '@shared/framing'
import { toMediaUrl } from '@shared/media-url'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import { useEdlPlayback } from '../composables/useEdlPlayback'

const store = useEditorStore()

const mode = ref<'source' | 'timeline'>('source')

// ===== EDL (timeline) mode =====
const videoARef = ref<HTMLVideoElement | null>(null)
const videoBRef = ref<HTMLVideoElement | null>(null)
const videoTRef = ref<HTMLVideoElement | null>(null)
const edl = useEdlPlayback(videoARef, videoBRef, videoTRef)

onMounted(() => edl.start())

// ===== The sequence frame =====

const seqWidth = computed(() => store.sequenceFrame.width)
const seqHeight = computed(() => store.sequenceFrame.height)
const frameChosen = computed(() => store.doc?.timelineMeta?.frameChosen === true)

const frameMenuOpen = ref(false)
const chooseFrame = (preset: { w: number; h: number }) => {
	store.setSequenceFrame(preset.w, preset.h)
	frameMenuOpen.value = false
}

const stageRef = ref<HTMLElement | null>(null)
const stage = ref({ w: 0, h: 0 })

/** The largest box of the sequence's shape that fits the stage. */
const frameStyle = computed(() => {
	const { w, h } = stage.value
	if (!w || !h) return { width: '100%', height: '100%' }
	const scale = Math.min(w / seqWidth.value, h / seqHeight.value)
	return {
		width: `${Math.floor(seqWidth.value * scale)}px`,
		height: `${Math.floor(seqHeight.value * scale)}px`
	}
})

let stageObserver: ResizeObserver | null = null
// The stage only exists once the timeline tab has content, so observe the ref
// rather than assuming it is there at mount.
watch(stageRef, (el) => {
	stageObserver?.disconnect()
	if (!el) return
	stageObserver = new ResizeObserver(([entry]) => {
		stage.value = { w: entry.contentRect.width, h: entry.contentRect.height }
	})
	stageObserver.observe(el)
	stage.value = { w: el.clientWidth, h: el.clientHeight }
}, { immediate: true })

onBeforeUnmount(() => stageObserver?.disconnect())

// ===== Captions =====

const activeCue = computed(() =>
	store.captionsEnabled ? cueAt(store.captionCues, store.playheadSec) : null
)

/** Metrics for the frame's CURRENT size on screen, not the sequence's — same
 *  fractions, so the words sit where libass will put them. */
const captionMetricsPx = computed(() => {
	const { w, h } = stage.value
	if (!w || !h) return captionMetrics({ width: seqWidth.value, height: seqHeight.value })
	const scale = Math.min(w / seqWidth.value, h / seqHeight.value)
	return captionMetrics({
		width: Math.floor(seqWidth.value * scale),
		height: Math.floor(seqHeight.value * scale)
	})
})

const captionBoxStyle = computed(() => ({
	paddingBottom: `${captionMetricsPx.value.marginV}px`,
	paddingLeft: `${captionMetricsPx.value.marginH}px`,
	paddingRight: `${captionMetricsPx.value.marginH}px`
}))

const captionTextStyle = computed(() => {
	const m = captionMetricsPx.value
	return {
		fontFamily: 'Arial, Helvetica, sans-serif',
		fontWeight: 700,
		fontSize: `${m.fontSize}px`,
		lineHeight: 1.2,
		color: '#fff',
		textAlign: 'center' as const,
		// libass strokes the glyph outline; four shadows is the closest CSS gets
		// without -webkit-text-stroke, which paints INSIDE the letter.
		textShadow: [`${m.outline}px 0`, `-${m.outline}px 0`, `0 ${m.outline}px`, `0 -${m.outline}px`]
			.map((offset) => `${offset} #000`).join(', ')
	}
})

/**
 * A title's box, in the frame's CURRENT pixels.
 *
 * `translate(-50%, -50%)` is the CSS spelling of ASS's `\an5`: the stored x/y
 * is the CENTRE of the text, which is the only anchor that stays put when the
 * words change or the sequence changes shape.
 */
const titleStyle = (item: { text?: { x?: number; y?: number; size?: number; color?: string; outline?: string; bold?: boolean } }) => {
	const spec = item.text ?? {}
	const { w, h } = stage.value
	const scale = w && h ? Math.min(w / seqWidth.value, h / seqHeight.value) : 0
	const frameH = scale ? seqHeight.value * scale : 0
	const size = Math.max(8, (spec.size ?? 0.07) * frameH)
	const outline = Math.max(1, Math.round(size * 0.06))
	const stroke = spec.outline ?? '#000000'
	return {
		left: `${(spec.x ?? 0.5) * 100}%`,
		top: `${(spec.y ?? 0.85) * 100}%`,
		transform: 'translate(-50%, -50%)',
		fontFamily: 'Arial, Helvetica, sans-serif',
		fontWeight: spec.bold === false ? 400 : 700,
		fontSize: `${size}px`,
		lineHeight: 1.15,
		color: spec.color ?? '#FFFFFF',
		textShadow: [`${outline}px 0`, `-${outline}px 0`, `0 ${outline}px`, `0 -${outline}px`]
			.map((offset) => `${offset} ${stroke}`).join(', ')
	}
}

/**
 * How one element fills the frame. `object-position` comes from the same
 * function that writes the export's crop offset, so what is on screen is what
 * burns in — the whole reason the transition cache exists.
 */
const framingStyle = (itemId: string | null) => {
	const item = itemId ? store.doc?.timeline.find((i) => i.id === itemId) : undefined
	// The colour approximation rides along here rather than on the frame, so a
	// graded clip and an ungraded one can sit either side of a transition and
	// each show its own look.
	const filter = effectCss(item?.effects)
	const fit = item?.framing?.mode !== 'fill'
		? { objectFit: 'contain' as const }
		: { objectFit: 'cover' as const, objectPosition: panObjectPosition(item.framing.pan) }
	return filter ? { ...fit, filter } : fit
}

const activeSegmentLabel = computed(() => {
	const item = store.doc?.timeline.find((i) => i.id === edl.currentSegmentId.value)
	return item?.label || ''
})

const onTimelineScrub = (event: Event) => {
	store.seekTo(parseFloat((event.target as HTMLInputElement).value))
}

// Auto-switch: tray clip selection → source; timeline item selection / play → timeline
watch(() => store.selectedClipId, (id) => { if (id) mode.value = 'source' })
watch(() => store.selectedItemIds, (ids) => { if (ids.length) mode.value = 'timeline' })
watch(() => store.isPlaying, (playing) => { if (playing) mode.value = 'timeline' })

// ===== Source mode (single asset / piece preview, from M1) =====
const sourceVideoRef = ref<HTMLVideoElement | null>(null)
const sourcePlaying = ref(false)
const sourceTime = ref(0)
const sourceDuration = ref(0)

const activeClip = computed(() => store.selectedClip)

const sourceSrc = computed(() => {
	const asset = activeClip.value
		? store.assets.find((a) => a.id === activeClip.value!.sourceAssetId)
		: store.selectedAsset
	if (!asset) return null
	const path = asset.proxyPath || asset.originalPath
	return path ? toMediaUrl(path) : null
})

const format = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	const ms = Math.floor((seconds % 1) * 10)
	return `${m}:${String(s).padStart(2, '0')}.${ms}`
}

const onSourceLoaded = () => {
	const video = sourceVideoRef.value
	if (!video) return
	sourceDuration.value = video.duration || 0
	if (activeClip.value) video.currentTime = activeClip.value.in
}

const onSourceTimeUpdate = () => {
	const video = sourceVideoRef.value
	if (!video) return
	sourceTime.value = video.currentTime
	if (activeClip.value && sourcePlaying.value && video.currentTime >= activeClip.value.out) {
		video.pause()
	}
}

const onSourceScrub = (event: Event) => {
	const video = sourceVideoRef.value
	if (!video) return
	const value = parseFloat((event.target as HTMLInputElement).value)
	video.currentTime = value
	sourceTime.value = value
}

const toggleSourcePlay = () => {
	const video = sourceVideoRef.value
	if (!video) return
	if (video.paused) {
		if (activeClip.value && video.currentTime >= activeClip.value.out - 0.05) {
			video.currentTime = activeClip.value.in
		}
		video.play()
	} else {
		video.pause()
	}
}

watch(activeClip, (clip) => {
	const video = sourceVideoRef.value
	if (!video || !clip) return
	video.currentTime = clip.in
	sourceTime.value = clip.in
})
</script>
