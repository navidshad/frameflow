<template>
	<div v-if="bulk" class="mb-2 p-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-900/50" data-testid="bulk-import">
		<!-- Reading the selection, or importing it -->
		<template v-if="bulk.phase !== 'done'">
			<div class="flex items-center justify-between gap-2">
				<p class="text-xs font-medium text-zinc-600 dark:text-zinc-300 truncate">{{ title }}</p>
				<button v-if="bulk.phase === 'importing'"
					class="text-[10px] font-bold uppercase tracking-wide text-zinc-400 hover:text-red-500 transition"
					@click="editorStore.stopBulkImport()">Stop</button>
			</div>
			<div class="mt-2 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
				<div class="h-full rounded-full bg-primary transition-all duration-300"
					:class="{ 'animate-pulse w-full': !bulk.progress }"
					:style="bulk.progress ? { width: `${percent}%` } : undefined"></div>
			</div>
			<p class="mt-1 text-[10px] font-mono text-zinc-400 truncate">{{ detail }}</p>
		</template>

		<!-- The result: what came in, what failed, what was left out -->
		<template v-else-if="bulk.report">
			<div class="flex items-start justify-between gap-2">
				<p class="text-xs font-medium text-zinc-700 dark:text-zinc-200">{{ summary }}</p>
				<button class="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition shrink-0" title="Dismiss"
					@click="editorStore.dismissBulkImport()">
					<span class="iconify tabler--x w-3.5 h-3.5"></span>
				</button>
			</div>
			<ul v-if="bulk.report.failed.length" class="mt-2 space-y-1">
				<li v-for="f in bulk.report.failed" :key="f.path" class="text-[11px] leading-snug">
					<span class="font-medium text-red-500">{{ f.name }}</span>
					<span class="text-zinc-500 dark:text-zinc-400"> — {{ f.error }}</span>
				</li>
			</ul>
			<p v-if="bulk.report.stopped" class="mt-1 text-[10px] text-amber-500">Stopped before the end of the list.</p>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { describeBatch, describeSkipped } from '@shared/mediaFiles'
import { useEditorStore } from '../../stores/editorStore'

const editorStore = useEditorStore()
const bulk = computed(() => editorStore.bulkImport)

const percent = computed(() => {
	const p = bulk.value?.progress
	return p && p.total ? Math.round((p.done / p.total) * 100) : 0
})
const title = computed(() => {
	const p = bulk.value?.progress
	if (!p) return 'Reading what you chose…'
	return `Importing ${Math.min(p.done + 1, p.total)} of ${p.total}`
})
const detail = computed(() => bulk.value?.progress?.current ?? (bulk.value?.progress ? 'Finishing…' : ''))

const summary = computed(() => {
	const r = bulk.value?.report
	if (!r) return ''
	if (!r.imported && !r.failed.length) return ['No video or audio found', describeSkipped(r.skipped)].filter(Boolean).join(' · ')
	return describeBatch(r)
})
</script>
