<template>
	<div class="h-screen flex flex-col bg-transparent transition-colors duration-300 overflow-hidden relative">
		<div class="container mx-auto px-6 py-12 max-w-7xl flex flex-col h-full z-10 relative">
			<PageHeader title="FrameFlow" subtitle="Describe what you want to make, attach your files, and go." />

			<div class="flex-1 overflow-y-auto -mx-6 px-6 pb-8 custom-scrollbar">
				<!-- Dependency warnings must be seen BEFORE a file is committed -->
				<SystemRequirementsBanner @ffmpeg-available="ffmpegAvailable = $event" />

				<HomeComposer ref="composerRef" :ffmpeg-available="ffmpegAvailable" :busy="isCreating"
					@submit="handleComposerSubmit" @pick-link="showLinkModal = true" />

				<!-- Always visible, not empty-state-only: a blank multi-source timeline
				     is otherwise unreachable without first making an AI thread. -->
				<div class="w-full max-w-3xl mx-auto mt-3 flex justify-end">
					<button @click="handleCreateEditorProject"
						class="text-xs font-bold text-zinc-500 dark:text-zinc-400 hover:text-primary transition flex items-center gap-1.5">
						or start a blank timeline project
						<span class="iconify tabler--arrow-right w-3.5 h-3.5"></span>
					</button>
				</div>

				<!-- Recent projects -->
				<div class="mt-14">
					<h2 class="text-[10px] font-black uppercase tracking-[0.2em] text-zinc-400 dark:text-zinc-500 mb-6">
						Recent projects
					</h2>

					<div v-if="loading" class="flex justify-center py-20">
						<div class="animate-spin rounded-lg h-10 w-10 border-4 border-primary border-t-transparent"></div>
					</div>

					<p v-else-if="videoStore.threads.length === 0"
						class="text-sm text-zinc-500 dark:text-zinc-400 py-8">
						Nothing here yet — your projects will show up in this list.
					</p>

					<div v-else class="grid gap-10 md:grid-cols-2 lg:grid-cols-3 pb-20">
						<ThreadCard v-for="thread in videoStore.threads" :key="thread.id" :thread="thread"
							@open="openThread" @delete="handleDeleteThread" />
					</div>
				</div>
			</div>
		</div>

		<VideoLinkModal v-model="showLinkModal" @select="handleLinkSelected" />
	</div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { MessageRole, type ThreadType } from '@shared/types'
import { useVideoStore } from '../stores/videoStore'
import { useEditorStore } from '../stores/editorStore'
import HomeComposer from '../components/home/HomeComposer.vue'
import SystemRequirementsBanner from '../components/home/SystemRequirementsBanner.vue'
import VideoLinkModal from '../components/home/VideoLinkModal.vue'
import ThreadCard from '../components/home/ThreadCard.vue'
import PageHeader from '../components/PageHeader.vue'

const router = useRouter()
const videoStore = useVideoStore()
const editorStore = useEditorStore()
const loading = ref(true)
const isCreating = ref(false)
const ffmpegAvailable = ref(true)
const showLinkModal = ref(false)
const composerRef = ref<InstanceType<typeof HomeComposer> | null>(null)

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

const handleLinkSelected = (file: { path: string; name: string }) => {
	composerRef.value?.setVideo(file.path, file.name)
}

const titleFor = (imagePaths: string[] = []): string => {
	const first = imagePaths[0]?.split('/').pop() || 'Image Collection'
	return `Edit: ${first}`
}

/**
 * Video: create an editor project, import the file, hand the prompt over — and
 * deliberately DO NOT run it. Preprocessing has not started, so runEditorPrompt
 * would fail its media guard and surface as a red error turn; PromptBar enables
 * itself once hasReadyMedia flips.
 */
const createVideoProject = async (payload: { videoPath?: string; videoName?: string; prompt: string }) => {
	// The literal 'Untitled Project' is what makes createMediaAsset derive a
	// clean title from the filename (Lecture_3.mp4 -> "Lecture 3").
	const thread = await (window as any).api.createEditorProject('Untitled Project')
	if (!thread) {
		isCreating.value = false
		await (window as any).api.showConfirmation({
			title: 'Could not create the project',
			message: 'The timeline project could not be created.',
			type: 'error', buttons: ['OK'], defaultId: 0, cancelId: 0
		})
		return
	}
	videoStore.threads.unshift(thread)

	try {
		// Awaited: it is one ffprobe, and it means an unreadable file is reported
		// here rather than dumping the user into a blank editor.
		if (payload.videoPath) {
			await (window as any).api.addMediaAsset({
				threadId: thread.id, filePath: payload.videoPath, name: payload.videoName
			})
		}
	} catch (e: any) {
		// The project exists and is in Recent now — still navigate. Stranding the
		// user on Home beside a phantom entry is worse than an empty media panel.
		await (window as any).api.showConfirmation({
			title: 'Could not read that video',
			message: e?.message || 'The file could not be imported. You can add it again from the editor.',
			type: 'warning', buttons: ['OK'], defaultId: 0, cancelId: 0
		})
	}

	editorStore.queuePrompt(thread.id, payload.prompt)
	router.push(`/editor/${thread.id}`)
}

/**
 * Two paths, because the two outcomes live on different surfaces:
 *   Images -> an AI graph thread, first turn fired here (see below)
 *   Video  -> a timeline editor project, prompt QUEUED not run (see createVideoProject)
 */
const handleComposerSubmit = async (payload: {
	purpose: ThreadType
	videoPath?: string
	videoName?: string
	imagePaths: string[]
	prompt: string
	count: number
	isThinkingMode: boolean
	autoUseImages: boolean
}) => {
	if (isCreating.value) return
	isCreating.value = true

	if (payload.purpose === 'video') {
		await createVideoProject(payload)
		return
	}

	// ----- Images: AI graph thread -----
	// The order below is load-bearing: addMessage bails silently without
	// currentThreadId and startProcessing bails without currentThread, and both
	// are only satisfied because createThread set them. Navigating first races
	// GraphChatPage's onMounted -> selectThread against a half-loaded store.
	try {
		const thread = await videoStore.createThread(
			payload.videoPath,
			titleFor(payload.imagePaths),
			payload.imagePaths,
			payload.purpose
		)

		// Attach the COPIED paths, not the user's originals — createThread copies
		// every image into <tempDir>/images/ and records them in input order.
		const refs = thread.preprocessing?.sourceImages ?? []

		const userMsgId = await videoStore.addMessage(
			payload.prompt, MessageRole.User, undefined, refs, payload.autoUseImages
		)

		if (userMsgId) {
			await videoStore.startProcessing(
				thread.id, userMsgId, payload.count, payload.isThinkingMode, payload.autoUseImages
			)
		}

		router.push(`/chat/${thread.id}`)
	} catch (e: any) {
		// Only reset on failure — on success we navigate away.
		isCreating.value = false
		await (window as any).api.showConfirmation({
			title: 'Could not create the project',
			message: e?.message || 'Something went wrong while setting up your project.',
			type: 'error',
			buttons: ['OK'],
			defaultId: 0,
			cancelId: 0
		})
	}
}

const handleDeleteThread = async (id: string) => {
	if (confirm('Are you sure you want to delete this project and all its messages?')) {
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
