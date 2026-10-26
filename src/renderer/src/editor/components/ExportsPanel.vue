<template>
	<div class="flex flex-col min-h-0 overflow-hidden">
		<!-- Header: what is here, and the folder it all lives in. -->
		<div class="px-3.5 pt-3 pb-2 flex items-center justify-between gap-2 shrink-0">
			<span class="lbl">{{ headline }}</span>
			<SlimTooltip text="Open the exports folder" placement="bottom">
				<button class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-500 hover:text-primary hover:bg-primary/10 transition active:scale-95"
					aria-label="Open the exports folder" @click="openFolder">
					<span class="iconify tabler--folder w-4 h-4"></span>
				</button>
			</SlimTooltip>
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-3">
			<!-- An export in flight sits on top, so "where is it?" has an answer
			     before the file exists. -->
			<div v-if="store.isRendering && store.renderState"
				class="mx-1 mb-2 px-2.5 py-2 rounded-xl bg-primary/5 dark:bg-primary/10 ring-1 ring-primary/25">
				<div class="flex items-center gap-2 text-[11px] font-medium text-zinc-700 dark:text-zinc-300">
					<span class="iconify tabler--loader-2 w-3.5 h-3.5 text-primary animate-spin"></span>
					<span class="flex-1">Exporting…</span>
					<span class="font-mono tabular-nums text-zinc-500 dark:text-zinc-400">{{ store.renderState.percent }}%</span>
				</div>
				<div class="h-[3px] mt-2 bg-zinc-200 dark:bg-white/10 overflow-hidden rounded-full">
					<div class="h-full bg-primary transition-all duration-300" :style="{ width: `${store.renderState.percent}%` }"></div>
				</div>
			</div>

			<!-- Empty -->
			<div v-if="loaded && !files.length && !store.isRendering"
				class="h-full min-h-[200px] flex flex-col items-center justify-center text-center gap-3 py-8 px-2">
				<div class="w-12 h-12 rounded-2xl bg-secondary/10 flex items-center justify-center text-secondary">
					<span class="iconify tabler--file-export w-6 h-6"></span>
				</div>
				<p class="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed px-4">
					Nothing exported yet. Finished exports of this project are kept here, so you can find them again.
				</p>
			</div>

			<!-- Files -->
			<div v-for="file in files" :key="file.path"
				class="group px-2.5 py-2 rounded-xl mb-1 transition hover:bg-zinc-100/60 dark:hover:bg-zinc-800/40"
				@dblclick="open(file)">
				<div class="flex items-start gap-2.5 min-w-0">
					<div class="w-8 h-8 mt-px rounded-lg bg-zinc-200/70 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 shrink-0 flex items-center justify-center">
						<span class="iconify tabler--movie w-4 h-4"></span>
					</div>
					<div class="min-w-0 flex-1">
						<!-- Two lines, broken anywhere: exports of one project share a long
						     prefix and differ only in the id at the end. -->
						<p class="text-[11px] font-medium text-zinc-700 dark:text-zinc-200 break-all line-clamp-2 leading-snug" :title="file.name">
							{{ file.name }}
						</p>
						<div class="mt-1 flex items-center justify-between gap-2">
							<p class="text-[10px] text-zinc-400 dark:text-zinc-500 leading-tight truncate"
								:title="new Date(file.modifiedAt).toLocaleString()">
								{{ formatExportDate(file.modifiedAt) }}
								<span class="mx-0.5">·</span><span class="font-mono tabular-nums">{{ formatFileSize(file.size) }}</span>
								<span class="mx-0.5">·</span>{{ kind(file.name) }}
							</p>
							<div class="flex items-center gap-0.5 shrink-0 -mr-1">
								<SlimTooltip text="Show in folder" placement="top">
									<button class="act" aria-label="Show in folder" @click="reveal(file)">
										<span class="iconify tabler--folder-search w-4 h-4"></span>
									</button>
								</SlimTooltip>
								<SlimTooltip :text="saved === file.path ? 'Saved' : 'Save As…'" placement="top">
									<button class="act" :class="{ '!text-accent': saved === file.path }" aria-label="Save a copy as…" @click="saveAs(file)">
										<span class="iconify w-4 h-4" :class="saved === file.path ? 'tabler--check' : 'tabler--download'"></span>
									</button>
								</SlimTooltip>
								<SlimTooltip text="Open" placement="top">
									<button class="act act-primary" aria-label="Open in the default player" @click="open(file)">
										<span class="iconify tabler--player-play-filled w-3.5 h-3.5"></span>
									</button>
								</SlimTooltip>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EditorExportFile } from '@shared/types'
import { formatExportDate, formatFileSize } from '@shared/exportFormat'
import SlimTooltip from '../../components/SlimTooltip.vue'
import { useEditorStore } from '../../stores/editorStore'

/**
 * Every finished export of this project, newest first. The list is the disk's,
 * not the session's: closing the Export dialog, restarting the app or finishing
 * an export while another tab was open all leave the file findable here.
 * ChatColumn mounts this with v-if, so showing the tab reads the folder afresh;
 * while it is shown it re-reads when an export lands and when the window
 * regains focus (a file moved or deleted in Finder).
 */
const store = useEditorStore()
const api = (window as any).api

const files = ref<EditorExportFile[]>([])
const loaded = ref(false)
const saved = ref<string | null>(null)

let latest = 0
const refresh = async () => {
	const threadId = store.threadId
	if (!threadId) return
	const ticket = ++latest
	try {
		const next: EditorExportFile[] = await api.listEditorExports(threadId)
		// A slower, older read must not overwrite a newer one.
		if (ticket === latest) files.value = next
	} catch {
		if (ticket === latest) files.value = []
	}
	if (ticket === latest) loaded.value = true
}

onMounted(() => {
	void refresh()
	window.addEventListener('focus', refresh)
})
onBeforeUnmount(() => window.removeEventListener('focus', refresh))

watch(() => store.threadId, () => { files.value = []; loaded.value = false; void refresh() })
// The last stitch/deliver pass writes the file, then reports done.
watch(() => [store.renderState?.renderId, store.renderState?.phase], () => void refresh())

const headline = computed(() => {
	const n = files.value.length
	return n ? `${n} ${n === 1 ? 'export' : 'exports'}` : 'Exports'
})

const kind = (name: string) => name.split('.').pop()?.toUpperCase() ?? ''

const reveal = (file: EditorExportFile) => {
	if (store.threadId) api.revealEditorExport(store.threadId, file.path)
}
const open = (file: EditorExportFile) => {
	if (store.threadId) api.openEditorExport(store.threadId, file.path)
}
const openFolder = () => {
	if (store.threadId) api.openThreadDir(store.threadId)
}

let savedTimer: ReturnType<typeof setTimeout> | undefined
const saveAs = async (file: EditorExportFile) => {
	const result = await api.saveVideo(file.path)
	if (!result) return
	saved.value = file.path
	clearTimeout(savedTimer)
	savedTimer = setTimeout(() => { saved.value = null }, 1800)
}
onBeforeUnmount(() => clearTimeout(savedTimer))
</script>

<style scoped>
.act {
	@apply w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 transition active:scale-95
		hover:text-zinc-700 hover:bg-zinc-200/70 dark:hover:text-zinc-200 dark:hover:bg-white/10;
}
.act-primary {
	@apply hover:text-primary hover:bg-primary/10 dark:hover:text-primary-light;
}
</style>
