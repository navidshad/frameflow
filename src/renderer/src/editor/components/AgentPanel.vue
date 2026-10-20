<template>
	<section class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<template v-if="session">
			<!-- Connected client -->
			<div class="flex items-center gap-2.5 px-4 pt-3.5 pb-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
				<div class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center shrink-0 text-secondary-light bg-secondary/[0.12] border border-secondary/25">
					<span class="iconify tabler--terminal w-[18px] h-[18px]"></span>
				</div>
				<div class="flex-1 min-w-0">
					<div class="text-xs font-bold text-zinc-800 dark:text-zinc-200 truncate">{{ session.clientName }}</div>
					<div class="font-mono text-[9px] text-zinc-500 truncate">{{ subtitle }}</div>
				</div>
				<span v-if="live"
					class="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 text-[9px] font-bold uppercase">Live</span>
				<span v-else
					class="px-1.5 py-0.5 rounded bg-zinc-500/15 text-zinc-400 text-[9px] font-bold uppercase">Ended</span>
			</div>

			<!-- Another client connected at the same time -->
			<div v-if="agent.sessions.length > 1" class="flex gap-1 px-4 pt-2 shrink-0">
				<button v-for="s in agent.sessions" :key="s.id"
					class="px-2 py-0.5 rounded-lg text-[9px] font-bold uppercase tracking-widest transition"
					:class="s.id === session.id ? 'bg-secondary/10 text-secondary-light' : 'text-zinc-400 hover:text-zinc-300'"
					@click="pinned = s.id">{{ s.clientName }}</button>
			</div>

			<!-- Activity feed -->
			<div ref="feedRef" class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 py-1">
				<p v-if="!feed.length" class="text-[10px] text-zinc-500 py-3">Connected. Waiting for its first step…</p>
				<div v-for="(row, i) in feed" :key="row.id"
					class="grid grid-cols-[20px_minmax(0,1fr)_auto] gap-2 items-start py-[7px]"
					:class="i < feed.length - 1 ? 'border-b border-zinc-200 dark:border-zinc-800/60' : ''">
					<div class="w-5 h-5 rounded-md flex items-center justify-center" :class="iconTone(row)">
						<div v-if="row.status === 'running'"
							class="w-2.5 h-2.5 rounded-full border-2 border-secondary-light border-t-transparent animate-spin"></div>
						<span v-else class="iconify w-[11px] h-[11px]" :class="iconFor(row)"></span>
					</div>
					<div class="min-w-0">
						<div class="font-mono text-[10px] font-bold text-zinc-800 dark:text-zinc-200 truncate">{{ row.title }}</div>
						<img v-if="row.thumbnail" :src="row.thumbnail" alt=""
							class="mt-1 w-28 h-[63px] rounded-md object-cover bg-zinc-800" />
						<div v-if="row.detail" class="text-[10px] leading-snug mt-0.5"
							:class="row.status === 'error' ? 'text-red-400' : row.status === 'refused' ? 'text-amber-400' : 'text-zinc-500 dark:text-zinc-400'">
							{{ row.detail }}
						</div>
						<div v-if="row.quote" class="text-[10px] leading-snug mt-0.5 text-zinc-500 dark:text-zinc-400">“{{ row.quote }}”</div>
						<div v-if="row.chips?.length" class="flex flex-wrap gap-1 mt-1">
							<span v-for="chip in row.chips" :key="chip.text"
								class="px-1.5 py-0.5 rounded font-mono text-[9px] font-bold" :class="CHIP_TONES[chip.tone]">{{ chip.text }}</span>
						</div>
					</div>
					<span class="font-mono text-[8px] text-zinc-500 pt-[3px]">{{ row.status === 'running' ? 'now' : hhmm(row.startedAt) }}</span>
				</div>
			</div>

			<!-- Footer -->
			<div class="px-4 pt-2.5 pb-3 border-t border-zinc-200 dark:border-zinc-800 flex flex-col gap-2 shrink-0">
				<p class="m-0 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
					You can keep editing while it works; the agent sees your changes the next time it reads the timeline. Every step it takes lands as a revision.
				</p>
				<div class="flex gap-1.5">
					<button
						class="flex-1 px-3 py-1.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 flex items-center justify-center gap-1.5 transition hover:border-primary/40 hover:text-primary disabled:opacity-40 disabled:pointer-events-none"
						:disabled="!baseline"
						:title="baseline ? `Return to V${baseline.seq}, the version before ${session.clientName}’s first edit` : 'The agent has not edited anything yet'"
						@click="goBack">
						<span class="iconify tabler--arrow-back-up w-3.5 h-3.5"></span>
						Back to V{{ baseline?.seq ?? '–' }}
					</button>
					<button
						class="flex-1 px-3 py-1.5 rounded-xl border border-red-900/40 text-xs font-bold text-red-500 transition hover:bg-red-500/10 disabled:opacity-40 disabled:pointer-events-none"
						:disabled="!live" @click="agent.disconnect(session.id)">
						Disconnect
					</button>
				</div>
			</div>
		</template>

		<!-- Nobody has connected this run -->
		<div v-else class="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6">
			<div class="w-[34px] h-[34px] rounded-[10px] flex items-center justify-center text-zinc-400 bg-zinc-500/10 border border-zinc-500/20">
				<span class="iconify tabler--terminal w-[18px] h-[18px]"></span>
			</div>
			<p class="text-xs font-bold text-zinc-600 dark:text-zinc-300">No agent connected</p>
			<p class="text-[10px] leading-snug text-zinc-500">
				{{ agent.access?.enabled
					? 'Agent access is on. Connect Claude Code or Codex with the command in Settings.'
					: 'Let an agent in your terminal edit this project over MCP. Turn it on in Settings → Agent access.' }}
			</p>
			<button class="mt-1 px-3 py-1.5 rounded-xl border border-zinc-300 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 transition hover:border-primary/40 hover:text-primary"
				@click="router.push('/settings')">Open Settings</button>
		</div>
	</section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { AgentActivity, AgentChipTone } from '@shared/agentFeed'
import { useAgentStore } from '../../stores/agentStore'
import { useEditorStore } from '../../stores/editorStore'

/**
 * The Agent tab: who is connected over MCP and what it has done, one row per
 * tool call (board 3). Read-only apart from the two footer buttons; the edits
 * themselves are ordinary revisions, so everything else happens elsewhere.
 */

const agent = useAgentStore()
const editor = useEditorStore()
const router = useRouter()

/** Which of several concurrent sessions to show; defaults to the most active. */
const pinned = ref<string | null>(null)
const session = computed(() =>
	(pinned.value && agent.sessions.find((s) => s.id === pinned.value)) || agent.shownSession
)
const live = computed(() => agent.isLive(session.value?.id))
const feed = computed(() => agent.feedFor(session.value?.id))
const baseline = computed(() => agent.baselineRevision(session.value?.id))

const hhmm = (t: number) => {
	const d = new Date(t)
	return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

const subtitle = computed(() => {
	const s = session.value
	if (!s) return ''
	const where = s.root || (s.clientVersion ? `v${s.clientVersion}` : 'via MCP')
	return `${where} · connected ${hhmm(s.connectedAt)}`
})

const CHIP_TONES: Record<AgentChipTone, string> = {
	violet: 'bg-secondary/15 text-secondary-light',
	red: 'bg-red-500/10 text-red-500',
	green: 'bg-emerald-500/10 text-emerald-400',
	blue: 'bg-primary/10 text-primary-light',
	zinc: 'bg-zinc-500/15 text-zinc-400'
}

/** Colour says what KIND of step it was: looking, editing, rendering, motion. */
const kindOf = (tool: string): 'read' | 'search' | 'edit' | 'frame' | 'motion' | 'revert' | 'export' => {
	if (tool.includes('motion')) return 'motion'
	if (tool === 'search_moments') return 'search'
	if (tool === 'render_frame') return 'frame'
	if (tool === 'revert_to_version') return 'revert'
	if (tool === 'export') return 'export'
	if (tool.startsWith('get_')) return 'read'
	return 'edit'
}

const ICONS = {
	read: 'tabler--eye', search: 'tabler--search', edit: 'tabler--pencil', frame: 'tabler--camera',
	motion: 'tabler--sparkles', revert: 'tabler--arrow-back-up', export: 'tabler--file-export'
}

const iconFor = (row: AgentActivity) => (row.status === 'refused' ? 'tabler--lock' : ICONS[kindOf(row.tool)])

const iconTone = (row: AgentActivity) => {
	if (row.status === 'running') return 'bg-secondary/[0.12]'
	if (row.status === 'refused') return 'bg-amber-500/[0.12] text-amber-400'
	if (row.status === 'error') return 'bg-red-500/[0.12] text-red-400'
	switch (kindOf(row.tool)) {
		case 'edit': case 'export': return 'bg-primary/[0.12] text-primary-light'
		case 'frame': return 'bg-emerald-500/[0.12] text-emerald-400'
		case 'motion': return 'bg-pink-500/[0.12] text-pink-400'
		case 'revert': return 'bg-secondary/[0.12] text-secondary-light'
		default: return 'bg-zinc-500/[0.12] text-zinc-400'
	}
}

const goBack = async () => {
	if (baseline.value) await editor.switchRevision(baseline.value.id)
}

// Follow the feed like the chat follows its turns
const feedRef = ref<HTMLElement | null>(null)
watch(() => feed.value.length, async () => {
	await nextTick()
	if (feedRef.value) feedRef.value.scrollTop = feedRef.value.scrollHeight
})
</script>
