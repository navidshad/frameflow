<template>
	<div class="space-y-2">
		<!-- The agent's opening: its goal for the round, on the asking side like a
		     prompt, but violet and named, because the asker is not the user. -->
		<div v-if="round.kind === 'round'" class="flex flex-col items-end gap-1">
			<div class="max-w-[88%] px-3 py-2 rounded-2xl rounded-br-md bg-secondary/[0.12] border border-secondary/25 text-xs leading-relaxed text-zinc-800 dark:text-zinc-100">
				<div class="flex items-center gap-1.5 mb-0.5 text-[10px] font-bold text-violet-700 dark:text-violet-300">
					<span class="iconify tabler--terminal-2 w-3 h-3"></span>
					{{ round.clientName }} · round {{ round.seq }}
				</div>
				<p class="whitespace-pre-wrap">{{ round.goal || (round.implicit ? 'Started editing without saying what for.' : 'No goal given.') }}</p>
			</div>
			<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400 flex items-center gap-1">
				<span class="text-secondary">via MCP</span>
				<span v-if="round.implicit">· opened by FrameFlow</span>
				<span>{{ hhmm(round.startedAt) }}</span>
			</span>
		</div>

		<!-- FrameFlow's side: every request the agent made and what it answered. -->
		<div class="flex items-start gap-2">
			<span class="w-5 h-5 mt-0.5 rounded-md shrink-0 flex items-center justify-center bg-zinc-500/10 text-zinc-400">
				<span class="iconify tabler--movie w-3 h-3"></span>
			</span>
			<div class="flex-1 min-w-0 rounded-2xl rounded-tl-md bg-zinc-100 dark:bg-zinc-900 px-2.5 py-2">
				<div class="flex items-center gap-2 px-0.5 pb-1">
					<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400 truncate">
						<template v-if="round.kind === 'loose'">{{ round.clientName }} · outside a round</template>
						<template v-else>{{ stats.steps }} request{{ stats.steps === 1 ? '' : 's' }}</template>
					</span>
					<span v-if="working" class="w-2.5 h-2.5 rounded-full border-[1.5px] border-secondary-light border-t-transparent animate-spin shrink-0"></span>
					<span class="flex-1"></span>
					<button v-if="hidden > 0" class="text-[9px] font-bold uppercase tracking-widest text-zinc-400 hover:text-primary transition"
						@click="showAll = true">Show all {{ round.calls.length }}</button>
					<button v-else-if="showAll && round.calls.length > COLLAPSED" class="text-[9px] font-bold uppercase tracking-widest text-zinc-400 hover:text-primary transition"
						@click="showAll = false">Show fewer</button>
				</div>
				<p v-if="!round.calls.length" class="px-0.5 py-1 text-[10px] text-zinc-500">Waiting for its first request…</p>
				<p v-else-if="hidden > 0" class="px-0.5 pb-1 text-[10px] text-zinc-500">{{ hidden }} earlier request{{ hidden === 1 ? '' : 's' }} hidden</p>

				<div v-for="call in shown" :key="call.id"
					class="group rounded-lg px-1.5 py-1.5 border-t border-zinc-200/70 dark:border-zinc-800/80 cursor-pointer hover:bg-zinc-500/5"
					:aria-expanded="open.has(call.id)" @click="toggle(call.id)">
					<div class="flex items-center gap-1.5 min-w-0">
						<span v-if="call.status === 'running'" class="w-2.5 h-2.5 rounded-full border-[1.5px] border-secondary-light border-t-transparent animate-spin shrink-0"></span>
						<span v-else class="iconify w-3 h-3 shrink-0" :class="statusIcon(call)"></span>
						<span class="font-mono text-[10px] font-bold text-zinc-700 dark:text-zinc-200 truncate">{{ call.title }}</span>
						<span class="flex-1"></span>
						<span class="font-mono text-[8px] text-zinc-400 shrink-0">{{ call.status === 'running' ? 'now' : took(call) }}</span>
					</div>
					<!-- What the agent asked -->
					<p v-if="call.ask" class="mt-0.5 font-mono text-[9px] leading-snug text-violet-600/90 dark:text-violet-300/80 break-all"
						:class="open.has(call.id) ? 'whitespace-pre-wrap' : 'line-clamp-1'">
						<span class="select-none opacity-60">→ </span>{{ call.ask }}
					</p>
					<p v-if="call.quote" class="mt-0.5 text-[10px] leading-snug text-zinc-500 italic">“{{ call.quote }}”</p>
					<!-- What FrameFlow answered -->
					<p v-if="answerOf(call)" class="mt-0.5 text-[10px] leading-snug break-words"
						:class="[
							call.status === 'error' ? 'text-red-500' : call.status === 'refused' ? 'text-amber-500' : 'text-zinc-600 dark:text-zinc-400',
							open.has(call.id) ? 'whitespace-pre-wrap' : 'line-clamp-2'
						]">
						<span class="select-none opacity-60">← </span>{{ open.has(call.id) ? call.answer || call.detail : answerOf(call) }}
					</p>
					<img v-if="call.image" :src="imageUrl(call.image)" alt="" loading="lazy"
						class="mt-1 rounded-md bg-zinc-800 object-cover" :class="open.has(call.id) ? 'w-full' : 'w-32 h-[72px]'" />
					<div v-if="call.chips?.length" class="flex flex-wrap gap-1 mt-1">
						<span v-for="chip in call.chips" :key="chip.text"
							class="px-1.5 py-px rounded font-mono text-[9px] font-bold" :class="CHIP_TONES[chip.tone]">{{ chip.text }}</span>
					</div>
				</div>
			</div>
		</div>

		<!-- The agent's closing words, and how the round went -->
		<div v-if="round.kind === 'round' && !working" class="flex flex-col items-end gap-1">
			<div v-if="round.summary"
				class="max-w-[88%] px-3 py-2 rounded-2xl rounded-br-md bg-secondary/[0.12] border border-secondary/25 text-xs leading-relaxed text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap">{{ round.summary }}</div>
			<span class="max-w-full text-right text-[9px] font-bold uppercase tracking-widest leading-relaxed"
				:class="round.status === 'done' ? 'text-zinc-400' : 'text-amber-500'">
				{{ ROUND_STATUS_LABEL[round.status] }}<span class="text-zinc-400"> · {{ stats.steps }} step{{ stats.steps === 1 ? '' : 's' }} · {{ elapsedClock(stats.durationMs) }}</span><span v-if="stats.firstRevision" class="text-secondary"> · {{ stats.firstRevision === stats.lastRevision ? stats.firstRevision : `${stats.firstRevision} → ${stats.lastRevision}` }}</span>
			</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AgentChipTone } from '@shared/agentFeed'
import { elapsedClock, roundStats, ROUND_STATUS_LABEL, type AgentCallRecord, type AgentRound } from '@shared/agentRounds'
import { toMediaUrl } from '@shared/media-url'
import { useAgentStore } from '../../stores/agentStore'

/**
 * One MCP agent's round in the chat: what it set out to do, every request it
 * made and what FrameFlow answered, and how it ended. Read-only: the
 * conversation is the agent's with FrameFlow, and the user watches it. A row
 * opens to the full request and answer.
 */

const props = defineProps<{ round: AgentRound }>()
const agent = useAgentStore()

/** Rows shown before "Show all": the newest. A working round shows more. */
const COLLAPSED = 4
const showAll = ref(false)
const working = computed(() => props.round.status === 'working')
const limit = computed(() => (showAll.value ? Infinity : working.value ? 8 : COLLAPSED))
const shown = computed(() => props.round.calls.slice(-limit.value))
const hidden = computed(() => props.round.calls.length - shown.value.length)
const stats = computed(() => roundStats(props.round, agent.now))

const open = ref(new Set<string>())
const toggle = (id: string) => {
	const next = new Set(open.value)
	if (next.has(id)) next.delete(id)
	else next.add(id)
	open.value = next
}

const hhmm = (t: number) => {
	const d = new Date(t)
	return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

const took = (call: AgentCallRecord) => {
	if (!call.endedAt) return hhmm(call.startedAt)
	const ms = call.endedAt - call.startedAt
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

/** The short answer: the feed's phrase when there is one, else the reply text. */
const answerOf = (call: AgentCallRecord) => call.detail || call.answer || ''

const imageUrl = (image: string) => (image.startsWith('data:') ? image : toMediaUrl(image))

const statusIcon = (call: AgentCallRecord) => {
	if (call.status === 'error') return 'tabler--x text-red-500'
	if (call.status === 'refused') return 'tabler--lock text-amber-500'
	if (call.tool === 'apply_ops' || call.tool === 'revert_to_version' || call.tool === 'make_multicam') return 'tabler--pencil text-primary-light'
	if (call.tool === 'render_frame' || call.tool === 'inspect_export' || call.tool === 'get_angles') return 'tabler--camera text-emerald-500'
	if (call.tool === 'export' || call.tool === 'import_media') return 'tabler--file-export text-primary-light'
	return 'tabler--check text-emerald-500'
}

const CHIP_TONES: Record<AgentChipTone, string> = {
	violet: 'bg-secondary/15 text-secondary-light',
	red: 'bg-red-500/10 text-red-500',
	green: 'bg-emerald-500/10 text-emerald-500',
	blue: 'bg-primary/10 text-primary-light',
	zinc: 'bg-zinc-500/15 text-zinc-400'
}
</script>
