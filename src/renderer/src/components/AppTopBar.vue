<template>
	<header class="h-10 shrink-0 flex items-center gap-3 px-3 hair-b">
		<SlimTooltip v-if="showBack" text="Back" placement="bottom">
			<button class="btn-icon" aria-label="Back" @click="$emit('back')">
				<span class="iconify tabler--chevron-left w-4 h-4"></span>
			</button>
		</SlimTooltip>

		<!-- Wordmark (Home, first run) -->
		<span v-if="brand" class="font-heading font-black text-base tracking-tight pl-1">FrameFlow</span>

		<template v-else>
			<!-- Click the title to rename in place -->
			<input v-if="editable && renaming" ref="titleInput" v-model="draft"
				class="font-heading font-semibold text-[15px] tracking-tight min-w-[160px] max-w-[320px] bg-transparent border-b border-primary/60 outline-none"
				@keydown.enter.prevent="commitRename" @keydown.esc.prevent="renaming = false" @blur="commitRename" />
			<button v-else-if="editable" class="group/title flex items-center gap-1.5 min-w-0 max-w-[40%]" title="Rename project"
				@click="startRename">
				<span class="font-heading font-semibold text-[15px] tracking-tight truncate">{{ title || 'Untitled Project' }}</span>
				<span class="iconify tabler--pencil w-3 h-3 text-zinc-400 opacity-0 group-hover/title:opacity-100 transition shrink-0"></span>
			</button>
			<h1 v-else class="font-heading font-semibold text-[15px] tracking-tight truncate min-w-0 max-w-[40%]" :title="title">{{ title }}</h1>

			<span v-if="subtitle" class="hidden md:block text-xs text-zinc-500 dark:text-zinc-400 truncate min-w-0">{{ subtitle }}</span>
		</template>

		<span v-if="totalCost && totalCost > 0" class="font-mono text-[11px] text-zinc-500 tabular-nums shrink-0"
			title="What this project has cost in AI usage">${{ totalCost.toFixed(4) }}</span>

		<!-- Live status in the middle (the agent banner) -->
		<div v-if="$slots.center" class="flex-1 flex justify-center min-w-0 px-3">
			<slot name="center" />
		</div>
		<div v-else class="flex-1"></div>

		<GlobalRenderPill />

		<slot name="actions" />

		<SlimTooltip v-if="showSettings" text="Settings" placement="bottom">
			<button class="btn-icon" aria-label="Settings" @click="router.push('/settings')">
				<span class="iconify tabler--settings w-4 h-4"></span>
			</button>
		</SlimTooltip>
		<SlimTooltip :text="isDark ? 'Switch to light theme' : 'Switch to dark theme'" placement="bottom">
			<button class="btn-icon" :aria-label="isDark ? 'Switch to light theme' : 'Switch to dark theme'" @click="toggle">
				<span class="iconify w-4 h-4" :class="isDark ? 'tabler--sun' : 'tabler--moon'"></span>
			</button>
		</SlimTooltip>
	</header>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import SlimTooltip from './SlimTooltip.vue'
import GlobalRenderPill from './GlobalRenderPill.vue'
import { useTheme } from '../composables/useTheme'

/**
 * The 40px top bar every page except the editor shares (the editor draws its
 * own, EditorTopBar, with Export): back, title, project cost, then background
 * exports, page actions, settings and theme. Replaces the old absolutely
 * placed settings/theme cluster and the floating export pills.
 */
const props = withDefaults(defineProps<{
	title?: string
	subtitle?: string
	/** Show the FrameFlow wordmark instead of a title. */
	brand?: boolean
	showBack?: boolean
	showSettings?: boolean
	totalCost?: number
	/** Click the title to rename it (timeline projects). */
	editable?: boolean
}>(), { showSettings: true })

const emit = defineEmits<{
	(e: 'back'): void
	(e: 'rename', value: string): void
}>()

const router = useRouter()
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
