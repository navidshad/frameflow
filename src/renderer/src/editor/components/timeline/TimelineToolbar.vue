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

			<!-- Zoom -->
			<ToolButton icon="tabler--zoom-out" title="Zoom out (−)" @click="viewport.zoomBy(0.8)" />
			<ToolButton icon="tabler--zoom-in" title="Zoom in (+)" @click="viewport.zoomBy(1.25)" />
			<ToolButton icon="tabler--arrows-horizontal" title="Fit timeline" @click="viewport.fitToWindow()" />
			<ToolButton icon="tabler--focus-2" title="Fit selection" :disabled="!store.selectedItemIds.length"
				@click="viewport.fitToSelection()" />
			<div class="w-px h-4 bg-zinc-200 dark:bg-zinc-800 mx-1"></div>

			<ToolButton icon="tabler--plus" title="Add overlay track" @click="store.addOverlayTrack()" />
		</div>
	</div>
</template>

<script setup lang="ts">
import { h, inject } from 'vue'
import type { FunctionalComponent } from 'vue'
import { useEditorStore } from '../../../stores/editorStore'
import { TimelineViewportKey } from '../../composables/useTimelineViewport'

const store = useEditorStore()
const viewport = inject(TimelineViewportKey)!

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
