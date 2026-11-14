<template>
	<header class="topbar h-10 shrink-0 min-w-0 flex items-center gap-3 px-3 hair-b">
		<SlimTooltip text="Back to Home" placement="bottom">
			<button class="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-zinc-500 hover:text-primary hover:bg-primary/10 transition"
				aria-label="Back to Home" @click="$emit('back')">
				<span class="iconify tabler--chevron-left w-4 h-4"></span>
			</button>
		</SlimTooltip>

		<!-- Click the title to rename in place -->
		<input v-if="renaming" ref="titleInput" v-model="draft"
			class="font-heading font-semibold text-[15px] tracking-tight min-w-[80px] w-[320px] shrink bg-transparent border-b border-primary/60 outline-none"
			@keydown.enter.prevent="commitRename" @keydown.esc.prevent="renaming = false" @blur="commitRename" />
		<button v-else class="group/title flex items-center gap-1.5 min-w-0 max-w-[320px]" title="Rename project" @click="startRename">
			<span class="font-heading font-semibold text-[15px] tracking-tight truncate">{{ title || 'Untitled Project' }}</span>
			<span class="iconify tabler--pencil w-3 h-3 text-zinc-400 opacity-0 group-hover/title:opacity-100 transition shrink-0"></span>
		</button>

		<span v-if="totalCost > 0" class="tb-cost shrink-0 whitespace-nowrap font-mono text-[11px] text-zinc-500 tabular-nums"
			title="What this project has cost in AI usage">${{ totalCost.toFixed(4) }}</span>

		<!-- Live status: an agent is editing over MCP -->
		<slot name="center" />

		<div class="flex-1 min-w-0"></div>

		<!-- Everything right of here keeps its size: the title is what gives way, and
		     the container query below drops labels (never controls) as the bar narrows. -->
		<!-- Background exports of OTHER projects (this project's own is the Export button) -->
		<GlobalRenderPill />

		<!-- Light | Pro: how much of the editor is out. It is a control, so no width hides it. -->
		<div ref="modeGroup" class="flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800/60 shrink-0"
			role="radiogroup" aria-label="Editor mode" @keydown="onModeKey">
			<SlimTooltip v-for="option in MODES" :key="option.id" :text="option.hint" placement="bottom">
				<button type="button" role="radio" :aria-checked="mode === option.id" :tabindex="mode === option.id ? 0 : -1"
					class="py-[3px] px-2.5 rounded-md text-[10px] leading-4 font-semibold whitespace-nowrap transition"
					:class="mode === option.id
						? 'bg-white dark:bg-zinc-700 text-zinc-800 dark:text-white shadow-sm'
						: 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'"
					:data-editor-mode="option.id" @click="setMode(option.id)">{{ option.label }}</button>
			</SlimTooltip>
		</div>

		<span v-if="agent.access?.enabled" class="shrink-0 whitespace-nowrap h-7 flex items-center gap-1.5 text-[11px] text-zinc-500"
			title="Agent access is on: agents can reach this project over MCP">
			<span class="w-1.5 h-1.5 rounded-full bg-accent-light"></span><span class="tb-wide">Agent access on</span>
		</span>
		<SlimTooltip text="Settings" placement="bottom">
			<button class="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-zinc-500 hover:text-primary hover:bg-primary/10 transition"
				aria-label="Settings" @click="router.push('/settings')">
				<span class="iconify tabler--settings w-4 h-4"></span>
			</button>
		</SlimTooltip>
		<SlimTooltip :text="isDark ? 'Switch to light theme' : 'Switch to dark theme'" placement="bottom">
			<button class="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-zinc-500 hover:text-primary hover:bg-primary/10 transition"
				:aria-label="isDark ? 'Switch to light theme' : 'Switch to dark theme'" @click="toggle">
				<span class="iconify w-4 h-4" :class="isDark ? 'tabler--sun' : 'tabler--moon'"></span>
			</button>
		</SlimTooltip>

		<!-- The background pre-render of motion layers, so the long part of an export is
		     visibly being done before the button is pressed. -->
		<SlimTooltip v-if="showExport && motionDrawing && !exporting"
			:text="`Drawing motion layers in the background so Export is faster: ${motionDrawing.done} of ${motionDrawing.total} ready`"
			placement="bottom">
			<span class="h-[22px] shrink-0 whitespace-nowrap px-2 rounded-md bg-zinc-100 dark:bg-zinc-800 text-[10px] font-semibold text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5 tabular-nums">
				<span class="w-2.5 h-2.5 rounded-full border-2 border-primary border-t-transparent animate-spin"></span>
				<span class="tb-mid">Motion</span>{{ motionDrawing.done }}/{{ motionDrawing.total }}
			</span>
		</SlimTooltip>

		<SlimTooltip v-if="showExport" :text="thumbnailBusy ? 'Making the thumbnail project…' : canThumbnail ? 'New thumbnail project from this video' : 'Add a video first'" placement="bottom">
			<button
				class="h-[26px] shrink-0 whitespace-nowrap px-2.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition active:scale-95 text-zinc-600 dark:text-zinc-300 hover:text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-zinc-600"
				:disabled="!canThumbnail || thumbnailBusy" aria-label="Generate thumbnail" @click="$emit('thumbnail')">
				<span class="iconify w-3.5 h-3.5" :class="thumbnailBusy ? 'tabler--loader-2 animate-spin' : 'tabler--photo-star'"></span>
				<span class="tb-mid">Thumbnail</span>
			</button>
		</SlimTooltip>

		<button v-if="showExport"
			class="h-[26px] shrink-0 whitespace-nowrap px-3.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition active:scale-95"
			:class="exporting
				? 'bg-primary/15 text-primary'
				: canExport
					? 'bg-primary text-white hover:bg-primary-dark'
					: 'bg-zinc-200/70 dark:bg-zinc-800 text-zinc-400 cursor-not-allowed'"
			:disabled="!canExport && !exporting"
			:title="exporting ? 'Export the timeline' : lockedBy ? `${lockedBy} is working on this project over MCP: export when its round ends` : canExport ? 'Export the timeline' : 'Add clips to the timeline first'"
			@click="$emit('export')">
			<span v-if="!exporting" class="iconify w-3.5 h-3.5" :class="lockedBy ? 'tabler--lock' : 'tabler--file-export'"></span>
			{{ exporting ? (editorStore.cancelling ? 'Stopping…' : `Exporting ${percent}%${etaShort}`) : 'Export' }}
		</button>
	</header>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import SlimTooltip from '../../components/SlimTooltip.vue'
import GlobalRenderPill from '../../components/GlobalRenderPill.vue'
import { useAgentStore } from '../../stores/agentStore'
import { useEditorStore } from '../../stores/editorStore'
import { useTheme } from '../../composables/useTheme'
import { useEditorMode, type EditorMode } from '../editorMode'

/**
 * The editor's 40px bar: back, title, cost, then — right — the Light | Pro
 * switch, agent access, settings, theme and Export. It replaces the shared
 * GraphHeader here, which left room for an absolutely-placed cluster that this
 * screen no longer has: the chat column runs the full height of the window, so
 * nothing may sit over its top-right corner.
 */
const props = defineProps<{
	title?: string
	totalCost: number
	showExport: boolean
	canExport: boolean
	exporting: boolean
	percent: number
	/** An MCP agent holding the project: the button says why it is off. */
	lockedBy?: string | null
	/** There is a picture to take a frame from. */
	canThumbnail?: boolean
	/** The thumbnail project is being built. */
	thumbnailBusy?: boolean
}>()
const editorStore = useEditorStore()
/** The pre-render of this project's motion layers, while it is drawing. */
const motionDrawing = computed(() => {
	const p = editorStore.motionPrerender
	return p && p.running && p.threadId === editorStore.threadId ? p : null
})
/** " · 14 min" beside the percent, once there is an estimate worth showing. */
const etaShort = computed(() => {
	const sec = editorStore.renderState?.etaSec
	if (sec == null || sec < 10) return ''
	return sec < 90 ? ` · ${Math.round(sec / 5) * 5} s` : sec < 5400 ? ` · ${Math.round(sec / 60)} min` : ` · ${(sec / 3600).toFixed(1)} h`
})
const emit = defineEmits<{
	(e: 'back'): void
	(e: 'rename', value: string): void
	(e: 'export'): void
	(e: 'thumbnail'): void
}>()

const router = useRouter()
const agent = useAgentStore()
const { isDark, toggle } = useTheme()

// ===== Light | Pro =====
const { mode, setMode } = useEditorMode()
const MODES: { id: EditorMode; label: string; hint: string }[] = [
	{ id: 'light', label: 'Light', hint: 'The essentials: cut, trim, titles, captions, export' },
	{ id: 'pro', label: 'Pro', hint: 'Adds animation, transitions, effects and sound design' }
]
const modeGroup = ref<HTMLElement | null>(null)

/**
 * The switch is one stop in the tab order, and the arrows move inside it, as
 * in any group of radio buttons: the choice follows the focus. The key stops
 * here, because left and right are also the editor's step-a-frame shortcuts
 * and choosing a mode must not move the playhead.
 */
const onModeKey = async (event: KeyboardEvent) => {
	const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
		: event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
	if (!step || event.metaKey || event.ctrlKey || event.altKey) return
	event.preventDefault()
	event.stopPropagation()
	const at = MODES.findIndex((m) => m.id === mode.value)
	const next = MODES[(at + step + MODES.length) % MODES.length].id
	setMode(next)
	await nextTick()
	modeGroup.value?.querySelector<HTMLElement>(`[data-editor-mode="${next}"]`)?.focus()
}

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

<style scoped>
/* The bar is as wide as the window minus the chat column (684 px at the layout's
   tightest, see layout.ts), so it measures itself. The query reads the room
   inside the bar's padding, 24 px less than the bar: 660 at the tightest.
   With every label, a 240 px title, the Light | Pro switch and the motion pill
   it needs about 950 px. The title is what shrinks; before it has to, labels go
   in this order, and every control stays — the switch among them, which has no
   label to drop. The cost goes last, just above the tightest width, so the
   title keeps room to be read there. */
.topbar { container: topbar / inline-size; }
@container topbar (max-width: 960px) {
	.tb-wide { display: none; }
}
@container topbar (max-width: 840px) {
	.tb-mid { display: none; }
}
@container topbar (max-width: 700px) {
	.tb-cost { display: none; }
}
</style>
