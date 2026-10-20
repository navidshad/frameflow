<template>
	<!-- `data-track-header` names which lane this row drives. The lane has
	     `data-track-id`; the row that controls it had nothing, so anything
	     addressing a track's controls had to guess from the label text. -->
	<div class="flex items-center justify-between px-2 border-b border-zinc-200/60 dark:border-zinc-800/60"
		:class="motion ? 'bg-pink-500/[0.04]' : ''"
		:data-track-header="track.id"
		:style="{ height: `${track.height}px` }">
		<!-- Lanes open under this track (board 2): a chevron that folds them
		     away, and how many there are, in place of the track's buttons. -->
		<template v-if="lanesOpen">
			<button class="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest"
				:class="motion ? 'text-pink-400' : 'text-zinc-500'"
				title="Hide keyframe lanes" aria-label="Hide keyframe lanes"
				@click="kf.toggle()">
				<span class="iconify tabler--chevron-down w-2.5 h-2.5"></span>{{ track.name }}
			</button>
			<span class="font-mono text-[8px] text-zinc-500">{{ kf.lanes.length }} lane{{ kf.lanes.length === 1 ? '' : 's' }}</span>
		</template>
		<!-- A motion lane says so in its own colour: pink is motion everywhere. -->
		<span v-else-if="motion" class="flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest"
			:class="track.hidden ? 'text-pink-400/40' : 'text-pink-400'">
			<span class="iconify tabler--sparkles w-[11px] h-[11px]"></span>{{ track.name }}
		</span>
		<span v-else class="text-[9px] font-bold uppercase tracking-widest"
			:class="track.hidden ? 'text-zinc-300 dark:text-zinc-700' : 'text-zinc-500'">
			{{ track.name }}
		</span>
		<div v-if="!lanesOpen" class="flex items-center gap-0.5">
			<!-- No mute on a motion lane: a page has no sound to mute. -->
			<button v-if="!motion" class="w-5 h-5 flex items-center justify-center rounded transition"
				:class="track.muted ? 'text-red-500 bg-red-500/10' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'"
				:title="track.muted ? 'Unmute track' : 'Mute track'"
				@click="store.toggleTrackFlag(track.id, 'muted')">
				<span :class="track.muted ? 'iconify tabler--volume-off' : 'iconify tabler--volume'" class="w-3 h-3"></span>
			</button>
			<button v-if="track.kind === 'audio'"
				class="w-5 h-5 flex items-center justify-center rounded transition"
				:class="track.role === 'music'
					? 'text-secondary bg-secondary/10'
					: 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'"
				:title="track.role === 'music'
					? 'Music bed — ducks under speech. Click to make it a normal track.'
					: 'Make this a music bed, so it ducks under speech'"
				@click="store.toggleTrackMusic(track.id)">
				<span class="iconify tabler--music w-3 h-3"></span>
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
			<button v-if="store.canRemoveTrack(track.id)"
				class="w-5 h-5 flex items-center justify-center rounded transition
				       text-zinc-300 dark:text-zinc-700 hover:text-red-500 hover:bg-red-500/10"
				:title="`Delete ${track.name} and everything on it`"
				@click="store.removeTrack(track.id)">
				<span class="iconify tabler--trash w-3 h-3"></span>
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Track } from '@shared/types'
import { isMotionTrack } from '@shared/motion'
import { useEditorStore } from '../../../stores/editorStore'
import { useKeyframeLanesStore } from '../../../stores/keyframeLanesStore'

const props = defineProps<{ track: Track }>()
const store = useEditorStore()
const kf = useKeyframeLanesStore()
const motion = computed(() => isMotionTrack(props.track))
const lanesOpen = computed(() => kf.expanded && kf.item?.trackId === props.track.id)
</script>
