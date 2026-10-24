<template>
	<SectionHeader title="General" description="Where FrameFlow keeps your work." />

	<SettingsGroup title="Projects folder">
		<SettingsRow title="Location" description="Projects, imported media, renders and the cache." top>
			<div class="field font-mono text-xs break-all !h-auto min-h-[34px] py-2">{{ tempDir || 'Loading…' }}</div>
			<div v-if="unsafe" class="strip strip-warn mt-2.5 text-[11px] text-amber-600 dark:text-amber-400">
				<span>
					<b class="font-semibold">Unstable storage location.</b>
					This folder may be cleared by the OS. Use a persistent folder to keep your projects safe.
				</span>
			</div>
			<div class="mt-2 flex gap-4">
				<button class="btn-text btn-text-primary !px-0" @click="change">Change location</button>
				<button class="btn-text btn-text-primary !px-0" @click="api.openTempDir()">Open folder</button>
				<button class="btn-text !px-0" @click="reset">Reset to default</button>
			</div>
		</SettingsRow>
	</SettingsGroup>

	<SettingsGroup title="Data">
		<SettingsRow title="Delete all data"
			description="Permanently delete all chats, video summaries, and cached files. This action cannot be undone.">
			<button class="h-[34px] px-3.5 rounded text-xs font-semibold text-red-500 dark:text-red-400 ring-1 ring-inset ring-red-400/50 hover:bg-red-500/10"
				@click="deleteAll">Delete all data</button>
		</SettingsRow>
	</SettingsGroup>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useVideoStore } from '../../stores/videoStore'
import { dialog } from '../../composables/useDialog'
import SectionHeader from './SectionHeader.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingsRow from './SettingsRow.vue'

const api = (window as any).api
const router = useRouter()
const videoStore = useVideoStore()
const tempDir = ref('')
const unsafe = ref(false)

const refresh = async () => {
	tempDir.value = await api.getTempDir()
	unsafe.value = await api.isTempDirUnsafe()
}

/** A new folder holds different projects, so reload them and go home. */
const moved = async (result: string | null | undefined) => {
	if (!result) return
	await refresh()
	await videoStore.fetchThreads()
	router.push('/home')
}
const change = async () => moved(await api.setTempDir())
const reset = async () => moved(await api.resetTempDir())

const deleteAll = async () => {
	const ok = await dialog.confirm({
		title: 'Delete all data',
		message: 'Are you sure you want to delete all data? This cannot be undone.',
		confirmLabel: 'Delete all data',
		danger: true
	})
	if (!ok) return
	await videoStore.deleteAllThreads()
	await dialog.notify({ title: 'Data deleted', message: 'All data deleted successfully.', tone: 'success' })
}

onMounted(refresh)
</script>
