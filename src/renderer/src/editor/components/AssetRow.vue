<template>
	<div class="mb-1.5 p-3 rounded-xl transition cursor-pointer group"
		:class="active
			? 'bg-primary/5 dark:bg-primary/10 ring-1 ring-primary/30'
			: 'hover:bg-zinc-100/70 dark:hover:bg-zinc-900/50'"
		@click="$emit('select')">
		<div class="flex items-start gap-3">
			<!-- Thumbnail -->
			<div
				class="w-16 h-10 rounded-lg bg-zinc-200 dark:bg-zinc-800 overflow-hidden shrink-0 flex items-center justify-center">
				<img v-if="thumbSrc" :src="thumbSrc" class="w-full h-full object-cover" loading="lazy" />
				<span v-else class="iconify w-4 h-4 text-zinc-400"
					:class="asset.kind === 'audio' ? 'tabler--music' : 'tabler--movie'"></span>
			</div>

			<div class="flex-1 min-w-0">
				<p class="text-xs font-bold text-zinc-800 dark:text-zinc-200 truncate">{{ asset.name }}</p>
				<div class="flex items-center gap-2 mt-0.5">
					<span v-if="asset.metadata" class="text-[10px] font-mono text-zinc-500">
						{{ formatDuration(asset.metadata.duration) }}
					</span>
					<span v-if="asset.metadata?.hasAudio"
						class="iconify tabler--volume w-3 h-3 text-zinc-400" title="Has audio"></span>
					<!-- State chip -->
					<span class="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded"
						:class="stateChipClass">
						{{ stateLabel }}
					</span>
				</div>
			</div>

			<!-- Remove -->
			<button
				class="w-6 h-6 flex items-center justify-center rounded-lg text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-500/10 transition shrink-0"
				title="Remove media"
				@click.stop="editorStore.removeAsset(asset.id)">
				<span class="iconify tabler--trash w-3.5 h-3.5"></span>
			</button>
		</div>

		<!-- Per-step progress bars while running -->
		<div v-if="asset.preprocessState === 'running' && !interrupted" class="mt-2 space-y-1.5">
			<div v-for="task in runningTasks" :key="task.id" class="flex items-center gap-2">
				<span class="text-[9px] font-bold uppercase tracking-widest w-20 shrink-0 truncate"
					:class="task.state === 'pending' ? 'text-zinc-300 dark:text-zinc-600' : 'text-zinc-400'">
					{{ stepName(task) }}
				</span>
				<div class="flex-1 h-1 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden relative">
					<!-- Indeterminate shimmer: running with no measurable percent (e.g. scene detection) -->
					<div v-if="task.state === 'running' && task.progress === undefined"
						class="absolute inset-0 rounded-full bg-gradient-to-r from-transparent via-primary/70 to-transparent animate-indeterminate">
					</div>
					<div v-else class="h-full rounded-full transition-all duration-300"
						:class="task.state === 'error' ? 'bg-red-500' : task.state === 'completed' ? 'bg-accent' : 'bg-primary'"
						:style="{ width: `${task.state === 'completed' ? 100 : task.progress ?? 0}%` }"></div>
				</div>
			</div>
		</div>

		<!-- Interrupted (app quit mid-run) -->
		<div v-if="interrupted" class="mt-2 flex items-center justify-between gap-2">
			<p class="text-[11px] text-amber-600 dark:text-amber-400 font-medium">Processing was interrupted.</p>
			<button
				class="px-2 py-1 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-widest hover:bg-amber-500/20 transition"
				@click.stop="editorStore.retryAsset(asset.id)">
				Resume
			</button>
		</div>

		<!-- Error state -->
		<div v-if="asset.preprocessState === 'error'" class="mt-2">
			<p class="text-[11px] text-red-500 font-medium leading-snug line-clamp-2">
				{{ asset.preprocessError || 'Preprocessing failed.' }}
			</p>
			<div class="mt-1.5 flex items-center gap-2">
				<button
					class="px-2 py-1 rounded-lg bg-red-500/10 text-red-500 text-[10px] font-bold uppercase tracking-widest hover:bg-red-500/20 transition"
					@click.stop="editorStore.retryAsset(asset.id)">
					Retry
				</button>
				<button v-if="isScenedetectMissing"
					class="px-2 py-1 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-widest hover:bg-amber-500/20 transition"
					@click.stop="installScenedetect">
					Install scene detection
				</button>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { BackgroundTask, MediaAsset } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'

const props = defineProps<{
	asset: MediaAsset
	active: boolean
}>()

defineEmits<{ (e: 'select'): void }>()

const editorStore = useEditorStore()

const interrupted = computed(() => editorStore.interruptedAssets.has(props.asset.id))

const runningTasks = computed<BackgroundTask[]>(() => editorStore.assetTasks(props.asset.id))

const thumbSrc = computed(() => {
	const thumb = props.asset.clips.find((c) => c.thumbnailPath)?.thumbnailPath
	return thumb ? `media://${thumb}` : null
})

const isScenedetectMissing = computed(() =>
	(props.asset.preprocessError || '').includes('scenedetect-missing') || !editorStore.deps.scenedetect
)

const stateLabel = computed(() => {
	if (interrupted.value) return 'paused'
	switch (props.asset.preprocessState) {
		case 'running': return 'processing'
		case 'completed': return `${props.asset.clips.length} pieces`
		case 'error': return 'error'
		default: return 'pending'
	}
})

const stateChipClass = computed(() => {
	if (interrupted.value) return 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
	switch (props.asset.preprocessState) {
		case 'running': return 'bg-primary/10 text-primary'
		case 'completed': return 'bg-accent/10 text-accent'
		case 'error': return 'bg-red-500/10 text-red-500'
		default: return 'bg-zinc-500/10 text-zinc-500'
	}
})

const stepName = (task: BackgroundTask) => task.id.split(':')[1] || task.name

const formatDuration = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	return `${m}:${String(s).padStart(2, '0')}`
}

const installScenedetect = async () => {
	try {
		await (window as any).api.installDependency('scenedetect')
	} catch (error) {
		console.error('Failed to start scenedetect install:', error)
	}
}
</script>
