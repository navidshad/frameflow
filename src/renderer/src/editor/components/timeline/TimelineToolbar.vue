<template>
	<div class="h-9 px-2.5 flex items-center justify-between hair-b shrink-0 gap-2">
		<div class="flex items-center gap-2 shrink-0">
			<span class="lbl !text-zinc-900 dark:!text-zinc-50 mr-2">Timeline</span>

			<!-- View: Filmstrip / Context, as underline tabs -->
			<button v-for="view in (['filmstrip', 'context'] as const)" :key="view"
				:title="`${view} view`"
				class="tab-u !h-9 !text-[11px] uppercase tracking-[.08em] mr-3"
				:class="{ 'tab-u-active': store.timelineView === view }"
				@click="store.timelineView = view">
				{{ view }}
			</button>

			<!-- Keyframes (board 2): step between keys, add one at the playhead on
			     the lane being worked on, and how many are selected. Play and the
			     frame steps are under the picture now. -->
			<template v-if="kf.expanded">
				<div class="w-px h-4 bg-hair mx-0.5"></div>
				<ToolButton icon="tabler--chevron-left" title="Previous keyframe"
					:disabled="!kf.canStep(-1)" @click="kf.step(-1)" />
				<ToolButton icon="tabler--diamond" tint="key"
					:title="kf.primary ? `Add a ${kf.primaryLane?.label.toLowerCase()} key at the playhead` : 'Add keyframe at playhead — pick a lane’s key first, or use a lane’s ◆'"
					:disabled="!kf.primary" @click="kf.addAtPlayhead()" />
				<ToolButton icon="tabler--chevron-right" title="Next keyframe"
					:disabled="!kf.canStep(1)" @click="kf.step(1)" />
				<span v-if="kf.selection.length" class="text-[11px] text-zinc-500 whitespace-nowrap">
					{{ kf.selection.length }} key{{ kf.selection.length === 1 ? '' : 's' }} selected
				</span>
			</template>
		</div>

		<!-- A narrow window scrolls the tools sideways rather than overlapping the labels. -->
		<div class="flex items-center gap-1 min-w-0 overflow-x-auto no-scrollbar">
			<!-- Keyframe lanes. Lit while open — and while closed, when the
			     selected clip has keys to show (board 1). -->
			<SlimTooltip :text="kf.open ? 'Hide keyframe lanes' : 'Show keyframe lanes — every animatable property of the selected clip, under its track'" placement="top">
				<button class="h-6 px-2 flex items-center gap-1 rounded-lg text-[9px] font-bold uppercase tracking-widest transition active:scale-95 mr-1"
					:class="kf.open || kf.itemHasKeys
						? 'text-primary bg-primary/10'
						: 'text-zinc-500 hover:text-primary hover:bg-primary/10'"
					:aria-label="kf.open ? 'Hide keyframe lanes' : 'Show keyframe lanes'"
					:aria-pressed="kf.open"
					@click="kf.toggle()">
					<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
						stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 9-9 9-9-9z" /></svg>
					Keyframes
				</button>
			</SlimTooltip>
			<!-- Legend for the dashed outlines an MCP agent's latest edit leaves -->
			<span v-if="store.agentMarksSeq !== null && Object.keys(store.agentMarks).length"
				class="flex items-center gap-1.5 text-[11px] text-violet-400 mr-2 whitespace-nowrap">
				<span class="w-3.5 h-2.5 rounded-[3px] outline outline-1 outline-dashed outline-[rgba(167,139,250,0.9)]"></span>
				changed by the agent in V{{ store.agentMarksSeq }}
			</span>
			<!-- Undo / Redo -->
			<ToolButton icon="tabler--arrow-back-up" :title="`Undo (${keysFor('undo')})`" :disabled="!store.canUndo" @click="store.undo()" />
			<ToolButton icon="tabler--arrow-forward-up" :title="`Redo (${keysFor('redo')})`" :disabled="!store.canRedo" @click="store.redo()" />
			<div class="w-px h-4 bg-hair mx-1"></div>

			<!-- Edit tools -->
			<ToolButton icon="tabler--blade-filled" :title="`Split at the playhead (${keysFor('split')})`" @click="store.splitAtPlayhead()" />
			<ToolButton icon="tabler--trash" :title="`Ripple delete the selection (${keysFor('delete')})`"
				:disabled="!store.selectedItemIds.length"
				@click="store.deleteItems(store.selectedItemIds)" />
			<ToolButton icon="tabler--arrows-join" title="Close gaps — pull every clip left so the timeline runs back to back"
				:disabled="!store.hasGaps" @click="store.closeGaps()" />
			<ToolButton icon="tabler--copy"
				:title="`Duplicate the selection (${keysFor('duplicate')})`"
				:disabled="!store.selectedItemIds.length"
				@click="store.duplicateItems()" />
			<ToolButton icon="tabler--magnet"
				:title="`${store.snapEnabled ? 'Snapping on' : 'Snapping off'} (${keysFor('snapping')})`"
				:active="store.snapEnabled" @click="store.snapEnabled = !store.snapEnabled" />
			<ToolButton icon="tabler--badge-cc" :disabled="!store.hasTranscript"
				:title="!store.hasTranscript
					? 'Captions — transcribe a clip first'
					: store.captionsEnabled
						? 'Captions on — burned into the export'
						: 'Captions off'"
				:active="store.captionsEnabled"
				@click="store.setCaptionsEnabled(!store.captionsEnabled)" />
			<ToolButton icon="tabler--wave-sine"
				:title="store.loudnessEnabled
					? 'Loudness on — the mix is normalised to -14 LUFS on export'
					: 'Loudness off — the export keeps whatever level the sources had'"
				:active="store.loudnessEnabled"
				@click="store.setLoudnessEnabled(!store.loudnessEnabled)" />
			<div class="w-px h-4 bg-hair mx-1"></div>

			<!-- Marker / chapter jump list (§5.3) -->
			<div class="relative">
				<ToolButton icon="tabler--bookmarks" title="Markers & chapters"
					:active="markersOpen" @click="markersOpen = !markersOpen" />
				<template v-if="markersOpen">
					<div class="fixed inset-0 z-40" @click="markersOpen = false"></div>
					<div class="absolute right-0 top-8 z-50 w-60 pop py-1 max-h-52 overflow-y-auto custom-scrollbar origin-top animate-menu">
						<p v-if="!store.markers.length" class="px-3 py-2 text-[11px] text-zinc-400">
							No markers yet — press <span class="font-mono font-bold">M</span> at the playhead to add one.
						</p>
						<div v-for="m in store.markers" :key="m.id"
							class="flex items-center gap-1 px-1.5 group">
							<button
								class="flex-1 flex items-center justify-between gap-2 px-1.5 py-1.5 rounded-lg text-left hover:bg-primary/10 transition min-w-0"
								@click="jumpToMarker(m.time)">
								<span class="text-[11px] text-zinc-700 dark:text-zinc-200 truncate">
									{{ m.label || 'Marker' }}
								</span>
								<span class="font-mono text-[10px] text-zinc-400 shrink-0">{{ formatTime(m.time) }}</span>
							</button>
							<button title="Remove marker"
								class="p-1 rounded-md text-zinc-300 dark:text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-500 transition"
								@click="store.removeMarker(m.id)">
								<span class="iconify tabler--x w-3 h-3 block"></span>
							</button>
						</div>
					</div>
				</template>
			</div>
			<div class="w-px h-4 bg-hair mx-1"></div>

			<!-- Zoom -->
			<ToolButton icon="tabler--zoom-out" title="Zoom out (−)" @click="viewport.zoomBy(0.8)" />
			<ToolButton icon="tabler--zoom-in" title="Zoom in (+)" @click="viewport.zoomBy(1.25)" />
			<ToolButton icon="tabler--arrows-horizontal" title="Fit timeline" @click="viewport.fitToWindow()" />
			<ToolButton icon="tabler--focus-2" title="Fit selection" :disabled="!store.selectedItemIds.length"
				@click="viewport.fitToSelection()" />
			<div class="w-px h-4 bg-hair mx-1"></div>

			<ToolButton icon="tabler--typography" title="Add a title at the playhead"
				@click="store.addTitle()" />
			<ToolButton icon="tabler--sparkles" tint="motion" title="Add a motion layer at the playhead — a lower third; the Motion tab has the rest"
				@click="store.addMotionLayer('lower-third')" />
			<ToolButton icon="tabler--color-swatch"
				title="Add a generated background at the playhead — something for a keyed layer to sit in front of"
				@click="store.addGeneratedLayer()" />
			<ToolButton icon="tabler--movie" title="Add a video track — anything you can see, and the upper lanes render in front"
				@click="store.addVideoTrack()" />
			<ToolButton icon="tabler--music" title="Add an audio track — anything you can hear"
				@click="store.addAudioTrack()" />
			<ToolButton icon="tabler--bookmark-plus" title="Save revision checkpoint"
				@click="store.saveCheckpoint()" />
			<div class="w-px h-4 bg-hair mx-1"></div>
			<ToolButton icon="tabler--keyboard" :title="`Keyboard shortcuts (${keysFor('help')})`"
				:active="store.shortcutsOpen" @click="store.shortcutsOpen = !store.shortcutsOpen" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { h, inject, ref } from 'vue'
import type { FunctionalComponent } from 'vue'
import { useEditorStore } from '../../../stores/editorStore'
import { useKeyframeLanesStore } from '../../../stores/keyframeLanesStore'
import { TimelineViewportKey } from '../../composables/useTimelineViewport'
import { keysFor } from '../../shortcuts'
import SlimTooltip from '../../../components/SlimTooltip.vue'

const store = useEditorStore()
const kf = useKeyframeLanesStore()
const viewport = inject(TimelineViewportKey)!

const markersOpen = ref(false)

const jumpToMarker = (time: number) => {
	store.seekTo(time)
	viewport.scrollToTime(time)
	markersOpen.value = false
}

const formatTime = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * A toolbar icon in a STYLED tooltip. Native `title` tooltips take a second to
 * appear and are easy to miss entirely, which made a toolbar of bare icons
 * read as unlabelled — the tooltips existed, nobody saw them. SlimTooltip is
 * what every panel already uses.
 */
const ToolButton: FunctionalComponent<
	{ icon: string; title: string; disabled?: boolean; active?: boolean; tint?: 'motion' | 'key' },
	{ click: () => void }
> = (props, { emit }) =>
	h(SlimTooltip, { text: props.title, placement: 'top' }, {
		default: () => h('button', {
			class: [
				'w-[26px] h-7 flex items-center justify-center rounded-md transition active:scale-95',
				props.disabled
					? 'text-zinc-300 dark:text-zinc-700 cursor-not-allowed'
					: props.active
						? 'text-primary bg-primary/10'
						: props.tint === 'key'
							? 'text-blue-400 hover:bg-primary/10'
							: props.tint === 'motion'
							? 'text-pink-500 hover:bg-pink-500/10'
							: 'text-zinc-500 hover:text-primary hover:bg-primary/10'
			],
			'aria-label': props.title,
			disabled: props.disabled,
			onClick: () => { if (!props.disabled) emit('click') }
		}, [h('span', { class: `iconify ${props.icon} w-3.5 h-3.5` })])
	})
ToolButton.props = ['icon', 'title', 'disabled', 'active', 'tint']
ToolButton.emits = ['click']
</script>
