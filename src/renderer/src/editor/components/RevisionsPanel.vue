<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<!-- Header. No "Revisions" label — ChatColumn already renders it as the tab,
		     and dropping the duplicate frees the room the mode toggle needs. -->
		<div class="px-3 pt-3 pb-2 flex items-center justify-between gap-2 shrink-0">
			<!-- Mode toggle -->
			<div class="flex bg-zinc-100 dark:bg-zinc-800/60 rounded-lg p-0.5"
				:class="{ 'opacity-50 pointer-events-none': isEmpty }">
				<button v-for="m in MODES" :key="m.value"
					class="px-2 py-1 rounded-md transition flex items-center justify-center"
					:class="mode === m.value
						? 'bg-white dark:bg-zinc-700 shadow-sm text-zinc-800 dark:text-white'
						: 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'"
					:title="m.title"
					@click="setMode(m.value)">
					<span class="iconify w-3.5 h-3.5" :class="m.icon"></span>
				</button>
			</div>

			<div class="flex items-center gap-1">
				<button v-if="mode === 'graph'"
					class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-500 hover:text-primary hover:bg-primary/10 transition active:scale-95"
					title="Expand the graph" :disabled="isEmpty"
					@click="showOverlay = true">
					<span class="iconify tabler--arrows-maximize w-4 h-4"></span>
				</button>
				<SaveRevisionButton />
			</div>
		</div>

		<!-- Body -->
		<div class="flex-1 min-h-0" :class="mode === 'list' ? 'overflow-y-auto custom-scrollbar px-2 pb-3' : ''">
			<!-- Empty state (shared by both modes) -->
			<div v-if="isEmpty"
				class="h-full flex flex-col items-center justify-center text-center gap-3 py-8 px-2">
				<div class="w-12 h-12 rounded-2xl bg-secondary/10 flex items-center justify-center text-secondary">
					<span class="iconify tabler--bookmark w-6 h-6"></span>
				</div>
				<p class="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed px-4">
					Save a revision or run an AI edit to start the tree. Every prompt result becomes a
					revision you can branch from.
				</p>
			</div>

			<template v-else>
				<template v-if="mode === 'list'">
					<RevisionListItem v-for="entry in flatTree" :key="entry.revision.id"
						:revision="entry.revision" :depth="entry.depth" />
				</template>
				<!-- v-if, not v-show: a hidden canvas warns about missing viewport
				     dimensions and keeps a resize observer alive for nothing. -->
				<RevisionGraph v-else-if="!showOverlay" compact />
			</template>
		</div>

		<RevisionGraphOverlay v-model="showOverlay" />
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { flattenTree } from '@shared/revision-tree'
import { useEditorStore } from '../../stores/editorStore'
import RevisionListItem from './RevisionListItem.vue'
import RevisionGraph from './RevisionGraph.vue'
import RevisionGraphOverlay from './RevisionGraphOverlay.vue'
import SaveRevisionButton from './SaveRevisionButton.vue'

type ViewMode = 'list' | 'graph'
type Preference = ViewMode | 'auto'

const PREF_KEY = 'editor.revisionsView'

const MODES: { value: ViewMode; icon: string; title: string }[] = [
	{ value: 'list', icon: 'tabler--list', title: 'List view' },
	{ value: 'graph', icon: 'tabler--sitemap', title: 'Graph view' }
]

const store = useEditorStore()
const showOverlay = ref(false)

const isEmpty = computed(() => store.revisions.length === 0)
const flatTree = computed(() => flattenTree(store.revisions))

/**
 * 'auto' resolves ONCE at mount, not in a live computed — otherwise the panel
 * would flip out from under someone the moment an AI edit branches the tree.
 * ChatColumn mounts this with v-if, so every return to the tab re-resolves.
 * An explicit choice is never overridden.
 */
const readPreference = (): Preference => {
	const stored = localStorage.getItem(PREF_KEY)
	return stored === 'list' || stored === 'graph' ? stored : 'auto'
}

const mode = ref<ViewMode>('list')

onMounted(() => {
	const pref = readPreference()
	mode.value = pref === 'auto' ? (store.revisionHasBranch ? 'graph' : 'list') : pref
})

const setMode = (next: ViewMode) => {
	mode.value = next
	localStorage.setItem(PREF_KEY, next)
}
</script>
