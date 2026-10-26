<template>
	<div class="mb-1.5 p-3 rounded-xl transition cursor-pointer group"
		:class="reading
			? 'bg-violet-500/10 ring-1 ring-violet-500/35'
			: active
				? 'bg-primary/5 dark:bg-primary/10 ring-1 ring-primary/30'
				: 'hover:bg-zinc-100/70 dark:hover:bg-zinc-900/50'"
		:draggable="canPlace"
		:title="canPlace ? 'Drag onto the timeline to place the whole file' : undefined"
		@click="$emit('select')"
		@dragstart="onDragStart">
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
					<!-- Board 3: the media an agent is reading right now -->
					<span v-if="reading"
						class="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400">
						Agent reading
					</span>
					<!-- State chip: the plain piece count once everything is done -->
					<span v-else-if="!usesLanes || readiness.settled || asset.preprocessState === 'error' || !readiness.placeable"
						class="text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded"
						:class="stateChipClass">
						{{ stateLabel }}
					</span>
				</div>
				<!-- What is ready, in plain words: placeable now, transcript, proxy, colours -->
				<div v-if="usesLanes && !readiness.settled && readiness.chips.length" class="flex flex-wrap items-center gap-1 mt-1"
					data-testid="asset-readiness">
					<span v-for="chip in readiness.chips" :key="chip.text"
						class="text-[9px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap"
						:class="chipToneClass(chip.tone)">
						{{ chip.text }}
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

		<!-- Per-lane progress: the transcript and the picture run side by side, each with its own bars -->
		<template v-if="usesLanes">
			<div v-for="row in laneRows" :key="row.lane">
				<div v-if="row.status === 'running' && row.tasks.length" class="mt-2 space-y-1.5" :data-testid="`lane-${row.lane}`">
					<div v-for="task in row.tasks" :key="task.id" class="flex items-center gap-2">
						<span class="text-[9px] font-bold uppercase tracking-widest w-20 shrink-0 truncate"
							:class="task.state === 'pending' ? 'text-zinc-300 dark:text-zinc-600' : 'text-zinc-400'">
							{{ stepName(task) }}
						</span>
						<div class="flex-1 h-1 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden relative">
							<div v-if="task.state === 'running' && task.progress === undefined"
								class="absolute inset-0 rounded-full bg-gradient-to-r from-transparent via-primary/70 to-transparent animate-indeterminate">
							</div>
							<div v-else class="h-full rounded-full transition-all duration-300"
								:class="task.state === 'error' ? 'bg-red-500' : task.state === 'completed' ? 'bg-accent' : 'bg-primary'"
								:style="{ width: `${task.state === 'completed' ? 100 : task.progress ?? 0}%` }"></div>
						</div>
					</div>
				</div>

				<!-- This lane was interrupted (app quit mid-run); the other one is unaffected -->
				<div v-else-if="row.status === 'interrupted'" class="mt-2 flex items-center justify-between gap-2">
					<p class="text-[11px] text-amber-600 dark:text-amber-400 font-medium">{{ row.label }} was interrupted.</p>
					<button
						class="px-2 py-1 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-widest hover:bg-amber-500/20 transition"
						@click.stop="editorStore.retryAsset(asset.id, undefined, row.lane)">
						Resume
					</button>
				</div>

				<!-- This lane failed; the other one went on -->
				<div v-else-if="row.status === 'error' && asset.prepLanes" class="mt-2">
					<p class="text-[11px] text-red-500 font-medium leading-snug line-clamp-2">
						{{ row.label }}: {{ row.error || 'failed.' }}
					</p>
					<div class="mt-1.5 flex items-center gap-2">
						<button
							class="px-2 py-1 rounded-lg bg-red-500/10 text-red-500 text-[10px] font-bold uppercase tracking-widest hover:bg-red-500/20 transition"
							@click.stop="editorStore.retryAsset(asset.id, undefined, row.lane)">
							Retry
						</button>
					</div>
				</div>
			</div>
		</template>

		<!-- Sound has one chain, no lanes -->
		<template v-else>
			<div v-if="asset.preprocessState === 'running' && !interrupted" class="mt-2 space-y-1.5">
				<div v-for="task in runningTasks" :key="task.id" class="flex items-center gap-2">
					<span class="text-[9px] font-bold uppercase tracking-widest w-20 shrink-0 truncate"
						:class="task.state === 'pending' ? 'text-zinc-300 dark:text-zinc-600' : 'text-zinc-400'">
						{{ stepName(task) }}
					</span>
					<div class="flex-1 h-1 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden relative">
						<div v-if="task.state === 'running' && task.progress === undefined"
							class="absolute inset-0 rounded-full bg-gradient-to-r from-transparent via-primary/70 to-transparent animate-indeterminate">
						</div>
						<div v-else class="h-full rounded-full transition-all duration-300"
							:class="task.state === 'error' ? 'bg-red-500' : task.state === 'completed' ? 'bg-accent' : 'bg-primary'"
							:style="{ width: `${task.state === 'completed' ? 100 : task.progress ?? 0}%` }"></div>
					</div>
				</div>
			</div>
			<div v-if="interrupted" class="mt-2 flex items-center justify-between gap-2">
				<p class="text-[11px] text-amber-600 dark:text-amber-400 font-medium">Processing was interrupted.</p>
				<button
					class="px-2 py-1 rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-widest hover:bg-amber-500/20 transition"
					@click.stop="editorStore.retryAsset(asset.id)">
					Resume
				</button>
			</div>
		</template>

		<!-- Transcript failed but the import went on without it -->
		<p v-if="(asset.preprocessState === 'completed' || wordsDone) && asset.transcriptError"
			class="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400 font-medium leading-snug line-clamp-2"
			:title="asset.transcriptError">
			<span class="iconify tabler--alert-triangle w-3 h-3 inline-block align-[-1px]"></span>
			No transcript: {{ asset.transcriptError }}
		</p>

		<!-- Error state -->
		<div v-if="asset.preprocessState === 'error' && (!usesLanes || !asset.prepLanes)" class="mt-2">
			<p class="text-[11px] text-red-500 font-medium leading-snug line-clamp-2">
				{{ asset.preprocessError || 'Preprocessing failed.' }}
			</p>
			<div class="mt-1.5 flex items-center gap-2">
				<button
					class="px-2 py-1 rounded-lg bg-red-500/10 text-red-500 text-[10px] font-bold uppercase tracking-widest hover:bg-red-500/20 transition"
					@click.stop="editorStore.retryAsset(asset.id)">
					Retry
				</button>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { toMediaUrl } from '@shared/media-url'
import { computed } from 'vue'
import type { BackgroundTask, MediaAsset } from '@shared/types'
import { LANE_LABEL, PREP_LANES, laneOfStep, laneRecord, laneStatus, mediaReadiness, type ChipTone } from '@shared/mediaPrep'
import { useEditorStore } from '../../stores/editorStore'
import { useAgentStore } from '../../stores/agentStore'

const props = defineProps<{
	asset: MediaAsset
	active: boolean
}>()

defineEmits<{ (e: 'select'): void }>()

const editorStore = useEditorStore()
const agentStore = useAgentStore()
const reading = computed(() => agentStore.isReading(props.asset))

const interrupted = computed(() => editorStore.interruptedAssets.has(props.asset.id))
const interruptedLanes = computed(() => editorStore.interruptedLanes[props.asset.id] ?? [])

const runningTasks = computed<BackgroundTask[]>(() => editorStore.assetTasks(props.asset.id))

// A video imports as two lanes side by side (transcript, picture); sound has one chain.
const usesLanes = computed(() => props.asset.kind === 'video')

const proxyPercent = computed(() => {
	const proxy = runningTasks.value.find((t) => t.id.endsWith(':proxy') && t.state === 'running')
	return proxy?.progress
})

const readiness = computed(() => mediaReadiness(props.asset, { interrupted: interruptedLanes.value, proxyPercent: proxyPercent.value }))

const wordsDone = computed(() => laneRecord(props.asset, 'words')?.state === 'completed')

const laneRows = computed(() => PREP_LANES.map((lane) => ({
	lane,
	label: LANE_LABEL[lane],
	status: laneStatus(props.asset, lane, !interruptedLanes.value.includes(lane)),
	error: laneRecord(props.asset, lane)?.error,
	tasks: runningTasks.value.filter((t) => laneOfStep(stepOf(t)) === lane)
})))

const stepOf = (task: BackgroundTask) => task.id.split(':')[1] || task.name

const chipToneClass = (tone: ChipTone) => ({
	good: 'bg-accent/10 text-accent',
	busy: 'bg-primary/10 text-primary',
	warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
	bad: 'bg-red-500/10 text-red-500'
}[tone])

const thumbSrc = computed(() => {
	const thumb = props.asset.clips.find((c) => c.thumbnailPath)?.thumbnailPath
	return thumb ? toMediaUrl(thumb) : null
})

// Only a probed asset with a real duration can be dropped as a whole-file item.
const canPlace = computed(() => (props.asset.metadata?.duration || 0) > 0)

const onDragStart = (event: DragEvent) => {
	if (!event.dataTransfer || !canPlace.value) return
	event.dataTransfer.setData('application/x-frameflow-asset', props.asset.id)
	event.dataTransfer.setData(`application/x-frameflow-kind-${props.asset.kind === 'audio' ? 'audio' : 'video'}`, '1')
	event.dataTransfer.effectAllowed = 'copy'
}

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

const stepName = (task: BackgroundTask) => stepOf(task)

const formatDuration = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	return `${m}:${String(s).padStart(2, '0')}`
}

</script>
