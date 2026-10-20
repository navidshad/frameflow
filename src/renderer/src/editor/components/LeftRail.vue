<template>
	<div class="relative flex min-h-0 gap-1.5 flex-1 min-w-0">
		<!-- The rail. Icons rather than words: four tabs fit as text, the next
		     two would not, and a rail costs no vertical space in the panel. -->
		<div class="shrink-0 flex flex-col items-center gap-0.5 py-1">
			<SlimTooltip v-for="t in TABS" :key="t.value" :text="t.label" placement="right">
				<button
					class="w-8 h-8 flex items-center justify-center rounded-lg transition active:scale-95"
					:class="tab === t.value && !collapsed
						? 'text-primary bg-primary/10'
						: 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-500/10'"
					:aria-label="t.label"
					:aria-pressed="tab === t.value && !collapsed"
					@click="pick(t.value)">
					<span class="iconify w-4 h-4" :class="t.icon"></span>
				</button>
			</SlimTooltip>
		</div>

		<!-- Media keeps its state across a tab switch (`v-show`); the others are
		     cheap to rebuild and mount on demand, the split ChatColumn makes. -->
		<template v-if="!collapsed">
			<MediaPanel v-show="tab === 'media'" class="flex-1 min-h-0 min-w-0"
				:collapsed="collapsed" @update:collapsed="$emit('update:collapsed', $event)" />
			<MotionPanel v-if="tab === 'motion'" class="flex-1 min-h-0 min-w-0"
				:collapsed="collapsed" @update:collapsed="$emit('update:collapsed', $event)" />
			<LibraryPanel v-if="tab === 'transitions'" class="flex-1 min-h-0 min-w-0"
				:collapsed="collapsed" @update:collapsed="$emit('update:collapsed', $event)" />
			<EffectsPanel v-if="tab === 'effects'" class="flex-1 min-h-0 min-w-0"
				:collapsed="collapsed" @update:collapsed="$emit('update:collapsed', $event)" />
			<TranscriptPanel v-if="tab === 'words'" class="flex-1 min-h-0 min-w-0"
				:collapsed="collapsed" @update:collapsed="$emit('update:collapsed', $event)" />
		</template>
	</div>
</template>

<script setup lang="ts">
import MediaPanel from './MediaPanel.vue'
import LibraryPanel from './LibraryPanel.vue'
import MotionPanel from './MotionPanel.vue'
import EffectsPanel from './EffectsPanel.vue'
import TranscriptPanel from './TranscriptPanel.vue'
import SlimTooltip from '../../components/SlimTooltip.vue'

/**
 * The left rail's tab host.
 *
 * The rail stays visible when the panel is collapsed, so a collapsed sidebar is
 * still a row of things you can click rather than a stub that only reopens what
 * you last had. Clicking the active tab collapses; clicking another opens that
 * one — the behaviour of every editor with a rail like this.
 *
 * Collapse and resize stay with VideoEditorPage; this only routes the event.
 */
export type LeftTab = 'media' | 'motion' | 'transitions' | 'effects' | 'words'

const TABS: { value: LeftTab; label: string; icon: string }[] = [
	{ value: 'media', label: 'Media', icon: 'tabler--folder' },
	{ value: 'motion', label: 'Motion', icon: 'tabler--sparkles' },
	{ value: 'transitions', label: 'Transitions', icon: 'tabler--transition-right' },
	{ value: 'effects', label: 'Effects', icon: 'tabler--wand' },
	{ value: 'words', label: 'Words', icon: 'tabler--text-caption' }
]

const props = defineProps<{ tab: LeftTab; collapsed?: boolean }>()
const emit = defineEmits<{
	(e: 'update:tab', tab: LeftTab): void
	(e: 'update:collapsed', value: boolean): void
}>()

const pick = (value: LeftTab) => {
	if (props.collapsed) {
		emit('update:tab', value)
		emit('update:collapsed', false)
		return
	}
	// The active tab is a toggle, so the rail can close the panel as well as
	// switch it — otherwise the only way back is the collapse chevron inside
	// the panel that just went away.
	if (value === props.tab) emit('update:collapsed', true)
	else emit('update:tab', value)
}
</script>
