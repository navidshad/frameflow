<template>
	<header class="h-10 shrink-0 flex items-center gap-3 px-3 hair-b">
		<SlimTooltip text="Back to Home" placement="bottom">
			<button class="w-7 h-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-primary hover:bg-primary/10 transition"
				aria-label="Back to Home" @click="$emit('back')">
				<span class="iconify tabler--chevron-left w-4 h-4"></span>
			</button>
		</SlimTooltip>

		<!-- Click the title to rename in place -->
		<input v-if="renaming" ref="titleInput" v-model="draft"
			class="font-heading font-semibold text-[15px] tracking-tight min-w-[160px] max-w-[320px] bg-transparent border-b border-primary/60 outline-none"
			@keydown.enter.prevent="commitRename" @keydown.esc.prevent="renaming = false" @blur="commitRename" />
		<button v-else class="group/title flex items-center gap-1.5 min-w-0 max-w-[320px]" title="Rename project" @click="startRename">
			<span class="font-heading font-semibold text-[15px] tracking-tight truncate">{{ title || 'Untitled Project' }}</span>
			<span class="iconify tabler--pencil w-3 h-3 text-zinc-400 opacity-0 group-hover/title:opacity-100 transition shrink-0"></span>
		</button>

		<span v-if="totalCost > 0" class="font-mono text-[11px] text-zinc-500 tabular-nums"
			title="What this project has cost in AI usage">${{ totalCost.toFixed(4) }}</span>

		<!-- Live status: an agent is editing over MCP -->
		<slot name="center" />

		<div class="flex-1"></div>

		<!-- Background exports of OTHER projects (this project's own is the Export button) -->
		<GlobalRenderPill />

		<span v-if="agent.access?.enabled" class="flex items-center gap-1.5 text-[11px] text-zinc-500"
			title="Agents can reach this project over MCP">
			<span class="w-1.5 h-1.5 rounded-full bg-accent-light"></span>Agent access on
		</span>
		<SlimTooltip text="Settings" placement="bottom">
			<button class="w-7 h-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-primary hover:bg-primary/10 transition"
				aria-label="Settings" @click="router.push('/settings')">
				<span class="iconify tabler--settings w-4 h-4"></span>
			</button>
		</SlimTooltip>
		<SlimTooltip :text="isDark ? 'Switch to light theme' : 'Switch to dark theme'" placement="bottom">
			<button class="w-7 h-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-primary hover:bg-primary/10 transition"
				:aria-label="isDark ? 'Switch to light theme' : 'Switch to dark theme'" @click="toggle">
				<span class="iconify w-4 h-4" :class="isDark ? 'tabler--sun' : 'tabler--moon'"></span>
			</button>
		</SlimTooltip>

		<button v-if="showExport"
			class="h-[26px] px-3.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition active:scale-95"
			:class="exporting
				? 'bg-primary/15 text-primary'
				: canExport
					? 'bg-primary text-white hover:bg-primary-dark'
					: 'bg-zinc-200/70 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed'"
			:disabled="!canExport && !exporting"
			:title="canExport || exporting ? 'Export the timeline' : 'Add clips to the timeline first'"
			@click="$emit('export')">
			<span v-if="!exporting" class="iconify tabler--file-export w-3.5 h-3.5"></span>
			{{ exporting ? `Exporting ${percent}%` : 'Export' }}
		</button>
	</header>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import SlimTooltip from '../../components/SlimTooltip.vue'
import GlobalRenderPill from '../../components/GlobalRenderPill.vue'
import { useAgentStore } from '../../stores/agentStore'
import { useTheme } from '../../composables/useTheme'

/**
 * The editor's 40px bar: back, title, cost, then — right — agent access,
 * settings, theme and Export. It replaces the shared GraphHeader here, which
 * left room for an absolutely-placed cluster that this screen no longer has:
 * the chat column runs the full height of the window, so nothing may sit over
 * its top-right corner.
 */
const props = defineProps<{
	title?: string
	totalCost: number
	showExport: boolean
	canExport: boolean
	exporting: boolean
	percent: number
}>()
const emit = defineEmits<{
	(e: 'back'): void
	(e: 'rename', value: string): void
	(e: 'export'): void
}>()

const router = useRouter()
const agent = useAgentStore()
const { isDark, toggle } = useTheme()

const renaming = ref(false)
const draft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

const startRename = async () => {
	draft.value = props.title || ''
	renaming.value = true
	await nextTick()
	titleInput.value?.focus()
	titleInput.value?.select()
}

const commitRename = () => {
	if (!renaming.value) return // blur fires after Enter/Esc already closed it
	renaming.value = false
	const next = draft.value.trim()
	if (next && next !== props.title) emit('rename', next)
}
</script>
