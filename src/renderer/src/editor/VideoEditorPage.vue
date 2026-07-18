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
				<!-- Top zones: media | preview | inspector -->
				<div class="flex-1 min-h-0 grid grid-cols-[280px_minmax(0,1fr)_300px] gap-3">
					<MediaPanel />
					<div class="flex flex-col min-h-0 gap-3">
						<PreviewMonitor class="flex-1 min-h-0" />

						<!-- AI answer card (question turns) -->
						<div v-if="editorStore.lastAnswer"
							class="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-xl p-3 flex items-start gap-2 animate-fade-in-up shrink-0">
							<span class="text-base leading-none mt-0.5">{{ editorStore.activePersona?.icon || '💬' }}</span>
							<p class="flex-1 text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed">{{ editorStore.lastAnswer.text }}</p>
							<button class="w-5 h-5 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 shrink-0"
								@click="editorStore.dismissAnswer()">
								<span class="iconify tabler--x w-3 h-3"></span>
							</button>
						</div>

						<!-- AI proposal review card -->
						<ProposalCard v-if="editorStore.pendingProposal" class="shrink-0" />

						<PromptBar />
					</div>
					<InspectorPanel />
				</div>

				<!-- Bottom zone: timeline -->
				<TimelinePanel class="h-52 shrink-0" />
			</main>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GraphHeader from '../components/graph/GraphHeader.vue'
import { useEditorStore } from '../stores/editorStore'
import MediaPanel from './components/MediaPanel.vue'
import PreviewMonitor from './components/PreviewMonitor.vue'
import InspectorPanel from './components/InspectorPanel.vue'
import TimelinePanel from './components/TimelinePanel.vue'
import PromptBar from './components/PromptBar.vue'
import ProposalCard from './components/ProposalCard.vue'

const route = useRoute()
const router = useRouter()
const editorStore = useEditorStore()

const notFound = ref(false)

const totalCost = computed(() =>
	(editorStore.thread?.usageHistory || []).reduce((sum, record) => sum + (record.cost || 0), 0)
)

onMounted(async () => {
	const id = route.params.id as string
	const ok = await editorStore.loadProject(id)
	if (!ok) notFound.value = true
})
</script>
