<template>
	<div class="h-full w-full flex flex-col relative bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
		<!-- Ambient Backgrounds -->
		<div
			class="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] bg-primary/10 dark:bg-primary/5 rounded-full blur-[140px] pointer-events-none transition-all duration-1000 animate-pulse-soft">
		</div>
		<div
			class="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-secondary/10 dark:bg-secondary/5 rounded-full blur-[140px] pointer-events-none transition-all duration-1000 animate-pulse-soft">
		</div>

		<GraphHeader :title="editorStore.thread?.title || 'Video Editor'" :total-cost="totalCost"
			@back="router.push('/home')" />

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
			<main class="flex-1 min-h-0 flex flex-col z-10 p-3 gap-3">
				<!-- Top zones: media | preview | right rail — rails collapse to slim strips -->
				<div class="flex-1 min-h-0 grid gap-3 transition-all duration-300"
					:style="{ gridTemplateColumns: `${leftOpen ? '280px' : '36px'} minmax(0,1fr) ${rightOpen ? '320px' : '36px'}` }">

					<!-- Left rail: media -->
					<MediaPanel v-if="leftOpen" v-model:collapsed="leftCollapsedProxy" />
					<CollapsedRail v-else side="left" label="Media" icon="tabler--photo-video"
						@open="leftOpen = true" />

					<!-- Center: the monitor gets the full column now -->
					<PreviewMonitor class="min-h-0" />

					<!-- Right rail: Chat | Inspect | Revisions -->
					<div v-if="rightOpen" class="flex flex-col min-h-0 gap-2">
						<div class="flex items-center gap-1 shrink-0">
							<div class="flex-1 flex items-center bg-zinc-100/80 dark:bg-zinc-900/80 rounded-xl p-0.5 border border-zinc-200 dark:border-zinc-800">
								<button v-for="tab in (['chat', 'inspect', 'revisions'] as const)" :key="tab"
									class="flex-1 px-2 py-1 rounded-lg text-[9px] font-bold uppercase tracking-widest transition relative"
									:class="rightTab === tab
										? 'bg-primary text-white shadow-md shadow-primary/20'
										: 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'"
									@click="selectRightTab(tab)">
									{{ tab }}
									<span v-if="tab === 'revisions' && revisionsBadge"
										class="absolute top-0.5 right-1.5 w-1.5 h-1.5 rounded-full bg-secondary animate-pulse-soft"></span>
									<span v-if="tab === 'chat' && chatBadge"
										class="absolute top-0.5 right-1.5 w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft"></span>
								</button>
							</div>
							<button title="Collapse panel"
								class="w-6 h-6 flex items-center justify-center rounded-lg text-zinc-400 hover:text-primary hover:bg-primary/10 transition shrink-0"
								@click="rightOpen = false">
								<span class="iconify tabler--layout-sidebar-right-collapse w-3.5 h-3.5"></span>
							</button>
						</div>
						<ChatPanel v-show="rightTab === 'chat'" class="flex-1 min-h-0" />
						<InspectorPanel v-if="rightTab === 'inspect'" class="flex-1 min-h-0" />
						<RevisionsPanel v-if="rightTab === 'revisions'" class="flex-1 min-h-0" />
					</div>
					<CollapsedRail v-else side="right" label="Chat & Inspect" icon="tabler--message-circle"
						:badge="chatBadge || revisionsBadge" @open="rightOpen = true" />
				</div>

				<!-- Bottom zone: timeline -->
				<TimelinePanel class="h-52 shrink-0" />
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
import RevisionsPanel from './components/RevisionsPanel.vue'
import MediaPanel from './components/MediaPanel.vue'
import PreviewMonitor from './components/PreviewMonitor.vue'
import InspectorPanel from './components/InspectorPanel.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import ChatPanel from './components/ChatPanel.vue'
import ExportDialog from './components/ExportDialog.vue'

const route = useRoute()
const router = useRouter()
const editorStore = useEditorStore()

const notFound = ref(false)
const showExport = ref(false)

// ===== Collapsible rails (persisted per machine) =====
const leftOpen = ref(localStorage.getItem('editor.leftRail') !== 'closed')
const rightOpen = ref(localStorage.getItem('editor.rightRail') !== 'closed')
watch(leftOpen, (v) => localStorage.setItem('editor.leftRail', v ? 'open' : 'closed'))
watch(rightOpen, (v) => localStorage.setItem('editor.rightRail', v ? 'open' : 'closed'))
// MediaPanel exposes its own collapse control through this proxy
const leftCollapsedProxy = computed({ get: () => !leftOpen.value, set: (v) => { leftOpen.value = !v } })

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

// ===== Right-rail tabs =====
const rightTab = ref<'chat' | 'inspect' | 'revisions'>('chat')
const revisionsBadge = ref(false)
const chatBadge = ref(false)

const selectRightTab = (tab: 'chat' | 'inspect' | 'revisions') => {
	rightTab.value = tab
	if (tab === 'revisions') revisionsBadge.value = false
	if (tab === 'chat') chatBadge.value = false
}

watch(() => editorStore.lastResult, (result) => {
	if (result && rightTab.value !== 'revisions') revisionsBadge.value = true
})

// Badge the chat tab (or collapsed rail) when a turn completes off-screen
watch(() => editorStore.doc?.turns?.length ?? 0, (n, old) => {
	if (n > (old ?? 0) && (rightTab.value !== 'chat' || !rightOpen.value)) chatBadge.value = true
})

// Auto-select a useful tab: picking a clip/item while on chat is common —
// keep manual control, but jump to Inspect when a selection happens with the
// rail on chat? Deliberately NOT auto-switching: predictability wins.

const totalCost = computed(() =>
	(editorStore.thread?.usageHistory || []).reduce((sum, record) => sum + (record.cost || 0), 0)
)

onMounted(async () => {
	const id = route.params.id as string
	const ok = await editorStore.loadProject(id)
	if (!ok) notFound.value = true
})
</script>
