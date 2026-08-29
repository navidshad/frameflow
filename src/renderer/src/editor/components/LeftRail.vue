<template>
	<div class="relative flex flex-col min-h-0 gap-1.5 flex-1 min-w-0">
		<div class="flex items-center gap-0.5 px-1 shrink-0">
			<button v-for="t in TABS" :key="t.value"
				class="px-2 py-1 rounded-lg text-[9px] font-bold uppercase tracking-widest transition"
				:class="tab === t.value
					? 'text-primary bg-primary/10'
					: 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'"
				@click="$emit('update:tab', t.value)">
				{{ t.label }}
			</button>
		</div>
		<MediaPanel v-show="tab === 'media'" class="flex-1 min-h-0"
			:collapsed="collapsed" @update:collapsed="$emit('update:collapsed', $event)" />
		<LibraryPanel v-if="tab === 'transitions'" class="flex-1 min-h-0"
			:collapsed="collapsed" @update:collapsed="$emit('update:collapsed', $event)" />
		<EffectsPanel v-if="tab === 'effects'" class="flex-1 min-h-0"
			:collapsed="collapsed" @update:collapsed="$emit('update:collapsed', $event)" />
		<TranscriptPanel v-if="tab === 'words'" class="flex-1 min-h-0"
			:collapsed="collapsed" @update:collapsed="$emit('update:collapsed', $event)" />
	</div>
</template>

<script setup lang="ts">
import MediaPanel from './MediaPanel.vue'
import LibraryPanel from './LibraryPanel.vue'
import EffectsPanel from './EffectsPanel.vue'
import TranscriptPanel from './TranscriptPanel.vue'

/**
 * The left rail's tab host, mirroring ChatColumn. Media keeps its state across
 * a tab switch (`v-show`), while the preset library is cheap to rebuild and is
 * mounted on demand — the same split ChatColumn makes between chat and revisions.
 *
 * Collapse and resize stay with VideoEditorPage; this only routes the event.
 */
export type LeftTab = 'media' | 'transitions' | 'effects' | 'words'

const TABS: { value: LeftTab; label: string }[] = [
	{ value: 'media', label: 'media' },
	{ value: 'transitions', label: 'transitions' },
	{ value: 'effects', label: 'effects' },
	{ value: 'words', label: 'words' }
]

defineProps<{ tab: LeftTab; collapsed?: boolean }>()
defineEmits<{
	(e: 'update:tab', tab: LeftTab): void
	(e: 'update:collapsed', value: boolean): void
}>()
</script>
