<template>
	<div class="shrink-0">
		<!-- Inline error -->
		<div v-if="store.promptError"
			class="mb-2 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-between gap-2 animate-fade-in-up">
			<p class="text-[11px] font-medium text-red-500 leading-snug">{{ store.promptError }}</p>
			<button v-if="lastPrompt"
				class="px-2 py-1 rounded-lg bg-red-500/10 text-red-500 text-[10px] font-bold uppercase tracking-widest hover:bg-red-500/20 transition shrink-0"
				@click="retry">
				Retry
			</button>
		</div>

		<!-- Flat input zone: the panel's border-t is the only frame. -->
		<div>
			<AttachmentTray @submit="submit" />
			<div class="relative">
				<TimeRefPicker v-if="picker.open.value" :options="picker.options.value" :active="picker.active.value"
					@pick="picker.pick" @hover="picker.active.value = $event" />
				<!-- Same font and padding as the textarea, so its chips sit under the text. -->
				<RefMirror :text="text" :scroll-top="scrollTop" class="text-sm py-1" />
				<textarea ref="inputRef" v-model="text" rows="1"
					class="relative block w-full bg-transparent resize-none outline-none text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 max-h-24 custom-scrollbar py-1"
					:placeholder="placeholder" :disabled="inputDisabled" data-testid="prompt-input"
					@input="onInput" @keydown="onKeydown" @click="picker.sync" @keyup="onKeyup" @blur="picker.sync"
					@scroll="scrollTop = ($event.target as HTMLElement).scrollTop"></textarea>
			</div>

			<!-- Meta row: quiet text controls left, send right. It measures itself
			     (container query below) so a narrow chat drops labels, never Send. -->
			<div class="meta-row flex items-center gap-1 mt-0.5">
				<EngineChip />

				<span class="text-zinc-300 dark:text-zinc-700 text-[9px]">·</span>

				<!-- The frame in the monitor, attached to the message as a picture. -->
				<button class="shrink-0 flex items-center gap-1 px-1 py-0.5 rounded-md text-zinc-500 hover:text-accent transition disabled:opacity-40 disabled:hover:text-zinc-500"
					:title="frameTitle" aria-label="Attach frame" :disabled="!canCapture" data-testid="attach-frame" @click="store.captureFrameForPrompt()">
					<span class="iconify w-2.5 h-2.5" :class="store.capturingFrame ? 'tabler--loader-2 animate-spin' : 'tabler--camera-plus'"></span>
					<span class="meta-label text-[9px] font-bold uppercase tracking-widest">Frame</span>
				</button>

				<span class="text-zinc-300 dark:text-zinc-700 text-[9px]">·</span>

				<!-- The CLI agent remembers this chat; this makes its next message a clean start. -->
				<template v-if="conversation">
					<button class="shrink-0 flex items-center gap-1 px-1 py-0.5 rounded-md text-zinc-500 hover:text-primary transition"
						title="The agent remembers this chat. Start a new conversation: it forgets what was said, the project stays as it is."
						aria-label="New conversation" data-testid="new-conversation" @click="store.resetEngineConversation()">
						<span class="iconify tabler--message-plus w-2.5 h-2.5"></span>
						<span class="meta-label text-[9px] font-bold uppercase tracking-widest">New conversation</span>
					</button>
					<span class="text-zinc-300 dark:text-zinc-700 text-[9px]">·</span>
				</template>

				<!-- Scope: text-level control — owns the flexible space so it
				     truncates with clearance before the send button; never narrower
				     than its icon, so it can always be opened -->
				<div class="relative flex-1 min-w-[18px]" ref="scopeRef">
					<button v-if="store.scopePreview"
						class="max-w-full flex items-center gap-1 px-1 py-0.5 rounded-md text-zinc-500 hover:text-secondary transition min-w-0"
						:title="'What the AI can see — click to change'"
						@click="scopeMenuOpen = !scopeMenuOpen">
						<span class="iconify tabler--focus-2 w-2.5 h-2.5 text-secondary/70 shrink-0"></span>
						<span class="text-[9px] font-bold uppercase tracking-widest truncate">
							{{ store.scopePreview.label }}
						</span>
					</button>
					<div v-if="scopeMenuOpen"
						class="absolute bottom-full left-0 mb-2 w-48 pop z-50 py-1 origin-bottom animate-menu">
						<button v-for="option in scopeOptions" :key="option.value"
							class="w-full px-3 py-1.5 flex items-center justify-between text-left hover:bg-primary/5 transition"
							@click="setScope(option.value)">
							<span class="text-[11px] font-medium text-zinc-700 dark:text-zinc-300">{{ option.label }}</span>
							<span v-if="store.scopeWiden === option.value" class="iconify tabler--check w-3 h-3 text-primary"></span>
						</button>
					</div>
				</div>

				<!-- Send / Stop -->
				<button
					class="ml-2 shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition active:scale-95"
					:class="store.promptRunning
						? 'bg-red-500 text-white hover:bg-red-600'
						: canSend
							? 'bg-primary text-white hover:bg-primary-dark'
							: 'text-zinc-300 dark:text-zinc-600 cursor-not-allowed'"
					:title="store.promptRunning ? 'Stop' : 'Send (Enter)'"
					@click="store.promptRunning ? store.abortPrompt() : submit()">
					<span v-if="store.promptRunning" class="iconify tabler--player-stop-filled w-2.5 h-2.5"></span>
					<span v-else class="iconify tabler--send w-3 h-3"></span>
				</button>
			</div>
		</div>

		<!-- An outside agent holds the project: the chat is read-only until its round ends -->
		<div v-if="mcp" class="mt-1.5 flex items-center gap-2 px-2 py-1.5 rounded-lg bg-secondary/[0.08] border border-secondary/20">
			<span class="iconify tabler--lock w-3 h-3 text-secondary-light shrink-0"></span>
			<span class="text-[10px] font-medium text-zinc-600 dark:text-zinc-300 leading-snug flex-1 min-w-0">
				<b class="text-violet-700 dark:text-violet-300">{{ mcp.clientName }}</b> is working over MCP · round {{ mcp.seq }} · {{ mcp.steps }} step{{ mcp.steps === 1 ? '' : 's' }}.
				The chat unlocks when it ends its round.
			</span>
			<button class="text-[10px] font-semibold text-red-500 hover:text-red-400 transition shrink-0" @click="agent.stopRound()">Stop</button>
		</div>

		<!-- Running status -->
		<div v-else-if="store.promptRunning" class="mt-1.5 flex items-center gap-2 px-2">
			<div class="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin"></div>
			<span class="text-[10px] font-medium text-zinc-500">
				{{ engine.isCli ? engine.current.label : 'AI' }} is working on your edit…
			</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import EngineChip from './EngineChip.vue'
import { useEngineStore } from '../../stores/engineStore'
import { useAgentStore } from '../../stores/agentStore'
import { resumableSessionId } from '@shared/engines'
import { formatTimecode } from '@shared/promptRefs'
import AttachmentTray from './AttachmentTray.vue'
import TimeRefPicker from './TimeRefPicker.vue'
import RefMirror from './RefMirror.vue'
import { useTimeRefPicker } from '../composables/useTimeRefPicker'
import { draftPrompt } from '../frameMarks'
import { MAX_PROMPT_FRAMES } from '../../stores/editorStore'

const store = useEditorStore()
const engine = useEngineStore()
const agent = useAgentStore()
/** One agent per project: an MCP agent's open round locks the chat. */
const mcp = computed(() => agent.mcpWorking)

// The draft lives in the store: Home pre-fills it before this mounts, and this
// component is v-if'd away when the rail collapses.
const text = computed({
	get: () => store.promptDraft,
	set: (v: string) => { store.promptDraft = v }
})
const lastPrompt = ref('')
const scopeMenuOpen = ref(false)
const inputRef = ref<HTMLTextAreaElement | null>(null)
const scopeRef = ref<HTMLElement | null>(null)

// Chat is inert until there is something to work on: media that has finished
// preprocessing (the AI needs pieces/transcript to reason about footage), or
// layers that need no footage at all.
const inputDisabled = computed(() => store.promptRunning || !store.canPrompt || !!mcp.value)

// Keep placeholders short — the narrow rail clips a single-row textarea, and
// the chat empty-state already carries the full guidance.
const placeholder = computed(() => {
	if (mcp.value) return `Locked: ${mcp.value.clientName} is working over MCP…`
	if (store.isEmpty && !store.hasLayers) return 'Import media to start…'
	if (!store.canPrompt && store.mediaProcessing) return 'Preparing media…'
	if (!store.canPrompt) return 'Media not ready yet…'
	return `Message ${engine.current.label}…`
})

/** The selected agent has a conversation with this project that the next message would continue. */
const conversation = computed(() => {
	const id = engine.settings.engine
	return !store.promptRunning && !!resumableSessionId(store.doc?.turns, id)
})

const picker = useTimeRefPicker(text, inputRef)
const scrollTop = ref(0)

// Frames alone are a message (their notes say what is wanted); an engine that
// cannot see pictures cannot be sent them, and the tray says why.
const attachments = computed(() => store.promptAttachments)
const imagesBlocked = computed(() => attachments.value.length > 0 && !engine.current.images)
const canSend = computed(() => (text.value.trim().length > 0 || attachments.value.length > 0) && !imagesBlocked.value && !store.capturingFrame && !inputDisabled.value)

const canCapture = computed(() => !!store.doc?.timeline.length && engine.current.images && !store.capturingFrame && !mcp.value
	&& attachments.value.length < MAX_PROMPT_FRAMES)
const frameTitle = computed(() => {
	if (!engine.current.images) return `${engine.current.label} cannot be sent pictures`
	if (!store.doc?.timeline.length) return 'Nothing on the timeline to capture'
	if (attachments.value.length >= MAX_PROMPT_FRAMES) return `A message carries ${MAX_PROMPT_FRAMES} frames at most`
	return `Attach the frame at the playhead (${formatTimecode(store.playheadSec)}). Or type @ in the message.`
})

const onInput = () => {
	autoGrow()
	picker.sync()
}
// Arrow keys move the caret without an input event; the picker follows it.
const onKeyup = (e: KeyboardEvent) => {
	if (!picker.open.value || !['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) picker.sync()
}
const onKeydown = (e: KeyboardEvent) => {
	if (picker.onKeydown(e)) return
	if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.isComposing) {
		e.preventDefault()
		submit()
	}
}

const scopeOptions = computed(() => [
	{
		value: 'auto' as const,
		label: store.selectedItemIds.length ? `Auto (selection · ${store.selectedItemIds.length})` : 'Auto'
	},
	{ value: 'chapter' as const, label: 'Current chapter' },
	{ value: 'full' as const, label: 'Whole timeline' }
])

const setScope = (value: 'auto' | 'chapter' | 'full') => {
	store.scopeWiden = value
	scopeMenuOpen.value = false
}

const autoGrow = () => {
	const el = inputRef.value
	if (!el) return
	el.style.height = 'auto'
	el.style.height = `${Math.min(el.scrollHeight, 96)}px`
}

const submit = () => {
	if (!canSend.value) return
	lastPrompt.value = draftPrompt(text.value, attachments.value.length)
	store.runPrompt(lastPrompt.value)
	text.value = ''
	autoGrow()
}

const retry = () => {
	if (lastPrompt.value) store.runPrompt(lastPrompt.value)
}

/**
 * A queued prompt arrives before mount, and the textarea is rows="1" that only
 * grows on @input — so a multi-line prefill would render clipped to one line.
 */
onMounted(() => nextTick(autoGrow))
watch(() => store.canPrompt, (ready) => {
	if (ready && text.value.trim()) nextTick(() => inputRef.value?.focus())
})

const onDocClick = (e: MouseEvent) => {
	if (scopeMenuOpen.value && scopeRef.value && !scopeRef.value.contains(e.target as Node)) {
		scopeMenuOpen.value = false
	}
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
</script>

<style scoped>
.meta-row { container-type: inline-size; }
/* With every label the row needs about 570 px (chip ~200, Frame ~60, New
   conversation ~130, scope ~110, Send). Below this Frame and New conversation keep
   only their icons (their titles still say what they do), which frees ~150 px. */
@container (max-width: 539px) {
	.meta-label { display: none; }
}
</style>
