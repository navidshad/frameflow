<template>
	<div v-if="visibleRenders.length" class="flex flex-col items-end gap-2">
		<div v-for="entry in visibleRenders" :key="entry.threadId"
			class="flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-xl border shadow-lg backdrop-blur-md bg-zinc-100/80 dark:bg-zinc-900/80 animate-fade-in-up"
			:class="entry.phase === 'error'
				? 'border-red-300/60 dark:border-red-900/60'
				: 'border-zinc-200/60 dark:border-zinc-800/60'">
			<!-- Status icon -->
			<span v-if="isActive(entry)" class="iconify tabler--loader-2 w-3.5 h-3.5 animate-spin text-primary shrink-0"></span>
			<span v-else-if="entry.phase === 'done'" class="iconify tabler--check w-3.5 h-3.5 text-accent shrink-0"></span>
			<span v-else class="iconify tabler--alert-triangle w-3.5 h-3.5 text-red-500 shrink-0"></span>

			<!-- Label: click jumps back to the exporting project -->
			<button class="flex items-baseline gap-1.5 min-w-0 hover:opacity-80 transition"
				:title="isActive(entry) ? 'Open the exporting project' : (entry.error || 'Open project')"
				@click="router.push(`/editor/${entry.threadId}`)">
				<span class="text-[11px] font-bold text-zinc-700 dark:text-zinc-200 truncate max-w-[140px]">
					{{ entry.title }}
				</span>
				<span v-if="isActive(entry)" class="text-[10px] font-mono text-zinc-500">{{ entry.percent }}%</span>
				<span v-else-if="entry.phase === 'done'" class="text-[10px] font-medium text-accent">exported</span>
				<span v-else class="text-[10px] font-medium text-red-500">failed</span>
			</button>

			<!-- Done: open the exports folder -->
			<button v-if="entry.phase === 'done'"
				class="px-1.5 py-0.5 rounded-md text-[10px] font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/70 transition active:scale-95"
				@click="openFolder(entry.threadId)">
				Open folder
			</button>

			<!-- Dismiss (finished/errored only — an active render keeps its pill) -->
			<button v-if="!isActive(entry)"
				class="w-5 h-5 flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-800/70 transition"
				title="Dismiss"
				@click="store.clearRenderState(entry.threadId)">
				<span class="iconify tabler--x w-3 h-3"></span>
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useEditorStore } from '../stores/editorStore'

/**
 * Floating background-export pills (visible on ANY page): renders run in the
 * main process off an in-memory snapshot, so the user can leave the project.
 * A pill is suppressed while its own editor page is open — the page's header
 * button and export dialog already show that render's progress.
 */
const store = useEditorStore()
const route = useRoute()
const router = useRouter()

const isActive = (e: { phase: string }) => e.phase === 'rendering' || e.phase === 'stitching'

const visibleRenders = computed(() =>
	store.backgroundRenders.filter(
		(e) => !(route.path === `/editor/${e.threadId}`)
	)
)

const openFolder = (threadId: string) => {
	;(window as any).api.openThreadDir(threadId)
}
</script>
