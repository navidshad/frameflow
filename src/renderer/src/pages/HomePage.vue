<template>
	<div class="h-screen flex flex-col bg-transparent transition-colors duration-300 overflow-hidden relative">
		<div class="container mx-auto px-6 py-12 max-w-7xl flex flex-col h-full z-10 relative">
			<!-- Header -->
			<PageHeader title="Your Videos" subtitle="Manage your video summaries and chats." />

			<div class="flex-1 overflow-y-auto -mx-6 px-6 pb-8 custom-scrollbar">
				<!-- Thread List -->
				<div v-if="loading" class="flex justify-center py-20">
					<div class="animate-spin rounded-lg h-10 w-10 border-4 border-primary border-t-transparent"></div>
				</div>

				<template v-else>
					<!-- Intro only. The ways to start are the cards below, in BOTH states —
					     a separate empty-state action used to offer just one of them. -->
					<EmptyState v-if="videoStore.threads.length === 0" />

					<div class="grid gap-10 md:grid-cols-2 lg:grid-cols-3 pb-20">
						<!-- New Video Edit Card -->
						<NewThreadCard
							title="New Video Edit"
							description="Transform your video into a concise masterpiece"
							@click="router.push('/upload')"
						/>

						<!-- New Image Edit Card -->
						<NewThreadCard
							title="New Image Edit"
							description="Create stunning visuals from your image collection"
							@click="handleCreateImageEdit"
						>
							<template #icon>
								<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
								</svg>
							</template>
						</NewThreadCard>

						<!-- Video Editor Card -->
						<NewThreadCard
							title="Video Editor"
							description="Cut and arrange clips on a multi-track timeline"
							@click="handleCreateEditorProject"
						>
							<template #icon>
								<svg xmlns="http://www.w3.org/2000/svg" class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<rect x="3" y="5" width="18" height="4" rx="1"/><rect x="3" y="12" width="12" height="4" rx="1"/><line x1="8" y1="3" x2="8" y2="21"/>
								</svg>
							</template>
						</NewThreadCard>

						<ThreadCard v-for="thread in videoStore.threads" :key="thread.id" :thread="thread"
							@open="openThread" @delete="handleDeleteThread" />
					</div>
				</template>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useVideoStore } from '../stores/videoStore'
import EmptyState from '../components/home/EmptyState.vue'
import NewThreadCard from '../components/home/NewThreadCard.vue'
import ThreadCard from '../components/home/ThreadCard.vue'
import PageHeader from '../components/PageHeader.vue'

const router = useRouter()
const videoStore = useVideoStore()
const loading = ref(true)

const openThread = (id: string) => {
	const thread = videoStore.threads.find((t) => t.id === id)
	router.push(thread?.type === 'editor' ? `/editor/${id}` : `/chat/${id}`)
}

const handleCreateEditorProject = async () => {
	const thread = await (window as any).api.createEditorProject('Untitled Project')
	if (thread) {
		videoStore.threads.unshift(thread)
		router.push(`/editor/${thread.id}`)
	}
}

const handleCreateImageEdit = async () => {
	const result = await (window as any).api.showOpenDialog({
		title: 'Select Images for your collection',
		properties: ['openFile', 'multiSelections'],
		filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
	})

	if (result && !result.canceled && result.filePaths.length > 0) {
		const firstFile = result.filePaths[0].split('/').pop() || 'Image Collection'
		const threadId = await videoStore.createThread(undefined, `Edit: ${firstFile}`, result.filePaths)
		router.push(`/chat/${threadId}`)
	}
}

const handleDeleteThread = async (id: string) => {
	if (confirm('Are you sure you want to delete this video summary and all its messages?')) {
		await videoStore.deleteThread(id)
	}
}

onMounted(async () => {
	try {
		await videoStore.fetchThreads()
	} finally {
		loading.value = false
	}
})
</script>
