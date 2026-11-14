<template>
	<!-- One surface. No cards, no ambient blobs: zones are split by a hairline and
	     the picture stage is a step darker. The chat column runs the full height of
	     the window; the timeline sits beside it, never under it. -->
	<div class="h-full w-full flex bg-ground overflow-hidden relative" v-on="fileDrop.handlers">
		<div class="flex-1 min-w-0 flex flex-col">
			<EditorTopBar :title="editorStore.thread?.title || 'Untitled Project'" :total-cost="totalCost"
				:show-export="!editorStore.loading && !notFound"
				:can-export="editorStore.canExport"
				:exporting="editorStore.isRendering"
				:locked-by="editorStore.agentHolds"
				:percent="editorStore.renderState?.percent ?? 0"
				:can-thumbnail="canThumbnail" :thumbnail-busy="thumbnailBusy"
				@back="router.push('/home')" @rename="editorStore.renameProject($event)" @export="showExport = true" @thumbnail="openThumbnailPrompt">
				<template v-if="agentStore.editingSession" #center>
					<AgentBanner />
				</template>
			</EditorTopBar>
			<AgentWorkingStrip v-if="!editorStore.loading && !notFound" />

			<!-- Loading -->
			<div v-if="editorStore.loading" class="flex-1 flex items-center justify-center">
				<div class="animate-spin rounded-lg h-10 w-10 border-4 border-primary border-t-transparent"></div>
			</div>

			<!-- Not found -->
			<div v-else-if="notFound" class="flex-1 flex flex-col items-center justify-center gap-4">
				<p class="text-zinc-500 dark:text-zinc-400 font-medium">This editor project could not be loaded.</p>
				<button
					class="px-4 py-2 rounded-md bg-primary text-white text-sm font-semibold hover:bg-primary-dark transition active:scale-95"
					@click="router.push('/home')">
					Back to Home
				</button>
			</div>

			<!-- Editor workspace. While an outside agent holds the project a scrim
			     covers it: visible, playable, not editable. -->
			<div v-else class="flex-1 min-h-0 flex flex-col relative">
				<div class="flex-1 min-h-0 flex">
					<LeftPanel v-model:tab="leftTab" :mode="leftMode" :collapsed="!leftOpen" v-model:pinned="inspectPinned"
						:width="layout.left" :selection-dot="timelineSelected"
						@update:mode="setLeftMode" @update:collapsed="leftOpen = !$event">
						<template #resize>
							<ResizeHandle v-if="leftOpen" direction="vertical"
								class="absolute inset-y-0 -right-1 z-20"
								@resize="resizeLeft" @reset="resetLeft" />
						</template>
					</LeftPanel>

					<div class="flex-1 min-w-0 flex flex-col">
						<PreviewMonitor class="flex-1 min-h-0" />
						<ComposerStrip v-if="layout.chatFolded" :badge="chatBadge || revisionsBadge"
							:folded-for-room="layout.chatFoldedForRoom" @open="chatColOpen = true" />
					</div>
				</div>

				<!-- Drag the line above the timeline to resize it -->
				<ResizeHandle direction="horizontal" reverse class="-my-1 z-20"
					@resize="resizeTimeline" @reset="resetTimeline" />
				<TimelinePanel class="shrink-0" :style="{ height: timelineH + 'px' }" />
				<AgentWorkingScrim />
			</div>
		</div>

		<ChatColumn v-if="!layout.chatFolded" v-model:tab="chatTab" :width="layout.chat"
			:revisions-badge="revisionsBadge"
			@collapse="chatColOpen = false" @resize="resizeChat" @reset-size="resetChat" />

		<template v-if="!editorStore.loading && !notFound">
			<ExportDialog v-model="showExport" @show-exports="showExportsTab" />
			<ThumbnailPromptDialog v-model="showThumbnailPrompt" :suggested="thumbnailBrief.text" :busy="thumbnailBusy"
				@generate="makeThumbnail" />
			<ShortcutsOverlay />
		</template>

		<!-- Files or folders dragged in from the OS: they go to the Media panel. -->
		<div v-if="fileDrop.over.value" data-testid="file-drop-overlay"
			class="absolute inset-0 z-50 pointer-events-none flex items-center justify-center bg-primary/10 backdrop-blur-[1px] border-2 border-dashed border-primary/60 rounded-lg m-2">
			<div class="px-5 py-3 rounded-xl bg-white/90 dark:bg-zinc-900/90 shadow-lg text-sm font-bold text-primary">
				Drop to add to Media
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useEditorStore } from '../stores/editorStore'
import { useKeyframeLanesStore } from '../stores/keyframeLanesStore'
import { useAgentStore } from '../stores/agentStore'
import { useVideoStore } from '../stores/videoStore'
import { dialog } from '../composables/useDialog'
import EditorTopBar from './components/EditorTopBar.vue'
import LeftPanel, { type LeftMode, type LeftTab } from './components/LeftPanel.vue'
import PreviewMonitor from './components/PreviewMonitor.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import ShortcutsOverlay from './components/ShortcutsOverlay.vue'
import ChatColumn from './components/ChatColumn.vue'
import type { ChatTab } from './chatTab'
import ComposerStrip from './components/ComposerStrip.vue'
import ExportDialog from './components/ExportDialog.vue'
import ThumbnailPromptDialog from './components/ThumbnailPromptDialog.vue'
import ResizeHandle from './components/ResizeHandle.vue'
import AgentBanner from './components/AgentBanner.vue'
import AgentWorkingStrip from './components/AgentWorkingStrip.vue'
import AgentWorkingScrim from './components/AgentWorkingScrim.vue'
import { CHAT, LEFT, TIMELINE, resolveEditorLayout } from './layout'
import { tabForMode, useEditorMode } from './editorMode'
import { useFileDrop } from './composables/useFileDrop'

const route = useRoute()
const router = useRouter()
const editorStore = useEditorStore()
const agentStore = useAgentStore()
const keyframeLanes = useKeyframeLanesStore()
const { mode, isPro } = useEditorMode()

const notFound = ref(false)

// Dropped files and folders join the project's media; the Media tab opens so
// the progress and the closing report are in view.
const fileDrop = useFileDrop((paths) => {
	leftOpen.value = true
	leftTab.value = 'media'
	setLeftMode('library')
	void editorStore.importPaths(paths)
}, () => !editorStore.loading && !notFound.value && !editorStore.agentHolds)
const showExport = ref(false)

// ===== Generate thumbnail =====
// A new IMAGE project, seeded from this video: its best frames, and a headline
// from the title or transcript. Main does the work; if a Gemini key is set the
// image project starts generating once, otherwise its first message waits.
const videoStore = useVideoStore()
const thumbnailBusy = ref(false)
const canThumbnail = computed(() => !!editorStore.doc?.media.some((a) => a.kind === 'video'))
const showThumbnailPrompt = ref(false)
const thumbnailBrief = reactive({ text: '', frameCount: 0 })

/** The button: write the suggested prompt, and let the person read and change it before anything is made. */
const openThumbnailPrompt = async () => {
	if (thumbnailBusy.value || !editorStore.threadId) return
	thumbnailBusy.value = true
	try {
		await editorStore.persistDoc() // main reads the saved project, so flush edits first
		const preview = await videoStore.thumbnailBriefFor(editorStore.threadId)
		thumbnailBrief.text = preview.brief
		thumbnailBrief.frameCount = preview.frameCount
		showThumbnailPrompt.value = true
	} catch (e: any) {
		thumbnailError(e, 'Something went wrong while preparing the thumbnail prompt.')
	} finally {
		thumbnailBusy.value = false
	}
}

const thumbnailError = (e: any, fallback: string) => {
	const detail = String(e?.message || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
	dialog.notify({ title: 'Could not make the thumbnail project', message: detail || fallback, tone: 'error' })
}

/** The dialog's Generate: the prompt as the person left it. */
const makeThumbnail = async (prompt: string) => {
	if (thumbnailBusy.value || !editorStore.threadId) return
	thumbnailBusy.value = true
	try {
		await editorStore.persistDoc()
		const made = await videoStore.makeThumbnailProject(editorStore.threadId, { prompt, expectedFrameCount: thumbnailBrief.frameCount })
		showThumbnailPrompt.value = false
		await router.push(`/chat/${made.threadId}`)
		if (!made.generating) {
			dialog.notify({
				title: 'Thumbnail project ready',
				message: 'There is no Gemini key set, so nothing was generated. The frames and the first message are in the new project: add a key in Settings, then press Retry on that message.',
				tone: 'info'
			})
		}
	} catch (e: any) {
		thumbnailError(e, 'Something went wrong while taking frames from the video.')
	} finally {
		thumbnailBusy.value = false
	}
}
// An agent that begins a round takes the project: an open Export dialog closes.
watch(() => editorStore.agentHolds, (held) => { if (held) showExport.value = false })

// The v1 layout kept an inspector column and a chat "full height" switch. Neither
// exists now (Inspect is a tab; chat is always full height), so their saved
// flags are dropped rather than left to pile up.
for (const key of ['editor.inspectorCol', 'editor.inspectorW', 'editor.inspectorFull', 'editor.chatFull']) {
	localStorage.removeItem(key)
}

// ===== Left panel (persisted per machine) =====
const leftOpen = ref(localStorage.getItem('editor.leftRail') !== 'closed')
// Light lists Media and Words only. A library saved while in Pro — or still
// open when the switch goes to Light — would leave the panel on a tab the rail
// no longer shows, so it becomes Media, here on load and again on the switch.
// Nothing else follows the mode: the project, the playhead, what is selected
// and the chat draft are where they were.
const leftTab = ref<LeftTab>(tabForMode((localStorage.getItem('editor.leftTab') as LeftTab) || 'media', mode.value))
watch(leftTab, (v) => localStorage.setItem('editor.leftTab', v))
watch(mode, (m) => { leftTab.value = tabForMode(leftTab.value, m) })
watch(leftOpen, (v) => localStorage.setItem('editor.leftRail', v ? 'open' : 'closed'))

const chatColOpen = ref(localStorage.getItem('editor.chatCol') !== 'closed')
watch(chatColOpen, (v) => localStorage.setItem('editor.chatCol', v ? 'open' : 'closed'))

// ===== Resizable panel sizes (persisted per machine) =====
const persistedSize = (key: string, def: number, min: number, max: () => number) => {
	const stored = parseFloat(localStorage.getItem(key) || '')
	const size = ref(Number.isFinite(stored) ? Math.min(Math.max(stored, min), max()) : def)
	watch(size, (v) => localStorage.setItem(key, String(Math.round(v))))
	const resize = (delta: number) => {
		size.value = Math.min(Math.max(size.value + delta, min), max())
	}
	const reset = () => { size.value = def }
	return { size, resize, reset }
}
const { size: timelineH, resize: resizeTimeline, reset: resetTimeline } =
	persistedSize('editor.timelineH', TIMELINE.def, TIMELINE.min, () => Math.round(window.innerHeight * 0.6))
const { size: leftW, resize: resizeLeft, reset: resetLeft } =
	persistedSize('editor.leftW', LEFT.def, LEFT.min, () => LEFT.max)
// 560: the revisions tab can render a graph inline, and the extra width is what
// lets a second branch column fit.
const { size: chatW, resize: resizeChat, reset: resetChat } =
	persistedSize('editor.chatW', CHAT.def, CHAT.min, () => CHAT.max)

// ===== The horizontal budget =====
// The picture has a floor; panels give way to it in a fixed order (layout.ts).
const windowW = ref(window.innerWidth)
const onResize = () => { windowW.value = window.innerWidth }
onMounted(() => window.addEventListener('resize', onResize))
onBeforeUnmount(() => window.removeEventListener('resize', onResize))

/**
 * A single custom HTML layer is selected: its code needs room, so the left panel
 * widens. Only in Pro — Light has no code tab, so there is nothing to make room for.
 */
const customLayerSelected = computed(() => {
	const ids = editorStore.selectedItemIds
	if (ids.length !== 1 || editorStore.selectedSeamId) return false
	const item = editorStore.doc?.timeline.find((i) => i.id === ids[0])
	return !!item?.motion && !item.motion.template
})

const layout = computed(() => resolveEditorLayout({
	windowW: windowW.value,
	leftOpen: leftOpen.value,
	leftWanted: leftW.value,
	codeView: isPro.value && customLayerSelected.value && leftMode.value === 'inspect',
	chatOpen: chatColOpen.value,
	chatWanted: chatW.value
}))

// ===== Inspect: the left panel's second tab =====
// Selecting something on the timeline brings Inspect forward; deselecting puts
// the library back — unless the person chose a tab themselves, or pinned Inspect.
const leftMode = ref<LeftMode>('library')
const inspectPinned = ref(localStorage.getItem('editor.inspectPinned') === 'true')
watch(inspectPinned, (v) => localStorage.setItem('editor.inspectPinned', String(v)))
let autoFocused = false

const setLeftMode = (mode: LeftMode) => {
	leftMode.value = mode
	autoFocused = false // a tab the person picked is theirs to keep
}

/** Something on the timeline is selected: a clip, a transition, or a key. */
const timelineSelected = computed(() =>
	editorStore.selectedItemIds.length > 0 || !!editorStore.selectedSeamId || keyframeLanes.selection.length > 0
)

watch(timelineSelected, (selected) => {
	if (inspectPinned.value) return
	if (selected) {
		if (leftMode.value === 'library') {
			leftMode.value = 'inspect'
			autoFocused = true
		}
	} else if (autoFocused) {
		leftMode.value = 'library'
		autoFocused = false
	}
})

// ===== Chat column =====
const chatTab = ref<ChatTab>('chat')
const revisionsBadge = ref(false)
const chatBadge = ref(false)

// Opening the revisions tab clears its badge (tab is v-modeled from ChatColumn)
// The Export dialog's "Exports tab" link: open the column on that tab.
const showExportsTab = () => {
	chatColOpen.value = true
	chatTab.value = 'exports'
}

watch(chatTab, (tab) => {
	if (tab === 'revisions') revisionsBadge.value = false
})

watch(() => editorStore.lastResult, (result) => {
	if (result && chatTab.value !== 'revisions') revisionsBadge.value = true
})

// Badge the composer's "Open chat" when a turn completes while the column is folded.
watch(() => editorStore.doc?.turns?.length ?? 0, (n, old) => {
	if (n > (old ?? 0) && layout.value.chatFolded) chatBadge.value = true
})
watch(() => layout.value.chatFolded, (folded) => { if (!folded) chatBadge.value = false })

const totalCost = computed(() =>
	(editorStore.thread?.usageHistory || []).reduce((sum, record) => sum + (record.cost || 0), 0)
)

const openProject = async (id: string) => {
	notFound.value = false
	showExport.value = false
	const ok = await editorStore.loadProject(id)
	if (!ok) notFound.value = true
}

onMounted(() => openProject(route.params.id as string))

// The /editor/:id route reuses this component instance, so navigating
// directly from one editor project to another (e.g. via the background
// render pill) only changes the param — reload the store to follow it.
// Flush the debounced autosave FIRST so the previous project's last edits
// aren't lost (or misdirected) when loadProject swaps threadId/doc.
watch(() => route.params.id, async (id, oldId) => {
	if (!id || id === oldId || typeof id !== 'string') return
	await editorStore.persistDoc()
	await openProject(id)
})
</script>
