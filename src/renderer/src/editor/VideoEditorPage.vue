<template>
	<!-- One surface. No cards, no ambient blobs: zones are split by a hairline and
	     the picture stage is a step darker. The chat column runs the full height of
	     the window; the timeline sits beside it, never under it. -->
	<div class="h-full w-full flex bg-ground overflow-hidden relative">
		<div class="flex-1 min-w-0 flex flex-col">
			<EditorTopBar :title="editorStore.thread?.title || 'Untitled Project'" :total-cost="totalCost"
				:show-export="!editorStore.loading && !notFound"
				:can-export="editorStore.canExport"
				:exporting="editorStore.isRendering"
				:percent="editorStore.renderState?.percent ?? 0"
				@back="router.push('/home')" @rename="editorStore.renameProject($event)" @export="showExport = true">
				<template v-if="agentStore.editingSession" #center>
					<AgentBanner />
				</template>
			</EditorTopBar>

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

			<!-- Editor workspace -->
			<template v-else>
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
			</template>
		</div>

		<ChatColumn v-if="!layout.chatFolded" v-model:tab="chatTab" :width="layout.chat"
			:revisions-badge="revisionsBadge"
			@collapse="chatColOpen = false" @resize="resizeChat" @reset-size="resetChat" />

		<template v-if="!editorStore.loading && !notFound">
			<ExportDialog v-model="showExport" />
			<ShortcutsOverlay />
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useEditorStore } from '../stores/editorStore'
import { useKeyframeLanesStore } from '../stores/keyframeLanesStore'
import { useAgentStore } from '../stores/agentStore'
import EditorTopBar from './components/EditorTopBar.vue'
import LeftPanel, { type LeftMode, type LeftTab } from './components/LeftPanel.vue'
import PreviewMonitor from './components/PreviewMonitor.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import ShortcutsOverlay from './components/ShortcutsOverlay.vue'
import ChatColumn from './components/ChatColumn.vue'
import ComposerStrip from './components/ComposerStrip.vue'
import ExportDialog from './components/ExportDialog.vue'
import ResizeHandle from './components/ResizeHandle.vue'
import AgentBanner from './components/AgentBanner.vue'
import { CHAT, LEFT, TIMELINE, resolveEditorLayout } from './layout'

const route = useRoute()
const router = useRouter()
const editorStore = useEditorStore()
const agentStore = useAgentStore()
const keyframeLanes = useKeyframeLanesStore()

const notFound = ref(false)
const showExport = ref(false)

// The v1 layout kept an inspector column and a chat "full height" switch. Neither
// exists now (Inspect is a tab; chat is always full height), so their saved
// flags are dropped rather than left to pile up.
for (const key of ['editor.inspectorCol', 'editor.inspectorW', 'editor.inspectorFull', 'editor.chatFull']) {
	localStorage.removeItem(key)
}

// ===== Left panel (persisted per machine) =====
const leftOpen = ref(localStorage.getItem('editor.leftRail') !== 'closed')
const leftTab = ref<LeftTab>((localStorage.getItem('editor.leftTab') as LeftTab) || 'media')
watch(leftTab, (v) => localStorage.setItem('editor.leftTab', v))
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

/** A single custom HTML layer is selected: its code needs room, so the left panel widens. */
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
	codeView: customLayerSelected.value && leftMode.value === 'inspect',
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
const chatTab = ref<'chat' | 'revisions' | 'agent'>('chat')
const revisionsBadge = ref(false)
const chatBadge = ref(false)

// Opening the revisions tab clears its badge (tab is v-modeled from ChatColumn)
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
