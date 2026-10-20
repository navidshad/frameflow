<template>
	<!-- The lanes' names, beside the rows KeyframeLanes draws. A filled ◆ means
	     the lane has keys; clicking it adds one at the playhead. -->
	<div data-keyframe-lane-headers>
		<div v-for="lane in kf.lanes" :key="lane.path"
			class="flex items-center justify-between pl-[18px] pr-1.5 box-border border-b border-zinc-200/40 dark:border-zinc-800/40"
			:class="kf.primary?.path === lane.path ? 'bg-primary/[0.08]' : ''"
			:style="{ height: `${LANE_ROW_PX}px` }">
			<span class="text-[9px] font-bold uppercase tracking-widest truncate"
				:class="lane.own
					? 'text-pink-400'
					: kf.primary?.path === lane.path
						? 'text-zinc-800 dark:text-zinc-200'
						: kf.keysOn(lane.path).length ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-500'">
				{{ lane.label }}
			</span>
			<button class="w-4 h-4 flex items-center justify-center rounded transition hover:bg-primary/10"
				:aria-label="`Add a ${lane.label.toLowerCase()} key at the playhead`"
				:title="`Add a ${lane.label.toLowerCase()} key at the playhead`"
				@click="kf.addAtPlayhead(lane.path)">
				<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true"
					:fill="kf.keysOn(lane.path).length ? (lane.own ? '#f472b6' : '#60a5fa') : 'none'"
					:stroke="kf.keysOn(lane.path).length ? 'none' : '#52525b'"
					stroke-width="2" stroke-linejoin="round"><path d="M12 3l9 9-9 9-9-9z" /></svg>
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { LANE_ROW_PX } from '@shared/keyframeLanes'
import { useKeyframeLanesStore } from '../../../stores/keyframeLanesStore'

const kf = useKeyframeLanesStore()
</script>
