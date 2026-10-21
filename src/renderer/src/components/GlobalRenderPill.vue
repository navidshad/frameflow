<template>
	<div v-if="shown.length" class="flex items-center gap-4 min-w-0">
		<div v-for="entry in shown" :key="entry.threadId" class="flex items-center gap-2 min-w-0 text-[11px]">
			<!-- Status -->
			<span v-if="isActive(entry)" class="iconify tabler--loader-2 w-3.5 h-3.5 animate-spin text-primary shrink-0"></span>
			<span v-else-if="entry.phase === 'done'" class="iconify tabler--check w-3.5 h-3.5 text-accent shrink-0"></span>
			<span v-else class="iconify tabler--alert-triangle w-3.5 h-3.5 text-red-500 shrink-0"></span>

			<!-- Click jumps back to the exporting project -->
			<button class="flex items-baseline gap-2 min-w-0 transition-opacity hover:opacity-80"
				:title="isActive(entry) ? 'Open the exporting project' : (entry.error || 'Open project')"
				@click="router.push(`/editor/${entry.threadId}`)">
				<span v-if="isActive(entry)" class="font-mono tabular-nums text-primary">{{ entry.percent }}%</span>
				<span v-else-if="entry.phase === 'done'" class="text-accent">exported</span>
				<span v-else class="text-red-500">failed</span>
				<span class="truncate max-w-[150px] text-zinc-600 dark:text-zinc-300">{{ entry.title }}</span>
				<span v-if="isActive(entry)" class="hidden xl:inline font-semibold text-primary whitespace-nowrap">Exporting in background</span>
			</button>

			<button v-if="entry.phase === 'done'" class="font-semibold text-primary hover:text-primary-dark whitespace-nowrap transition-colors"
				@click="openFolder(entry.threadId)">Open folder</button>

			<!-- Dismiss (finished/errored only: an active render keeps its row) -->
			<button v-if="!isActive(entry)" class="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
				title="Dismiss" aria-label="Dismiss" @click="store.clearRenderState(entry.threadId)">
				<span class="iconify tabler--x w-3 h-3"></span>
			</button>
		</div>
		<span v-if="hiddenCount > 0" class="text-[11px] text-zinc-500 whitespace-nowrap">+{{ hiddenCount }} more</span>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useEditorStore } from '../stores/editorStore'

/**
 * Background exports, as a compact row in the top bar of every page: renders
 * run in the main process off an in-memory snapshot, so the user can leave the
 * project. A row is hidden while its own editor page is open — that page's
 * Export button and dialog already show this render's progress.
 */
const MAX_SHOWN = 2

const store = useEditorStore()
const route = useRoute()
const router = useRouter()

const isActive = (e: { phase: string }) => e.phase === 'rendering' || e.phase === 'stitching'

const visibleRenders = computed(() =>
	store.backgroundRenders.filter((e) => route.path !== `/editor/${e.threadId}`)
)
const shown = computed(() => visibleRenders.value.slice(0, MAX_SHOWN))
const hiddenCount = computed(() => Math.max(0, visibleRenders.value.length - MAX_SHOWN))

const openFolder = (threadId: string) => {
	;(window as any).api.openThreadDir(threadId)
}
</script>
