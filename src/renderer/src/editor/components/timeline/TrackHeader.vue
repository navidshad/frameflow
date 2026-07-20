<template>
	<div class="flex items-center justify-between px-2 border-b border-zinc-200/60 dark:border-zinc-800/60"
		:style="{ height: `${track.height}px` }">
		<span class="text-[9px] font-bold uppercase tracking-widest"
			:class="track.hidden ? 'text-zinc-300 dark:text-zinc-700' : 'text-zinc-500'">
			{{ track.name }}
		</span>
		<div class="flex items-center gap-0.5">
			<button class="w-5 h-5 flex items-center justify-center rounded transition"
				:class="track.muted ? 'text-red-500 bg-red-500/10' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'"
				:title="track.muted ? 'Unmute track' : 'Mute track'"
				@click="store.toggleTrackFlag(track.id, 'muted')">
				<span :class="track.muted ? 'iconify tabler--volume-off' : 'iconify tabler--volume'" class="w-3 h-3"></span>
			</button>
			<button class="w-5 h-5 flex items-center justify-center rounded transition"
				:class="track.locked ? 'text-amber-500 bg-amber-500/10' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'"
				:title="track.locked ? 'Unlock track' : 'Lock track'"
				@click="store.toggleTrackFlag(track.id, 'locked')">
				<span :class="track.locked ? 'iconify tabler--lock' : 'iconify tabler--lock-open'" class="w-3 h-3"></span>
			</button>
			<button class="w-5 h-5 flex items-center justify-center rounded transition"
				:class="track.hidden ? 'text-zinc-600 dark:text-zinc-300 bg-zinc-500/10' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'"
				:title="track.hidden ? 'Show track' : 'Hide track'"
				@click="store.toggleTrackFlag(track.id, 'hidden')">
				<span :class="track.hidden ? 'iconify tabler--eye-off' : 'iconify tabler--eye'" class="w-3 h-3"></span>
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import type { Track } from '@shared/types'
import { useEditorStore } from '../../../stores/editorStore'

defineProps<{ track: Track }>()
const store = useEditorStore()
</script>
