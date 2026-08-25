<template>
	<div class="h-full w-full flex flex-col relative bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
		<!-- Ambient Backgrounds -->
		<div
			class="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] bg-primary/10 dark:bg-primary/5 rounded-full blur-[140px] pointer-events-none transition-all duration-1000 animate-pulse-soft">
		</div>
		<div
			class="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-secondary/10 dark:bg-secondary/5 rounded-full blur-[140px] pointer-events-none transition-all duration-1000 animate-pulse-soft">
		</div>

		<GraphHeader :title="editorStore.thread?.title || 'Untitled Project'" :total-cost="totalCost" editable
			@back="router.push('/home')" @rename="editorStore.renameProject($event)">
			<!-- Where did this project come from? Nesting without a way back is the
			     single most reliable source of "where am I" confusion. -->
			<template #breadcrumb>
				<button v-if="editorStore.sourceThread"
					class="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-[11px] font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition max-w-[200px] shrink-0"
					:title="`Back to ${editorStore.sourceThread.title}`"
					@click="router.push(`/chat/${editorStore.sourceThread.id}`)">
					<span class="iconify tabler--arrow-back-up w-3.5 h-3.5 shrink-0"></span>
					<span class="truncate">{{ editorStore.sourceThread.title }}</span>
				</button>
			</template>
		</GraphHeader>

		<!-- Export lives in the app's fixed top-right cluster so it composes
		     with the settings/theme buttons instead of colliding with them -->
		<Teleport to="#header-actions-portal">
			<button v-if="!editorStore.loading && !notFound"
				class="px-3 py-1.5 rounded-xl text-xs font-bold transition active:scale-95 flex items-center gap-1.5"
				:class="editorStore.isRendering
					? 'bg-primary/10 text-primary ring-1 ring-primary/30'
					: editorStore.canExport
						? 'bg-primary text-white shadow-md shadow-primary/20 hover:bg-primary-dark'
						: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed'"
				:disabled="!editorStore.canExport && !editorStore.isRendering"
				:title="editorStore.canExport || editorStore.isRendering ? 'Export the timeline' : 'Add clips to the timeline first'"
				@click="showExport = true">
				<span class="iconify tabler--file-export w-3.5 h-3.5"></span>
				{{ editorStore.isRendering ? `Exporting ${editorStore.renderState?.percent ?? 0}%` : 'Export' }}
			</button>
		</Teleport>

		<!-- Loading -->
		<div v-if="editorStore.loading" class="flex-1 flex items-center justify-center z-10">
			<div class="animate-spin rounded-lg h-10 w-10 border-4 border-primary border-t-transparent"></div>
		</div>

		<!-- Not found -->
		<div v-else-if="notFound" class="flex-1 flex flex-col items-center justify-center gap-4 z-10">
			<p class="text-zinc-500 dark:text-zinc-400 font-medium">This editor project could not be loaded.</p>
			<button
				class="px-4 py-2 rounded-xl bg-primary text-white text-sm font-bold shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-95"
				@click="router.push('/home')">
				Back to Home
			</button>
		</div>

		<!-- Editor workspace -->
		<template v-else>
			<!-- ROW: [workspace column (top zones + timeline)] + any FULL-HEIGHT right
			     panels. A full-height panel narrows the workspace, so the timeline
			     adapts to the remaining width. -->
			<main class="flex-1 min-h-0 flex z-10 p-3 gap-3">
				<div class="flex-1 min-w-0 flex flex-col gap-3">
					<!-- Top zones: media | preview | right rail — rails collapse to slim strips -->
					<div class="flex-1 min-h-0 grid gap-3 transition-all duration-300"
						:style="{ gridTemplateColumns: `${leftOpen ? leftW + 'px' : '36px'} minmax(0,1fr) auto` }">

						<!-- Left rail: media (drag its right edge to resize) -->
						<div v-if="leftOpen" class="relative min-h-0 flex">
							<MediaPanel v-model:collapsed="leftCollapsedProxy" class="flex-1 min-w-0" />
							<ResizeHandle direction="vertical" class="absolute inset-y-0 -right-2.5 z-20"
								@resize="resizeLeft" @reset="resetLeft" />
						</div>
						<CollapsedRail v-else side="left" label="Media" icon="tabler--photo-video"
							@open="leftOpen = true" />

						<!-- Center: the monitor gets the full column now -->
						<PreviewMonitor class="min-h-0" />

						<!-- Right region (top-row slot): columns render here unless
						     toggled full-height; collapsed rails always live here -->
						<div class="flex min-h-0 gap-3">
							<ChatColumn v-if="chatColOpen && !chatFull" :width="chatW" v-model:tab="chatTab"
								:revisions-badge="revisionsBadge"
								@collapse="chatColOpen = false" @toggle-full="chatFull = true"
								@resize="resizeChat" @reset-size="resetChat" />
							<CollapsedRail v-if="!chatColOpen" side="right" label="Chat" icon="tabler--message-circle"
								:badge="chatBadge || revisionsBadge" @open="chatColOpen = true" />

							<InspectorColumn v-if="inspectorOpen && !inspectorFull" :width="inspectorW"
								@collapse="inspectorOpen = false" @toggle-full="inspectorFull = true"
								@resize="resizeInspector" @reset-size="resetInspector" />
							<CollapsedRail v-if="!inspectorOpen" side="right" label="Inspector" icon="tabler--adjustments"
								@open="inspectorOpen = true" />
						</div>
					</div>

					<!-- Bottom zone: timeline — drag the bar above it to resize -->
					<ResizeHandle direction="horizontal" reverse class="-my-2 z-20"
						@resize="resizeTimeline" @reset="resetTimeline" />
					<TimelinePanel class="shrink-0" :style="{ height: timelineH + 'px' }" />
				</div>

				<!-- Full-height slot: panels toggled to span the whole workspace height -->
				<ChatColumn v-if="chatColOpen && chatFull" full :width="chatW" v-model:tab="chatTab"
					:revisions-badge="revisionsBadge"
					@collapse="chatColOpen = false" @toggle-full="chatFull = false"
					@resize="resizeChat" @reset-size="resetChat" />
				<InspectorColumn v-if="inspectorOpen && inspectorFull" full :width="inspectorW"
					@collapse="inspectorOpen = false" @toggle-full="inspectorFull = false"
					@resize="resizeInspector" @reset-size="resetInspector" />
			</main>

			<ExportDialog v-model="showExport" />
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue'
import type { FunctionalComponent } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GraphHeader from '../components/graph/GraphHeader.vue'
import { useEditorStore } from '../stores/editorStore'
import MediaPanel from './components/MediaPanel.vue'
import PreviewMonitor from './components/PreviewMonitor.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import ChatColumn from './components/ChatColumn.vue'
import InspectorColumn from './components/InspectorColumn.vue'
import ExportDialog from './components/ExportDialog.vue'
import ResizeHandle from './components/ResizeHandle.vue'

const route = useRoute()
const router = useRouter()
const editorStore = useEditorStore()

const notFound = ref(false)
const showExport = ref(false)

// ===== Collapsible rails (persisted per machine) =====
const leftOpen = ref(localStorage.getItem('editor.leftRail') !== 'closed')
// Right region = two independently-collapsible COLUMNS. Closing a column frees
// its horizontal space, widening the player.
const chatColOpen = ref(localStorage.getItem('editor.chatCol') !== 'closed')
const inspectorOpen = ref(localStorage.getItem('editor.inspectorCol') !== 'closed')
// Full-height mode: the column leaves the top row and spans the whole
// workspace height; the timeline adapts to the remaining width.
const chatFull = ref(localStorage.getItem('editor.chatFull') === 'true')
const inspectorFull = ref(localStorage.getItem('editor.inspectorFull') === 'true')
watch(leftOpen, (v) => localStorage.setItem('editor.leftRail', v ? 'open' : 'closed'))
watch(chatColOpen, (v) => localStorage.setItem('editor.chatCol', v ? 'open' : 'closed'))
watch(inspectorOpen, (v) => localStorage.setItem('editor.inspectorCol', v ? 'open' : 'closed'))
watch(chatFull, (v) => localStorage.setItem('editor.chatFull', String(v)))
watch(inspectorFull, (v) => localStorage.setItem('editor.inspectorFull', String(v)))
// MediaPanel exposes its own collapse control through this proxy
const leftCollapsedProxy = computed({ get: () => !leftOpen.value, set: (v) => { leftOpen.value = !v } })

// ===== Resizable panel sizes (persisted per machine, like the rail flags) =====
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
	persistedSize('editor.timelineH', 208, 140, () => Math.round(window.innerHeight * 0.6))
const { size: leftW, resize: resizeLeft, reset: resetLeft } =
	persistedSize('editor.leftW', 280, 200, () => 440)
// 560 rather than 480: the revisions tab can now render a graph inline, and the
// extra width is what lets a second branch column fit. persistedSize clamps on
// read, so a stored 480 stays valid.
const { size: chatW, resize: resizeChat, reset: resetChat } =
	persistedSize('editor.chatW', 300, 240, () => 560)
const { size: inspectorW, resize: resizeInspector, reset: resetInspector } =
	persistedSize('editor.inspectorW', 280, 240, () => 480)

/** Slim vertical strip shown in place of a collapsed rail. */
const CollapsedRail: FunctionalComponent<
	{ side: 'left' | 'right'; label: string; icon: string; badge?: boolean },
	{ open: () => void }
> = (props, { emit }) =>
	h('button', {
		class: 'glass-card rounded-2xl flex flex-col items-center gap-2 py-3 px-0 text-zinc-400 hover:text-primary transition group relative',
		title: `Open ${props.label}`,
		onClick: () => emit('open')
	}, [
		h('span', { class: `iconify ${props.side === 'left' ? 'tabler--layout-sidebar-left-expand' : 'tabler--layout-sidebar-right-expand'} w-4 h-4 group-hover:scale-110 transition-transform` }),
		h('span', { class: `iconify ${props.icon} w-3.5 h-3.5 opacity-60` }),
		h('span', {
			class: 'text-[9px] font-bold uppercase tracking-widest [writing-mode:vertical-rl] mt-1'
		}, props.label),
		props.badge
			? h('span', { class: 'absolute top-2 right-1.5 w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft' })
			: null
	])
CollapsedRail.props = ['side', 'label', 'icon', 'badge']
CollapsedRail.emits = ['open']

// ===== Right rail =====
// Row 1 toggles Chat | Revisions; Row 2 is the Inspector.
const chatTab = ref<'chat' | 'revisions'>('chat')
const revisionsBadge = ref(false)
const chatBadge = ref(false)

// Opening the revisions tab clears its badge (tab is v-modeled from ChatColumn)
watch(chatTab, (tab) => {
	if (tab === 'revisions') revisionsBadge.value = false
})

watch(() => editorStore.lastResult, (result) => {
	if (result && chatTab.value !== 'revisions') revisionsBadge.value = true
})

// Badge Chat/Revisions when a turn completes while that column is closed.
watch(() => editorStore.doc?.turns?.length ?? 0, (n, old) => {
	if (n > (old ?? 0) && !chatColOpen.value) chatBadge.value = true
})
watch(chatColOpen, (open) => { if (open) chatBadge.value = false })

// Selecting a clip reveals the Inspector row so its details are visible.
watch(() => editorStore.selectedItemIds.length, (n) => {
	if (n > 0 && !inspectorOpen.value) inspectorOpen.value = true
})

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
