<template>
	<div class="relative flex min-h-0 shrink-0">
		<!-- The rail: always there, even when the panel is collapsed, so a
		     collapsed sidebar is still a row of things you can click rather
		     than a stub that only reopens whatever you last had. -->
		<nav aria-label="Panels" class="w-11 shrink-0 hair-r flex flex-col items-center gap-0.5 pt-2">
			<SlimTooltip v-for="t in TABS" :key="t.value" :text="t.label" placement="right">
				<button
					class="w-8 h-8 flex items-center justify-center rounded-md transition active:scale-95"
					:class="isActive(t.value)
						? 'text-primary bg-primary/10'
						: 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-500/10'"
					:aria-label="t.label"
					:aria-pressed="isActive(t.value)"
					@click="pick(t.value)">
					<span class="iconify w-4 h-4" :class="t.icon"></span>
				</button>
			</SlimTooltip>
			<div class="flex-1"></div>
			<SlimTooltip text="Keyboard shortcuts" placement="right">
				<button
					class="w-8 h-8 mb-1.5 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-500/10 transition"
					aria-label="Keyboard shortcuts" @click="editor.shortcutsOpen = !editor.shortcutsOpen">
					<span class="iconify tabler--keyboard w-4 h-4"></span>
				</button>
			</SlimTooltip>
		</nav>

		<!-- The panel: the library you picked, or Inspect for what is selected. -->
		<section v-if="!collapsed" class="hair-r flex flex-col min-h-0 min-w-0" :style="{ width: `${width}px` }">
			<div class="h-9 shrink-0 hair-b flex items-end gap-3.5 px-3">
				<button class="tab-u" :class="{ 'tab-u-active': mode === 'library' }"
					@click="$emit('update:mode', 'library')">{{ libraryLabel }}</button>
				<button class="tab-u flex items-center gap-1.5" :class="{ 'tab-u-active': mode === 'inspect' }"
					@click="$emit('update:mode', 'inspect')">
					Inspect
					<span v-if="selectionDot" class="w-1.5 h-1.5 rounded-full bg-accent-light"></span>
				</button>
				<div class="flex-1"></div>
				<SlimTooltip v-if="mode === 'inspect'"
					:text="pinned ? 'Pinned: selecting a clip will not switch to Inspect' : 'Pin Inspect: stop it taking focus when you select a clip'"
					placement="bottom">
					<button class="w-6 h-[34px] flex items-center justify-center transition"
						:class="pinned ? 'text-primary' : 'text-zinc-400 hover:text-primary'"
						:aria-pressed="pinned" aria-label="Pin Inspect"
						@click="$emit('update:pinned', !pinned)">
						<span class="iconify w-3.5 h-3.5" :class="pinned ? 'tabler--pinned-filled' : 'tabler--pin'"></span>
					</button>
				</SlimTooltip>
				<SlimTooltip text="Collapse panel" placement="bottom">
					<button class="w-6 h-[34px] flex items-center justify-center text-zinc-400 hover:text-primary transition"
						aria-label="Collapse panel" @click="$emit('update:collapsed', true)">
						<span class="iconify tabler--layout-sidebar-left-collapse w-3.5 h-3.5"></span>
					</button>
				</SlimTooltip>
			</div>

			<!-- Media keeps its state across a tab switch (`v-show`); the rest are
			     cheap to rebuild and mount on demand. -->
			<div v-show="mode === 'library'" class="flex-1 min-h-0 flex flex-col">
				<MediaPanel v-show="tab === 'media'" class="flex-1 min-h-0 min-w-0" />
				<MotionPanel v-if="tab === 'motion'" class="flex-1 min-h-0 min-w-0" />
				<LibraryPanel v-if="tab === 'transitions'" class="flex-1 min-h-0 min-w-0" />
				<EffectsPanel v-if="tab === 'effects'" class="flex-1 min-h-0 min-w-0" />
				<TranscriptPanel v-if="tab === 'words'" class="flex-1 min-h-0 min-w-0" />
				<SoundPanel v-if="tab === 'sound'" class="flex-1 min-h-0 min-w-0" />
			</div>
			<InspectorPanel v-if="mode === 'inspect'" class="flex-1 min-h-0 min-w-0" />
		</section>

		<slot name="resize" />
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import MediaPanel from './MediaPanel.vue'
import LibraryPanel from './LibraryPanel.vue'
import MotionPanel from './MotionPanel.vue'
import EffectsPanel from './EffectsPanel.vue'
import TranscriptPanel from './TranscriptPanel.vue'
import SoundPanel from './SoundPanel.vue'
import InspectorPanel from './InspectorPanel.vue'
import SlimTooltip from '../../components/SlimTooltip.vue'

/**
 * The left side of the editor: a slim rail of libraries, and one panel whose
 * second tab is Inspect. Selecting something on the timeline brings Inspect
 * forward (VideoEditorPage decides when); pinning stops that.
 *
 * Collapse and resize stay with VideoEditorPage; this only routes the events.
 */
export type LeftTab = 'media' | 'motion' | 'transitions' | 'effects' | 'words' | 'sound'
export type LeftMode = 'library' | 'inspect'

const TABS: { value: LeftTab; label: string; icon: string }[] = [
	{ value: 'media', label: 'Media', icon: 'tabler--folder' },
	{ value: 'motion', label: 'Motion', icon: 'tabler--sparkles' },
	{ value: 'transitions', label: 'Transitions', icon: 'tabler--transition-right' },
	{ value: 'effects', label: 'Effects', icon: 'tabler--wand' },
	{ value: 'words', label: 'Words', icon: 'tabler--text-caption' },
	{ value: 'sound', label: 'Sound', icon: 'tabler--wave-square' }
]

const props = defineProps<{
	tab: LeftTab
	mode: LeftMode
	collapsed: boolean
	pinned: boolean
	width: number
	/** Something is selected on the timeline: dot the Inspect tab. */
	selectionDot?: boolean
}>()
const emit = defineEmits<{
	(e: 'update:tab', tab: LeftTab): void
	(e: 'update:mode', mode: LeftMode): void
	(e: 'update:collapsed', value: boolean): void
	(e: 'update:pinned', value: boolean): void
}>()

const editor = useEditorStore()

const libraryLabel = computed(() => TABS.find((t) => t.value === props.tab)?.label ?? 'Media')
const isActive = (value: LeftTab) => !props.collapsed && props.mode === 'library' && props.tab === value

/**
 * A rail icon opens its library. Clicking the one that is already showing
 * collapses the panel — the behaviour of every editor with a rail like this —
 * but only when it is the library on screen: from Inspect it brings the
 * library back instead.
 */
const pick = (value: LeftTab) => {
	if (props.collapsed) {
		emit('update:tab', value)
		emit('update:mode', 'library')
		emit('update:collapsed', false)
		return
	}
	if (props.mode === 'inspect') {
		emit('update:tab', value)
		emit('update:mode', 'library')
		return
	}
	if (value === props.tab) emit('update:collapsed', true)
	else emit('update:tab', value)
}
</script>
