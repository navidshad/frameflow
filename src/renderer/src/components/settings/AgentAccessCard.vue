<template>
	<Card
		class="!bg-white/90 dark:!bg-zinc-900/90 backdrop-blur-xl !rounded-lg border !border-zinc-200 dark:!border-zinc-700 !p-8">
		<!-- Header + Off/On -->
		<div class="flex items-center gap-5 mb-8">
			<div
				class="w-14 h-14 rounded-lg bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-500/20 shrink-0">
				<span class="iconify tabler--plug-connected w-7 h-7"></span>
			</div>
			<div>
				<h3 class="font-heading font-bold text-xl text-zinc-900 dark:text-white">Agent access</h3>
				<p class="text-sm text-zinc-500 dark:text-zinc-400 font-medium">Let an agent in your terminal read and edit the project you have open, over MCP.</p>
			</div>
			<div class="ml-auto flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800/60 shrink-0" role="radiogroup" aria-label="Agent access">
				<button v-for="opt in ([false, true] as const)" :key="String(opt)" role="radio" :aria-checked="enabled === opt"
					class="px-3.5 py-1.5 text-xs transition"
					:class="enabled === opt ? 'rounded-md bg-primary text-white font-bold' : 'font-semibold text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'"
					:disabled="busy" @click="setEnabled(opt)">{{ opt ? 'On' : 'Off' }}</button>
			</div>
		</div>

		<p v-if="state?.error" class="mb-4 text-xs text-red-500">{{ state.error }}</p>

		<!-- Address + token -->
		<div class="grid grid-cols-2 gap-3">
			<div class="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800">
				<span class="block text-[10px] font-bold uppercase tracking-[.1em] text-zinc-500 mb-1.5">Address</span>
				<div class="flex items-center gap-2">
					<span class="font-mono text-[13px] text-zinc-800 dark:text-zinc-200 truncate">{{ address }}</span>
					<span class="w-1.5 h-1.5 rounded-full shrink-0" :class="state?.running ? 'bg-emerald-500' : 'bg-zinc-500'"></span>
				</div>
				<span class="block text-[11px] text-zinc-500 mt-1.5">
					{{ state?.running ? 'Only this computer can connect.' : 'Off: nothing is listening.' }}
				</span>
			</div>
			<div class="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800">
				<span class="block text-[10px] font-bold uppercase tracking-[.1em] text-zinc-500 mb-1.5">Access token</span>
				<div class="flex items-center gap-2">
					<span class="font-mono text-[13px] text-zinc-800 dark:text-zinc-200 truncate">{{ state?.tokenMasked }}</span>
					<button class="ml-auto px-2 py-1 rounded-lg border border-zinc-300 dark:border-zinc-700 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 transition hover:border-primary/40 hover:text-primary"
						@click="copy('token')">{{ copied === 'token' ? 'Copied' : 'Copy' }}</button>
					<button class="px-2 py-1 rounded-lg border border-zinc-300 dark:border-zinc-700 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 transition hover:border-primary/40 hover:text-primary"
						@click="newToken">New token</button>
				</div>
				<span class="block text-[11px] text-zinc-500 mt-1.5">A new token disconnects every agent.</span>
			</div>
		</div>

		<!-- Connect snippets -->
		<div class="mt-6">
			<span class="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2.5">Connect your agent</span>
			<div class="flex gap-1 mb-2">
				<button v-for="c in CLIENTS" :key="c.kind"
					class="px-3 py-1.5 rounded-lg text-xs transition"
					:class="client === c.kind ? 'bg-primary/10 text-primary font-bold' : 'text-zinc-500 dark:text-zinc-400 font-semibold hover:text-zinc-700 dark:hover:text-zinc-200'"
					@click="client = c.kind">{{ c.label }}</button>
			</div>
			<div class="pl-5 pr-4 py-4 rounded-lg bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800 flex gap-3 items-start">
				<code class="flex-1 font-mono text-xs leading-[1.7] text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-all">{{ snippet }}</code>
				<button class="px-2.5 py-1.5 rounded-lg border border-zinc-300 dark:border-zinc-700 text-xs font-semibold text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5 transition hover:border-primary/40 hover:text-primary shrink-0"
					@click="copy('snippet')">
					<span class="iconify tabler--copy w-3.5 h-3.5"></span>{{ copied === 'snippet' ? 'Copied' : 'Copy' }}
				</button>
			</div>
			<p class="mt-2 text-xs text-zinc-500">{{ CONNECT_HINTS[client] }}</p>
		</div>

		<!-- Permissions -->
		<div class="mt-6">
			<span class="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2.5">What agents can do</span>
			<div class="rounded-lg bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800">
				<div class="grid grid-cols-[20px_minmax(0,1fr)] gap-3 items-start px-4 py-3.5 border-b border-zinc-200 dark:border-zinc-800">
					<span class="w-[18px] h-[18px] mt-px rounded-[5px] flex items-center justify-center bg-zinc-200 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
						<span class="iconify tabler--lock w-3 h-3"></span>
					</span>
					<span>
						<span class="block text-[13px] font-semibold text-zinc-800 dark:text-zinc-200">Read the open project, media, transcripts and frames</span>
						<span class="block text-xs text-zinc-500 mt-0.5">Always on while agent access is on.</span>
					</span>
				</div>
				<button v-for="(p, i) in PERMISSIONS" :key="p.key" role="checkbox" :aria-checked="!!state?.permissions[p.key]"
					class="w-full text-left grid grid-cols-[20px_minmax(0,1fr)] gap-3 items-start px-4 py-3.5"
					:class="i < PERMISSIONS.length - 1 ? 'border-b border-zinc-200 dark:border-zinc-800' : ''"
					@click="togglePermission(p.key)">
					<span v-if="state?.permissions[p.key]"
						class="w-[18px] h-[18px] mt-px rounded-[5px] flex items-center justify-center bg-primary text-white">
						<span class="iconify tabler--check w-3 h-3"></span>
					</span>
					<span v-else class="w-[18px] h-[18px] mt-px rounded-[5px] border border-zinc-400 dark:border-zinc-600"></span>
					<span>
						<span class="block text-[13px] font-semibold text-zinc-800 dark:text-zinc-200">{{ p.title }}</span>
						<span class="block text-xs text-zinc-500 mt-0.5">{{ state?.permissions[p.key] ? p.on : p.off }}</span>
					</span>
				</button>
			</div>
		</div>

		<!-- Recent sessions -->
		<div class="mt-6">
			<span class="block text-sm font-bold text-zinc-700 dark:text-zinc-300 mb-2.5">Recent agent sessions</span>
			<table class="w-full border-collapse text-[13px]">
				<!-- `!` beats pilotui's global table fill and padding, which the design does not have -->
				<thead>
					<tr class="!bg-transparent">
						<th class="text-left text-xs font-bold uppercase text-zinc-500 dark:text-zinc-400 !px-0 !pt-0 !pb-2.5">Agent</th>
						<th class="text-left text-xs font-bold uppercase text-zinc-500 dark:text-zinc-400 !px-0 !pt-0 !pb-2.5">Project</th>
						<th class="text-left text-xs font-bold uppercase text-zinc-500 dark:text-zinc-400 !px-0 !pt-0 !pb-2.5">When</th>
						<th class="!text-right text-xs font-bold uppercase text-zinc-500 dark:text-zinc-400 !px-0 !pt-0 !pb-2.5">Steps</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="row in rows" :key="row.key" class="border-t border-zinc-200 dark:border-zinc-800/50">
						<td class="!px-0 !py-3.5 font-bold text-zinc-900 dark:text-white">
							{{ row.clientName }}
							<span v-if="row.live"
								class="ml-1.5 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 text-[9px] font-bold uppercase">Live</span>
						</td>
						<td class="!px-0 !py-3.5 text-zinc-600 dark:text-zinc-300">{{ row.project }}</td>
						<td class="!px-0 !py-3.5 font-mono text-xs text-zinc-500 dark:text-zinc-400">{{ when(row.startedAt) }}</td>
						<td class="!px-0 !py-3.5 !text-right font-mono text-zinc-600 dark:text-zinc-300">{{ row.steps }}</td>
					</tr>
					<tr v-if="!rows.length" class="border-t border-zinc-200 dark:border-zinc-800/50">
						<td colspan="4" class="!px-0 !py-3.5 text-xs text-zinc-500">No agent has connected yet.</td>
					</tr>
				</tbody>
			</table>
		</div>
	</Card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Card } from 'pilotui/elements'
import { CONNECT_HINTS, connectSnippet, type AgentClientKind, type AgentPermissions } from '@shared/agent'
import { useAgentStore } from '../../stores/agentStore'

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
	{ kind: 'codex', label: 'Codex' },
	{ kind: 'gemini', label: 'Gemini CLI' }
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
	if (live && !confirm(`A new token disconnects ${live === 1 ? 'the connected agent' : `all ${live} connected agents`}. Continue?`)) return
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
