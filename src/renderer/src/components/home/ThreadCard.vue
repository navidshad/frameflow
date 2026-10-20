<template>
	<!-- A project is a row in a list, not a card. -->
	<div class="group flex items-center gap-3.5 h-14 hair-b transition-colors outline-none focus-visible:bg-primary/5"
		:class="isLegacy
			? 'cursor-default opacity-60'
			: 'cursor-pointer hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.03]'"
		:role="isLegacy ? undefined : 'link'" :tabindex="isLegacy ? undefined : 0"
		@click="!isLegacy && $emit('open', thread.id)"
		@keydown.enter.self="!isLegacy && $emit('open', thread.id)">
		<!-- Icon tile -->
		<span class="w-[30px] h-[30px] rounded-md shrink-0 flex items-center justify-center" :class="kind.tile">
			<span class="iconify w-4 h-4" :class="kind.icon"></span>
		</span>

		<!-- Title + last message -->
		<div class="flex-1 min-w-0">
			<div class="font-semibold text-[13px] truncate transition-colors" :class="isLegacy ? '' : 'group-hover:text-primary'">{{ thread.title }}</div>
			<div class="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{{ getLastMessage(thread) }}</div>
		</div>

		<!-- Without the kind the only way to tell a timeline project from a video
		     project in a mixed list is to click it. -->
		<span class="w-[84px] shrink-0 text-[10px] font-bold uppercase tracking-[.1em]" :class="kind.text">{{ kind.label }}</span>

		<span class="w-[120px] shrink-0 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">{{ formatDate(thread.updatedAt) }}</span>

		<span class="w-16 shrink-0 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums flex items-center gap-1.5" title="Messages">
			<span class="iconify tabler--message w-3.5 h-3.5"></span>{{ thread.messages.length }}
		</span>

		<span class="w-16 shrink-0 text-right font-mono text-xs text-zinc-600 dark:text-zinc-300">${{ getThreadTotals(thread).cost.toFixed(4) }}</span>

		<!-- Flags -->
		<span class="w-[110px] shrink-0 flex items-center justify-end gap-2.5 text-[11px] font-semibold whitespace-nowrap">
			<span v-if="thread.versionCounter && thread.type !== 'editor'" class="text-primary">v.{{ thread.versionCounter }}</span>
			<span v-if="thread.missing" class="text-red-500 dark:text-red-400"
				title="Artifacts folder not found. Some media or generated files may be unavailable.">Missing Files</span>
			<span v-if="isLegacy" class="text-amber-600 dark:text-amber-400"
				title="Made by the retired AI video pipeline. Video editing now happens in a timeline project.">Unsupported</span>
		</span>

		<button @click.stop="$emit('delete', thread.id)"
			class="btn-icon shrink-0 hover:!text-red-500 hover:!bg-red-500/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
			title="Delete project" aria-label="Delete project">
			<span class="iconify tabler--trash w-4 h-4"></span>
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { isLegacyVideoThread } from '@shared/legacy'

const props = defineProps<{
	thread: any
}>()

defineEmits(['open', 'delete'])

/** Threads written before `type` existed read back undefined — those are video. */
const KINDS = {
	video: { label: 'Video', icon: 'tabler--movie', tile: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', text: 'text-amber-600 dark:text-amber-400' },
	image: { label: 'Images', icon: 'tabler--photo', tile: 'bg-secondary/15 text-secondary-dark dark:text-secondary-light', text: 'text-secondary-dark dark:text-secondary-light' },
	editor: { label: 'Timeline', icon: 'tabler--timeline', tile: 'bg-primary/15 text-primary', text: 'text-primary' }
} as const

const kind = computed(() => KINDS[props.thread.type as keyof typeof KINDS] || KINDS.video)

/** Retired AI-video threads: listed and deletable, but not openable. */
const isLegacy = computed(() => isLegacyVideoThread(props.thread))

const formatDate = (timestamp: number) => {
	return new Date(timestamp).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	})
}

const getLastMessage = (thread: any) => {
	if (thread.messages.length === 0) return 'No messages yet'
	const lastMsg = thread.messages[thread.messages.length - 1]
	return lastMsg.content
}

const getThreadTotals = (thread: any) => {
	return thread.messages.reduce(
		(acc: { tokens: number; cost: number }, msg: any) => {
			acc.tokens += msg.usage?.totalTokens || 0
			acc.cost += msg.cost || 0
			return acc
		},
		{ tokens: 0, cost: 0 }
	)
}
</script>
