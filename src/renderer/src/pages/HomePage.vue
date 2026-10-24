<template>
	<div class="h-full flex flex-col bg-ground overflow-hidden">
		<AppTopBar brand />

		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
			<div class="mx-auto w-full max-w-[1120px] px-10 pt-7 pb-16 flex flex-col min-h-full">
				<!-- Dependency warnings must be seen BEFORE a file is committed -->
				<SystemRequirementsBanner @ffmpeg-available="ffmpegAvailable = $event" />

				<!-- One-time line after setup -->
				<div v-if="welcome" class="strip strip-ok items-center mb-6">
					<span class="iconify tabler--check w-3.5 h-3.5 text-accent shrink-0"></span>
					<span class="flex-1 text-zinc-600 dark:text-zinc-300">
						<b class="font-semibold text-accent-dark dark:text-accent-light">You’re set up.</b>
						Projects in <span class="font-mono">{{ summary.folder }}</span> · engine {{ summary.engine }} · generated audio {{ summary.audio }}
					</span>
					<button class="btn-text btn-text-primary" @click="router.push('/settings')">Settings</button>
					<button class="btn-icon !w-6 !h-6" aria-label="Dismiss" @click="dismissWelcome">
						<span class="iconify tabler--x w-3.5 h-3.5"></span>
					</button>
				</div>

				<h1 class="mt-3 font-heading font-black text-[44px] tracking-[-0.025em] leading-[1.05]">What are you making?</h1>
				<p class="mt-2 text-base text-zinc-500 dark:text-zinc-400">Pick a road. Each one keeps its own projects.</p>

				<div v-if="loading" class="flex justify-center py-24">
					<span class="iconify tabler--loader-2 w-5 h-5 animate-spin text-primary"></span>
				</div>

				<div v-else class="mt-9 flex gap-14 hair-t pt-8 flex-1" @dragover.prevent @drop.prevent>
					<HomeRoad kind="image" :threads="roads.image" :dropping="dropRoad === 'image'" :drop-error="dropError.image" :busy="isCreating"
						@new="createImage()" @add="addImages" @open="openThread" @delete="handleDeleteThread"
						@drag="setDrag('image', $event)" @drop="onDrop('image', $event)" />
					<div class="w-px shrink-0 bg-hair"></div>
					<HomeRoad kind="video" :threads="roads.video" :dropping="dropRoad === 'video'" :drop-error="dropError.video" :busy="isCreating"
						@new="createVideo()" @add="addVideo" @link="showLinkModal = true" @open="openThread" @delete="handleDeleteThread"
						@drag="setDrag('video', $event)" @drop="onDrop('video', $event)" />
				</div>
			</div>
		</div>

		<VideoLinkModal v-model="showLinkModal" @select="(f) => createVideo(f)" />
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { isLegacyVideoThread } from '@shared/legacy'
import { planDrop, splitRoads, type DroppedFile, type Road } from '@shared/homeRoads'
import { ENGINES } from '@shared/engines'
import { tildePath } from '@shared/setup'
import { useVideoStore } from '../stores/videoStore'
import { useEngineStore } from '../stores/engineStore'
import { useAudioStore } from '../stores/audioStore'
import SystemRequirementsBanner from '../components/home/SystemRequirementsBanner.vue'
import VideoLinkModal from '../components/home/VideoLinkModal.vue'
import HomeRoad from '../components/home/HomeRoad.vue'
import AppTopBar from '../components/AppTopBar.vue'
import { dialog } from '../composables/useDialog'
import { focusChatSoon } from '../utils/focusChat'
import { WELCOME_KEY } from '../utils/setupWelcome'

/**
 * Two roads: Images opens the graph, Video opens the timeline editor. There is
 * no prompt here any more. A new project opens its destination with the files
 * attached and the chat focused, so the first message is written where the
 * result will appear.
 */
const api = (window as any).api
const router = useRouter()
const videoStore = useVideoStore()
const engineStore = useEngineStore()
const audioStore = useAudioStore()

const loading = ref(true)
const isCreating = ref(false)
const ffmpegAvailable = ref(true)
const showLinkModal = ref(false)
const dropRoad = ref<Road | null>(null)
const dropError = reactive<Record<Road, string>>({ image: '', video: '' })

const roads = computed(() => splitRoads(videoStore.threads))

// ----- The one-time "You're set up" line -----
const readWelcome = () => { try { return sessionStorage.getItem(WELCOME_KEY) === '1' } catch { return false } }
const welcome = ref(readWelcome())
const dismissWelcome = () => {
	welcome.value = false
	try { sessionStorage.removeItem(WELCOME_KEY) } catch { /* nothing to clear */ }
}
const home = ref('')
const folder = ref('')
const summary = computed(() => ({
	folder: tildePath(folder.value, home.value),
	engine: ENGINES[engineStore.settings.engine].label,
	audio: audioStore.connected.length ? 'on' : 'off'
}))

// ----- Opening and deleting -----
const openThread = (id: string) => {
	const thread = videoStore.threads.find((t) => t.id === id)
	if (!thread || isLegacyVideoThread(thread)) return
	router.push(thread.type === 'editor' ? `/editor/${id}` : `/chat/${id}`)
}

const handleDeleteThread = async (id: string) => {
	const confirmed = await dialog.confirm({
		title: 'Delete project',
		message: 'Are you sure you want to delete this project and all its messages?',
		confirmLabel: 'Delete',
		danger: true
	})
	if (confirmed) await videoStore.deleteThread(id)
}

const fail = (title: string, message: string, tone: 'error' | 'warning' = 'error') => dialog.notify({ title, message, tone })

// ----- Video road -----
/**
 * A blank timeline when no file is given. The literal 'Untitled Project' is
 * what makes createMediaAsset derive a clean title from the filename
 * (Lecture_3.mp4 -> "Lecture 3"). Preparing the footage runs in the editor.
 */
const createVideo = async (file?: { path: string; name?: string }) => {
	if (isCreating.value) return
	if (file && !ffmpegAvailable.value) {
		await fail('FFmpeg is required', 'FFmpeg is required to process video. Install it and restart the app.', 'warning')
		return
	}
	isCreating.value = true
	try {
		const thread = await api.createEditorProject('Untitled Project')
		if (!thread) throw new Error('The timeline project could not be created.')
		videoStore.threads.unshift(thread)
		if (file) {
			try {
				// Awaited: it is one ffprobe, and an unreadable file is reported here rather than in a blank editor.
				await api.addMediaAsset({ threadId: thread.id, filePath: file.path, name: file.name })
			} catch (e: any) {
				// The project exists and is in Recent now: still open it.
				await fail('Could not read that video', e?.message || 'The file could not be imported. You can add it again from the editor.', 'warning')
			}
		}
		await router.push(`/editor/${thread.id}`)
		focusChatSoon()
	} catch (e: any) {
		await fail('Could not create the project', e?.message || 'Something went wrong while setting up your project.')
	} finally {
		isCreating.value = false
	}
}

const addVideo = async () => {
	const picked = await api.selectVideo()
	if (picked?.path) await createVideo({ path: picked.path, name: picked.name || picked.path.split('/').pop() })
}

// ----- Images road -----
const titleFor = (imagePaths: string[], videoName?: string): string => {
	const first = imagePaths[0]?.split('/').pop() || videoName
	return first ? `Edit: ${first}` : 'Image Collection'
}

/** The graph thread copies the images in; the chat there is where the prompt goes. */
const createImage = async (images: string[] = [], video?: DroppedFile) => {
	if (isCreating.value) return
	isCreating.value = true
	try {
		const thread = await videoStore.createThread(video?.path, titleFor(images, video?.name), images, 'image')
		await router.push(`/chat/${thread.id}`)
		focusChatSoon()
	} catch (e: any) {
		await fail('Could not create the project', e?.message || 'Something went wrong while setting up your project.')
	} finally {
		isCreating.value = false
	}
}

const addImages = async () => {
	const result = await api.showOpenDialog({
		title: 'Select images',
		properties: ['openFile', 'multiSelections'],
		filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
	})
	if (result && !result.canceled && result.filePaths.length) await createImage(result.filePaths)
}

// ----- Drop -----
const setDrag = (road: Road, over: boolean) => {
	if (over) { dropRoad.value = road; dropError[road] = '' }
	else if (dropRoad.value === road) dropRoad.value = null
}

const onDrop = async (road: Road, files: DroppedFile[]) => {
	dropRoad.value = null
	const plan = planDrop(road, files)
	if (!plan.ok) { dropError[road] = plan.reason; return }
	if (road === 'video') await createVideo(plan.video)
	else await createImage(plan.images.map((f) => f.path), plan.video)
}

onMounted(async () => {
	try {
		await Promise.all([videoStore.fetchThreads(), engineStore.load(), audioStore.load()])
		if (welcome.value) {
			home.value = (await api.setupState()).home
			folder.value = await api.getTempDir()
		}
	} finally {
		loading.value = false
	}
})
</script>
