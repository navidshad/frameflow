<template>
	<SettingsSection title="Agent access"
		description="Let an agent in your terminal read and edit the project you have open, over MCP.">
		<!-- Off / On -->
		<div class="flex gap-3.5" role="radiogroup" aria-label="Agent access">
			<button v-for="opt in ([false, true] as const)" :key="String(opt)" role="radio" :aria-checked="enabled === opt"
				class="tab-u !h-7" :class="{ 'tab-u-active': enabled === opt }"
				:disabled="busy" @click="setEnabled(opt)">{{ opt ? 'On' : 'Off' }}</button>
		</div>

		<p v-if="state?.error" class="mt-3 text-xs text-red-500">{{ state.error }}</p>

		<!-- Address + token -->
		<div class="grid grid-cols-2 gap-10 mt-4 max-sm:grid-cols-1">
			<div>
				<span class="lbl block mb-1.5">Address</span>
				<div class="flex items-center gap-2">
					<span class="font-mono text-xs truncate">{{ address }}</span>
					<span class="w-1.5 h-1.5 rounded-full shrink-0" :class="state?.running ? 'bg-accent-light' : 'bg-zinc-500'"></span>
				</div>
				<span class="block text-[11px] text-zinc-500 mt-1.5">
					{{ state?.running ? 'Only this computer can connect.' : 'Off: nothing is listening.' }}
				</span>
			</div>
			<div>
				<span class="lbl block mb-1.5">Access token</span>
				<div class="flex items-center gap-3">
					<span class="font-mono text-xs truncate">{{ state?.tokenMasked }}</span>
					<button class="btn-text btn-text-primary !h-auto !px-0 !text-[11px]" @click="copy('token')">{{ copied === 'token' ? 'Copied' : 'Copy' }}</button>
					<button class="btn-text btn-text-primary !h-auto !px-0 !text-[11px]" @click="newToken">New token</button>
				</div>
				<span class="block text-[11px] text-zinc-500 mt-1.5">A new token disconnects every agent.</span>
			</div>
		</div>

		<!-- Connect snippets -->
		<div class="mt-6">
			<span class="lbl block">Connect your agent</span>
			<div class="flex gap-3.5 mt-1">
				<button v-for="c in CLIENTS" :key="c.kind" class="tab-u !h-7" :class="{ 'tab-u-active': client === c.kind }"
					@click="client = c.kind">{{ c.label }}</button>
			</div>
			<div class="mt-2 py-2.5 hair-t hair-b flex gap-3 items-start">
				<code class="flex-1 font-mono text-[11px] leading-[1.7] text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-all">{{ snippet }}</code>
			</div>
			<p class="mt-1.5 text-[11px] text-zinc-500">
				{{ CONNECT_HINTS[client] }}
				<button class="btn-text btn-text-primary !h-auto !px-1 !text-[11px] align-baseline" @click="copy('snippet')">{{ copied === 'snippet' ? 'Copied' : 'Copy' }}</button>
			</p>
		</div>

		<!-- Permissions -->
		<div class="mt-6">
			<span class="lbl block mb-1">What agents can do</span>
			<div class="flex gap-2.5 py-[7px]">
				<span class="w-4 h-4 mt-px rounded bg-primary/50 text-white flex items-center justify-center shrink-0" title="Always on while agent access is on">
					<span class="iconify tabler--lock w-2.5 h-2.5"></span>
				</span>
				<span>
					<span class="block font-semibold text-xs">Read the open project, media, transcripts and frames</span>
					<span class="block text-[11px] text-zinc-500 dark:text-zinc-400">Always on while agent access is on.</span>
				</span>
			</div>
			<button v-for="p in PERMISSIONS" :key="p.key" role="checkbox" :aria-checked="!!state?.permissions[p.key]"
				class="w-full text-left flex gap-2.5 py-[7px]" @click="togglePermission(p.key)">
				<span v-if="state?.permissions[p.key]" class="w-4 h-4 mt-px rounded bg-primary text-white flex items-center justify-center shrink-0">
					<span class="iconify tabler--check w-3 h-3"></span>
				</span>
				<span v-else class="w-4 h-4 mt-px rounded border border-zinc-400 dark:border-zinc-600 shrink-0"></span>
				<span>
					<span class="block font-semibold text-xs">{{ p.title }}</span>
					<span class="block text-[11px] text-zinc-500 dark:text-zinc-400">{{ state?.permissions[p.key] ? p.on : p.off }}</span>
				</span>
			</button>
		</div>

		<!-- Recent sessions -->
		<div class="mt-6">
			<span class="lbl block mb-2">Recent agent sessions</span>
			<div class="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,1fr)_48px] gap-x-3 text-[10px] font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 pb-1.5">
				<span>Agent</span><span>Project</span><span>When</span><span class="text-right">Steps</span>
			</div>
			<div v-for="row in rows" :key="row.key"
				class="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,1fr)_48px] gap-x-3 items-baseline py-2 hair-t text-xs">
				<span class="font-semibold truncate">
					{{ row.clientName }}
					<span v-if="row.live" class="ml-1.5 text-[9px] font-bold uppercase text-accent">Live</span>
				</span>
				<span class="truncate text-zinc-600 dark:text-zinc-300">{{ row.project }}</span>
				<span class="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{{ when(row.startedAt) }}</span>
				<span class="font-mono text-right text-zinc-600 dark:text-zinc-300">{{ row.steps }}</span>
			</div>
			<div v-if="!rows.length" class="py-2 hair-t text-xs text-zinc-500">No agent has connected yet.</div>
		</div>
	</SettingsSection>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CONNECT_HINTS, connectSnippet, type AgentClientKind, type AgentPermissions } from '@shared/agent'
import { useAgentStore } from '../../stores/agentStore'
import { dialog } from '../../composables/useDialog'
import SettingsSection from './SettingsSection.vue'

/**
 * Settings → Agent access (board 4, lower card): the switch, where to connect,
 * the connect command per CLI, what an agent may do, and who has been here.
 *
 * The real token stays in main. This card shows it masked and asks main to put
 * it on the clipboard, so it never sits in the renderer's memory or DOM.
 */

const api = (window as any).api
const agent = useAgentStore()
const state = computed(() => agent.access)
const enabled = computed(() => !!state.value?.enabled)
const busy = ref(false)

const CLIENTS: { kind: AgentClientKind; label: string }[] = [
	{ kind: 'claude', label: 'Claude Code' },
	{ kind: 'codex', label: 'Codex' }
]
const client = ref<AgentClientKind>('claude')

const PERMISSIONS: { key: keyof AgentPermissions; title: string; on: string; off: string }[] = [
	{
		key: 'edit', title: 'Edit the timeline',
		on: 'Each change is saved as a revision you can undo or go back from.',
		off: 'Off: an agent can read and suggest, and you make the change.'
	},
	{
		key: 'html', title: 'Write custom HTML motion layers',
		on: 'Runs sandboxed with no network, and must pass the motion checks before it renders.',
		off: 'Off: agents can only use the built-in motion templates.'
	},
	{
		key: 'sound', title: 'Make sounds with the built-in synth',
		on: 'Recipes only: free, offline, nothing is spent. Each sound is part of the revision you can undo.',
		off: 'Off: an agent can describe the sounds it would add, and you add them from the Sound tab.'
	},
	{
		key: 'export', title: 'Export videos to disk',
		on: 'An agent can start an export; it lands in the project’s exports folder.',
		off: 'Off: an agent can ask, and you press Export.'
	}
]

const address = computed(() => state.value?.url || 'http://127.0.0.1:47615/mcp')
const snippet = computed(() => connectSnippet(client.value, address.value, state.value?.tokenShort || 'ff_••••'))

const copied = ref<'token' | 'snippet' | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | undefined
const copy = async (what: 'token' | 'snippet') => {
	if (what === 'token') await api.copyAgentToken()
	else await api.copyAgentSnippet(client.value)
	copied.value = what
	clearTimeout(copiedTimer)
	copiedTimer = setTimeout(() => { copied.value = null }, 1500)
}

const setEnabled = async (on: boolean) => {
	if (on === enabled.value) return
	busy.value = true
	try {
		agent.access = await api.setAgentAccessEnabled(on)
	} finally {
		busy.value = false
	}
}

const newToken = async () => {
	const live = agent.sessions.length
	if (live) {
		const ok = await dialog.confirm({
			title: 'New access token',
			message: `A new token disconnects ${live === 1 ? 'the connected agent' : `all ${live} connected agents`}. Continue?`,
			confirmLabel: 'New token',
			danger: true
		})
		if (!ok) return
	}
	agent.access = await api.newAgentToken()
}

const togglePermission = async (key: keyof AgentPermissions) => {
	agent.access = await api.setAgentPermission(key, !state.value?.permissions[key])
}

/** Live sessions first, then the remembered ones. */
const rows = computed(() => {
	const live = (state.value?.sessions || []).map((s) => ({
		key: s.id, clientName: s.clientName, project: s.project || '—', startedAt: s.connectedAt, steps: s.steps, live: true
	}))
	const past = (state.value?.recent || []).map((r, i) => ({ key: `r${i}`, ...r, live: false }))
	return [...live, ...past]
})

const when = (t: number) => {
	const d = new Date(t)
	const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
	const today = new Date()
	const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
	if (d.toDateString() === today.toDateString()) return `today ${time}`
	if (d.toDateString() === yesterday.toDateString()) return `yesterday ${time}`
	return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

onMounted(() => agent.refresh())
</script>
