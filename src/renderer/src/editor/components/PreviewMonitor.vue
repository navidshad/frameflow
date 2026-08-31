<template>
	<!-- Fullscreen is a CSS promotion, not a second monitor: the same element
	     grows to fill the window, so playback, the guides and the caption
	     overlay all carry on rather than being torn down and rebuilt. -->
	<div class="glass-card flex flex-col min-h-0 overflow-hidden"
		:class="store.monitorFullscreen
			? 'fixed inset-0 z-[90] rounded-none'
			: 'rounded-2xl'">
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
					<div class="relative bg-black ring-1 ring-white/10" data-canvas-frame
						:class="gizmoActive ? '' : 'overflow-hidden'"
						:style="frameStyle">
						<!-- Generated layers, UNDER the video elements because a
					     background is what the pair sits on. Solid and gradient map
					     onto CSS exactly; grain and bars get the notice instead. -->
					<div v-for="layer in store.activeGenerators" :key="layer.id"
						class="absolute inset-0 pointer-events-none"
						:style="{ background: generatorCss(layer.generator) || '#000' }"></div>

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
						<!-- The layer above the base track, drawn ON TOP of everything the
						     pair does — including a transition, which is where the export
						     puts it too. One element, so one extra layer previews; the
						     export composites every track. -->
						<video ref="videoORef" class="absolute inset-0 w-full h-full"
							:style="{ opacity: edl.itemO.value ? 1 : 0, ...framingStyle(edl.itemO.value) }"
							preload="auto" muted></video>
						<!-- The exact frame: one frame rendered through the real export
						     graph, shown over the live elements. Everything the monitor
						     cannot draw honestly — keys, LUTs, gamma, full layer stacks —
						     is in this picture. Titles and captions stay above it in the
						     DOM, exactly where the export burns them. -->
						<img v-if="exactFrame.src" :src="exactFrame.src"
							class="absolute inset-0 w-full h-full object-contain pointer-events-none" />
						<div v-if="exactFrame.src"
							class="absolute top-2 left-2 px-1.5 py-0.5 rounded-md bg-accent/80
							       pointer-events-none">
							<span class="text-[8px] font-mono uppercase tracking-widest text-white">exact</span>
						</div>

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
						<!-- The selected item's handles, editable on the picture itself.
						     Overflow unclips while they are up, so a corner dragged past
						     the frame edge stays grabbable. -->
						<CanvasGizmo v-if="gizmoActive"
							:frame-width="frameBox.w" :frame-height="frameBox.h" />

						<!-- Guides. Fractions of the frame, so they follow the sequence
						     when its shape changes — the rule titles and framing follow.
						     Above everything, because they are about what covers it. -->
						<template v-if="activeGuide">
							<template v-if="activeGuide.kind === 'grid'">
								<div v-for="line in gridLines" :key="line.key"
									class="absolute bg-white/25 pointer-events-none" :style="line.style"></div>
							</template>
							<template v-else>
								<div v-for="band in activeGuide.bands" :key="band.label"
									class="absolute bg-black/45 border border-white/20 pointer-events-none
									       flex items-end justify-start"
									:style="{
										left: `${band.x * 100}%`, top: `${band.y * 100}%`,
										width: `${band.w * 100}%`, height: `${band.h * 100}%`
									}">
									<span class="px-1 text-[8px] font-mono uppercase tracking-widest text-white/50 truncate">
										{{ band.label }}
									</span>
								</div>
								<div v-if="safeRect" class="absolute border border-dashed border-accent/70 pointer-events-none"
									:style="{
										left: `${safeRect.x * 100}%`, top: `${safeRect.y * 100}%`,
										width: `${safeRect.w * 100}%`, height: `${safeRect.h * 100}%`
									}"></div>
							</template>
						</template>

						<!-- Audio tracks play through an element pool in the composable
						     (one per track), heard in parallel with the video. -->
						<!-- Not while the overlay has a picture: the base track being in
						     a gap does not make the FRAME empty, and a "gap" placard
						     over a live layer was the monitor calling itself blank. -->
						<div v-if="edl.inGap.value && !edl.itemO.value"
							class="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
							<template v-if="edl.audioActive.value">
								<span class="iconify tabler--music w-6 h-6 text-white/40"></span>
								<span class="text-[10px] font-mono text-white/30 uppercase tracking-widest">audio only</span>
							</template>
							<span v-else class="text-[10px] font-mono text-white/30 uppercase tracking-widest">gap</span>
						</div>
					</div>
					<!-- The monitor stacks <video> elements; CSS has no chroma key, so
					     a keyed layer previews UNKEYED. Saying so beats a preview
					     that quietly disagrees with the export. -->
					<div v-if="keyedLayer"
						class="absolute bottom-2 left-2 px-2 py-1 rounded-md bg-black/60 backdrop-blur-sm
						       pointer-events-none flex items-center gap-1.5">
						<span class="iconify tabler--eye-off w-3 h-3 text-white/60"></span>
						<span class="text-[9px] font-mono uppercase tracking-widest text-white/50">
							{{ store.activeGenerators.some((g) => !hasGeneratorCss(g.generator))
								? 'background renders on export'
								: 'key applies on export' }}
						</span>
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
				<!-- No transport here: play and the frame steps live in the timeline
				     toolbar, beside the thing they move. What stays is the monitor's
				     own readout and the tools that change how the frame is shown. -->
				<div class="px-4 py-2.5 flex items-center gap-3 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
					<!-- Type a timecode to go there. A scrub bar cannot hit a frame. -->
					<span class="text-[11px] font-mono text-zinc-600 dark:text-zinc-300 shrink-0">
						<input :value="timecodeText" @focus="onTimecodeFocus" @blur="onTimecodeCommit"
							@keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
							@keydown.esc.prevent="onTimecodeCancel"
							class="w-[4.5rem] bg-transparent text-right outline-none rounded px-1
							       hover:bg-zinc-500/10 focus:bg-zinc-500/10 focus:text-primary transition"
							title="Type a time and press Enter" />
						<span class="text-zinc-400">/ {{ format(store.contentEnd) }}</span>
					</span>
					<input type="range" class="flex-1 accent-primary h-1 cursor-pointer" min="0"
						:max="store.contentEnd || 0" step="0.05" :value="store.playheadSec"
						@input="onTimelineScrub" />

					<button
						class="w-7 h-7 shrink-0 flex items-center justify-center rounded-lg transition active:scale-95"
						:class="exactFrame.src
							? 'text-accent bg-accent/10'
							: 'text-zinc-400 hover:text-primary hover:bg-primary/10'"
						:title="exactFrame.status === 'rendering'
							? 'Rendering the exact frame…'
							: 'Exact frame — render this instant through the real export pipeline'"
						:disabled="exactFrame.status === 'rendering'"
						@click="renderExact">
						<span class="iconify w-4 h-4"
							:class="exactFrame.status === 'rendering'
								? 'tabler--loader-2 animate-spin'
								: 'tabler--camera'"></span>
					</button>
					<button
						class="w-7 h-7 shrink-0 flex items-center justify-center rounded-lg transition active:scale-95"
						:class="exactPinned
							? 'text-accent bg-accent/10'
							: 'text-zinc-400 hover:text-primary hover:bg-primary/10'"
						:title="exactPinned
							? 'Exact frame pinned — re-renders whenever the playhead settles. Click to unpin.'
							: 'Pin the exact frame — re-render it automatically when the playhead settles'"
						@click="exactPinned = !exactPinned">
						<span class="iconify tabler--pin w-4 h-4"
							:class="exactPinned ? '' : 'rotate-45'"></span>
					</button>

					<div class="relative shrink-0">
						<button
							class="w-7 h-7 flex items-center justify-center rounded-lg transition active:scale-95"
							:class="activeGuide
								? 'text-primary bg-primary/10'
								: 'text-zinc-400 hover:text-primary hover:bg-primary/10'"
							:title="activeGuide ? `Guide: ${activeGuide.label}` : 'Guides — safe areas and grids'"
							@click="guideMenuOpen = !guideMenuOpen">
							<span class="iconify tabler--grid-dots w-4 h-4"></span>
						</button>
						<template v-if="guideMenuOpen">
							<div class="fixed inset-0 z-40" @click="guideMenuOpen = false"></div>
							<div class="absolute right-0 bottom-9 z-50 w-56 glass-card rounded-xl border
							            border-zinc-200 dark:border-zinc-800 shadow-lg p-1 animate-menu">
								<button v-for="guide in availableGuides" :key="guide.id"
									class="w-full text-left px-2 py-1.5 rounded-lg transition"
									:class="store.activeGuideId === guide.id
										? 'bg-primary/10 text-primary'
										: 'text-zinc-600 dark:text-zinc-300 hover:bg-primary/10'"
									@click="chooseGuide(guide.id)">
									<span class="block text-[11px] font-semibold">{{ guide.label }}</span>
									<span class="block text-[9px] text-zinc-400 leading-snug">{{ guide.note }}</span>
								</button>
								<button v-if="store.activeGuideId"
									class="w-full text-left px-2 py-1.5 mt-0.5 rounded-lg text-[11px]
									       text-zinc-500 hover:bg-primary/10 transition"
									@click="chooseGuide(null)">
									None
								</button>
								<p v-if="!isVerticalFrame" class="px-2 pt-1.5 pb-1 text-[9px] text-zinc-400 leading-snug">
									Platform safe areas appear when the sequence is vertical.
								</p>
							</div>
						</template>
					</div>

					<button
						class="w-7 h-7 shrink-0 flex items-center justify-center rounded-lg transition active:scale-95
						       text-zinc-400 hover:text-primary hover:bg-primary/10"
						:title="store.monitorFullscreen ? 'Leave fullscreen (F or Esc)' : 'Fullscreen (F)'"
						@click="store.monitorFullscreen = !store.monitorFullscreen">
						<span class="iconify w-4 h-4"
							:class="store.monitorFullscreen ? 'tabler--minimize' : 'tabler--maximize'"></span>
					</button>
				</div>
			</template>
		</template>
	</div>
</template>

<script setup lang="ts">
import { captionMetrics, cueAt } from '@shared/captions'
import { guideById, guidesFor, isVertical, safeArea } from '@shared/guides'
import { effectCss } from '@shared/effects'
import { generatorCss, hasGeneratorCss } from '@shared/generators'
import { transformCss } from '@shared/transform'
import { FRAME_PRESETS, panObjectPosition } from '@shared/framing'
import { toMediaUrl } from '@shared/media-url'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import { useEdlPlayback } from '../composables/useEdlPlayback'
import CanvasGizmo from './CanvasGizmo.vue'

const store = useEditorStore()
const api = (window as any).api

// The edit is the subject of this app, so the monitor opens on it. SOURCE is
// somewhere you go to look at one piece of footage, not where you start.
const mode = ref<'source' | 'timeline'>('timeline')

// ===== EDL (timeline) mode =====
const videoARef = ref<HTMLVideoElement | null>(null)
const videoBRef = ref<HTMLVideoElement | null>(null)
const videoTRef = ref<HTMLVideoElement | null>(null)
const videoORef = ref<HTMLVideoElement | null>(null)
const edl = useEdlPlayback(videoARef, videoBRef, videoTRef, videoORef)

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

/**
 * Whether anything on screen right now is something the monitor cannot draw
 * honestly: a keyed layer (CSS has no chroma key) or a generator with no CSS
 * equivalent. Saying so beats a preview that quietly disagrees with the export.
 */
const keyedLayer = computed(() => {
	const ids = [edl.itemA.value, edl.itemB.value, edl.itemO.value].filter(Boolean)
	const keyed = ids.some((id) => !!store.doc?.timeline.find((i) => i.id === id)?.key)
	const opaque = store.activeGenerators.some((g) => !hasGeneratorCss(g.generator))
	return keyed || opaque
})

// Esc leaves fullscreen. The shortcut table's Esc is Deselect, and while the
// monitor fills the window that is not what Esc should mean.
const onFullscreenEscape = (event: KeyboardEvent) => {
	if (event.key === 'Escape' && store.monitorFullscreen) {
		event.stopPropagation()
		store.monitorFullscreen = false
	}
}
onMounted(() => window.addEventListener('keydown', onFullscreenEscape, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onFullscreenEscape, true))

// ===== The canvas gizmo =====

/** Only for a single selected item that has a picture on the frame, and only
 *  while paused — during playback the handles would chase a moving target. */
const gizmoActive = computed(() => {
	if (store.isPlaying || store.selectedItemIds.length !== 1) return false
	const item = store.doc?.timeline.find((i) => i.id === store.selectedItemIds[0])
	if (!item) return false
	if (item.text) {
		// A title's anchor only makes sense while the title is on screen.
		return store.playheadSec >= item.timelineStart &&
			store.playheadSec < item.timelineStart + item.duration
	}
	const track = store.doc?.tracks.find((t) => t.id === item.trackId)
	return track?.kind === 'video'
})

/** The frame box's px size, which the gizmo needs to turn deltas into fractions. */
const frameBox = computed(() => {
	const { w, h } = stage.value
	if (!w || !h) return { w: 0, h: 0 }
	const scale = Math.min(w / seqWidth.value, h / seqHeight.value)
	return { w: Math.floor(seqWidth.value * scale), h: Math.floor(seqHeight.value * scale) }
})

// ===== The exact frame =====

/**
 * The truth, on demand. The live elements approximate; this asks the export
 * pipeline for the one frame under the playhead and lays it over them. It
 * clears the moment anything it depicts could have changed — a playhead move
 * or an edit — because a stale "exact" frame is the one lie this feature must
 * never tell.
 */
const exactFrame = ref<{ status: 'idle' | 'rendering' | 'error'; src: string | null }>({
	status: 'idle', src: null
})

let exactRequest = 0

const renderExact = async () => {
	if (!store.threadId || !store.doc) return
	const request = ++exactRequest
	exactFrame.value = { status: 'rendering', src: exactFrame.value.src }
	try {
		const result = await api.renderExactFrame({
			threadId: store.threadId,
			doc: JSON.parse(JSON.stringify(store.doc)),
			timeSec: store.playheadSec
		})
		// A move or an edit while rendering makes this frame already stale.
		if (request !== exactRequest) return
		exactFrame.value = { status: 'idle', src: toMediaUrl(result.path) }
	} catch (error) {
		console.warn('[monitor] exact frame failed:', error)
		if (request === exactRequest) exactFrame.value = { status: 'error', src: null }
	}
}

const clearExact = () => {
	exactRequest++
	if (exactFrame.value.src || exactFrame.value.status === 'rendering') {
		exactFrame.value = { status: 'idle', src: null }
	}
}

/**
 * Pinned mode: the truth follows the playhead, on the playhead's schedule.
 *
 * Justified by measurement — a graded, keyed, composited 1080p frame renders
 * in 0.2–0.4s — but still debounced behind a settle, because the one thing
 * this must never do is queue an encode per scrub tick. Playback keeps the
 * live elements in charge; the frame only lands when everything is still.
 */
const exactPinned = ref(false)
let settleTimer: ReturnType<typeof setTimeout> | null = null

const scheduleExact = () => {
	if (settleTimer) clearTimeout(settleTimer)
	if (!exactPinned.value) return
	settleTimer = setTimeout(() => {
		if (!store.isPlaying && exactPinned.value) void renderExact()
	}, 600)
}

watch(() => store.playheadSec, () => { clearExact(); scheduleExact() })
watch(() => store.doc?.historyRef.currentStepId, () => { clearExact(); scheduleExact() })
watch(exactPinned, (on) => (on ? scheduleExact() : clearExact()))
watch(() => store.isPlaying, (playing) => {
	if (playing) clearExact()
	else scheduleExact()
})

onBeforeUnmount(() => { if (settleTimer) clearTimeout(settleTimer) })

// ===== Guides =====

const guideMenuOpen = ref(false)

const isVerticalFrame = computed(() =>
	isVertical({ width: seqWidth.value, height: seqHeight.value })
)

const availableGuides = computed(() =>
	guidesFor({ width: seqWidth.value, height: seqHeight.value })
)

/** Only draw a guide that still applies — the sequence shape can change. */
const activeGuide = computed(() => {
	const guide = guideById(store.activeGuideId)
	if (!guide) return null
	return availableGuides.value.some((g) => g.id === guide.id) ? guide : null
})

const safeRect = computed(() => (activeGuide.value ? safeArea(activeGuide.value) : null))

/** Thirds or a centre crosshair, as absolutely-positioned hairlines. */
const gridLines = computed(() => {
	if (activeGuide.value?.kind !== 'grid') return []
	const fractions = activeGuide.value.id === 'centre' ? [0.5] : [1 / 3, 2 / 3]
	return fractions.flatMap((f) => [
		{ key: `v${f}`, style: { left: `${f * 100}%`, top: '0', width: '1px', height: '100%' } },
		{ key: `h${f}`, style: { top: `${f * 100}%`, left: '0', height: '1px', width: '100%' } }
	])
})

const chooseGuide = (id: string | null) => {
	store.activeGuideId = id
	guideMenuOpen.value = false
}

// ===== Timecode entry =====

/**
 * The playhead as text you can type into.
 *
 * A scrub bar cannot land on a frame, and "go to 1:23" is a thing people say.
 * The field shows the live playhead until it is focused, then holds whatever is
 * being typed so it does not fight the cursor.
 */
const editingTimecode = ref(false)
const timecodeDraft = ref('')

const timecodeText = computed(() =>
	editingTimecode.value ? timecodeDraft.value : format(store.playheadSec)
)

const onTimecodeFocus = (event: FocusEvent) => {
	editingTimecode.value = true
	timecodeDraft.value = format(store.playheadSec)
	requestAnimationFrame(() => (event.target as HTMLInputElement).select())
}

const onTimecodeCancel = (event: KeyboardEvent) => {
	editingTimecode.value = false
	;(event.target as HTMLInputElement).blur()
}

const onTimecodeCommit = (event: FocusEvent) => {
	const field = event.target as HTMLInputElement
	const seconds = parseTimecode(field.value)
	editingTimecode.value = false
	if (seconds !== null) store.seekTo(Math.max(0, Math.min(store.contentEnd, seconds)))
	// Written back by hand: when the entry is rejected the bound value is
	// unchanged from Vue's point of view, so it skips the patch and the field
	// keeps showing whatever nonsense was typed.
	requestAnimationFrame(() => { field.value = format(store.playheadSec) })
}

/** `1:23.4`, `83.4` or `1:02:03` — whatever someone actually types. */
function parseTimecode(text: string): number | null {
	const clean = text.trim().replace(',', '.')
	if (!clean) return null
	const parts = clean.split(':').map((p) => Number(p))
	if (parts.some((p) => !Number.isFinite(p))) return null
	if (parts.length === 1) return parts[0]
	if (parts.length === 2) return parts[0] * 60 + parts[1]
	if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
	return null
}

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
	// Exact, unlike the colour approximation above it: both this and the filter
	// chain are affine transforms of the same frame.
	const transform = transformCss(item?.transform, {
		tracks: item?.keyframes,
		t: item ? store.playheadSec - item.timelineStart : 0
	})
	const fit = item?.framing?.mode !== 'fill'
		? { objectFit: 'contain' as const }
		: { objectFit: 'cover' as const, objectPosition: panObjectPosition(item.framing.pan) }
	return {
		...fit,
		...(filter ? { filter } : {}),
		...(transform ? { transform } : {})
	}
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

// Moving the playhead is asking "what is here?", and the answer is the edit —
// so a scrub, a click on the ruler or a frame step brings the timeline forward.
// NOT while playing: the playhead advances on its own then, and it would drag
// the user back every time they deliberately went to look at the source.
watch(() => store.playheadSec, () => { if (!store.isPlaying) mode.value = 'timeline' })

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
