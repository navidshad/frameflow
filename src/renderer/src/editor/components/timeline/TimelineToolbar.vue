<template>
	<div class="px-3 py-1.5 flex items-center justify-between border-b border-zinc-200 dark:border-zinc-800 shrink-0 gap-2">
		<div class="flex items-center gap-2">
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Timeline</span>

			<!-- View toggle: Filmstrip / Context -->
			<div class="flex items-center bg-zinc-100/80 dark:bg-zinc-900/80 rounded-lg p-0.5 border border-zinc-200 dark:border-zinc-800">
				<button v-for="view in (['filmstrip', 'context'] as const)" :key="view"
					class="px-2 py-1 rounded-md text-[9px] font-bold uppercase tracking-widest transition flex items-center gap-1"
					:class="store.timelineView === view
						? 'bg-primary text-white shadow-md shadow-primary/20 ring-1 ring-primary/20'
						: 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'"
					@click="store.timelineView = view">
					<span :class="view === 'filmstrip' ? 'iconify tabler--photo' : 'iconify tabler--file-text'" class="w-3 h-3"></span>
					{{ view }}
				</button>
			</div>
		</div>

		<div class="flex items-center gap-1">
			<!-- Undo / Redo -->
			<ToolButton icon="tabler--arrow-back-up" title="Undo (⌘Z)" :disabled="!store.canUndo" @click="store.undo()" />
			<ToolButton icon="tabler--arrow-forward-up" title="Redo (⌘⇧Z)" :disabled="!store.canRedo" @click="store.redo()" />
			<div class="w-px h-4 bg-zinc-200 dark:bg-zinc-800 mx-1"></div>

			<!-- Edit tools -->
			<ToolButton icon="tabler--blade-filled" title="Split at playhead (S)" @click="store.splitAtPlayhead()" />
			<ToolButton icon="tabler--trash" title="Ripple delete selection (⌫)"
				:disabled="!store.selectedItemIds.length"
				@click="store.deleteItems(store.selectedItemIds)" />
			<ToolButton icon="tabler--magnet" :title="store.snapEnabled ? 'Snapping on' : 'Snapping off'"
				:active="store.snapEnabled" @click="store.snapEnabled = !store.snapEnabled" />
			<div class="w-px h-4 bg-zinc-200 dark:bg-zinc-800 mx-1"></div>

			<!-- Marker / chapter jump list (§5.3) -->
			<div class="relative">
				<ToolButton icon="tabler--bookmarks" title="Markers & chapters"
					:active="markersOpen" @click="markersOpen = !markersOpen" />
				<template v-if="markersOpen">
					<div class="fixed inset-0 z-20" @click="markersOpen = false"></div>
					<div class="absolute right-0 top-7 z-30 w-60 glass-card rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-lg py-1 max-h-52 overflow-y-auto custom-scrollbar">
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
			<div class="w-px h-4 bg-zinc-200 dark:bg-zinc-800 mx-1"></div>

			<!-- Zoom -->
			<ToolButton icon="tabler--zoom-out" title="Zoom out (−)" @click="viewport.zoomBy(0.8)" />
			<ToolButton icon="tabler--zoom-in" title="Zoom in (+)" @click="viewport.zoomBy(1.25)" />
			<ToolButton icon="tabler--arrows-horizontal" title="Fit timeline" @click="viewport.fitToWindow()" />
			<ToolButton icon="tabler--focus-2" title="Fit selection" :disabled="!store.selectedItemIds.length"
				@click="viewport.fitToSelection()" />
			<div class="w-px h-4 bg-zinc-200 dark:bg-zinc-800 mx-1"></div>

			<ToolButton icon="tabler--plus" title="Add overlay track" @click="store.addOverlayTrack()" />
			<ToolButton icon="tabler--bookmark-plus" title="Save revision checkpoint"
				@click="store.saveCheckpoint()" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { h, inject, ref } from 'vue'
import type { FunctionalComponent } from 'vue'
import { useEditorStore } from '../../../stores/editorStore'
import { TimelineViewportKey } from '../../composables/useTimelineViewport'

const store = useEditorStore()
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

const ToolButton: FunctionalComponent<
	{ icon: string; title: string; disabled?: boolean; active?: boolean },
	{ click: () => void }
> = (props, { emit }) =>
	h('button', {
		class: [
			'w-6 h-6 flex items-center justify-center rounded-lg transition active:scale-95',
			props.disabled
				? 'text-zinc-300 dark:text-zinc-700 cursor-not-allowed'
				: props.active
					? 'text-primary bg-primary/10'
					: 'text-zinc-500 hover:text-primary hover:bg-primary/10'
		],
		title: props.title,
		disabled: props.disabled,
		onClick: () => { if (!props.disabled) emit('click') }
	}, [h('span', { class: `iconify ${props.icon} w-3.5 h-3.5` })])
ToolButton.props = ['icon', 'title', 'disabled', 'active']
ToolButton.emits = ['click']
</script>
