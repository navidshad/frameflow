<template>
	<div class="h-11 shrink-0 hair-t flex items-center gap-3 px-3.5">
		<div class="relative flex-1 min-w-0 h-7">
			<TimeRefPicker v-if="picker.open.value" :options="picker.options.value" :active="picker.active.value"
				@pick="picker.pick" @hover="picker.active.value = $event" />
			<RefMirror :text="text" :scroll-left="scrollLeft" single class="text-[13px] leading-7" />
			<input ref="inputRef" v-model="text" type="text" :disabled="inputDisabled" :placeholder="placeholder"
				class="relative w-full h-7 bg-transparent border-0 border-b border-b-[color:var(--ff-hairline-strong)] focus:border-b-primary outline-none text-[13px] placeholder-zinc-400"
				@input="picker.sync" @click="picker.sync" @keyup="onKeyup" @keydown="onKeydown"
				@scroll="scrollLeft = ($event.target as HTMLElement).scrollLeft" />
		</div>
		<!-- Frames on the draft: the chat column shows them with their notes. -->
		<button v-if="store.promptAttachments.length" class="shrink-0 flex items-center gap-1 text-[10px] font-semibold transition"
			:class="imagesBlocked ? 'text-amber-500' : 'text-zinc-500 hover:text-primary'"
			:title="imagesBlocked ? `${engine.current.label} cannot be sent pictures. Open the chat to remove them.` : 'Open the chat to see the frames and their notes'"
			@click="$emit('open')">
			<img :src="store.promptAttachments[0].thumbnail" alt="" class="h-5 rounded-sm hair" />
			{{ store.promptAttachments.length }} frame{{ store.promptAttachments.length === 1 ? '' : 's' }}
		</button>
		<button class="w-6 h-7 shrink-0 flex items-center justify-center text-zinc-400 hover:text-accent transition disabled:opacity-40"
			:title="`Attach the frame at the playhead (${formatTimecode(store.playheadSec)})`" :disabled="!canCapture"
			@click="store.captureFrameForPrompt()">
			<span class="iconify w-3.5 h-3.5" :class="store.capturingFrame ? 'tabler--loader-2 animate-spin' : 'tabler--camera-plus'"></span>
		</button>
		<EngineChip />
		<button
			class="w-7 h-7 shrink-0 rounded-md flex items-center justify-center transition active:scale-95"
			:class="store.promptRunning
				? 'bg-red-500/15 text-red-500 hover:bg-red-500/25'
				: canSend ? 'bg-primary text-white hover:bg-primary-dark' : 'text-zinc-400 cursor-not-allowed'"
			:title="store.promptRunning ? 'Stop' : 'Send (Enter)'"
			@click="store.promptRunning ? store.abortPrompt() : submit()">
			<span v-if="store.promptRunning" class="iconify tabler--player-stop-filled w-3 h-3"></span>
			<span v-else class="iconify tabler--send w-3.5 h-3.5"></span>
		</button>
		<button v-if="!foldedForRoom"
			class="relative text-[11px] font-semibold text-zinc-500 hover:text-primary transition shrink-0"
			@click="$emit('open')">
			Open chat
			<span v-if="badge" class="absolute -top-0.5 -right-1.5 w-1.5 h-1.5 rounded-full bg-primary-light"></span>
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatTimecode } from '@shared/promptRefs'
import TimeRefPicker from './TimeRefPicker.vue'
import RefMirror from './RefMirror.vue'
import { useTimeRefPicker } from '../composables/useTimeRefPicker'
import { draftPrompt } from '../frameMarks'
import { MAX_PROMPT_FRAMES } from '../../stores/editorStore'
import { useEditorStore } from '../../stores/editorStore'
import EngineChip from './EngineChip.vue'
import { useEngineStore } from '../../stores/engineStore'
import { useAgentStore } from '../../stores/agentStore'

/**
 * The chat folded to one row under the picture, so a message is always one
 * click away. It shares the draft with the chat's own prompt bar, so opening the
 * column keeps what was typed.
 */
defineProps<{ badge?: boolean; foldedForRoom?: boolean }>()
defineEmits<{ (e: 'open'): void }>()

const store = useEditorStore()
const engine = useEngineStore()

const text = computed({
	get: () => store.promptDraft,
	set: (v: string) => { store.promptDraft = v }
})

const agent = useAgentStore()
const inputDisabled = computed(() => store.promptRunning || !store.canPrompt || !!agent.mcpWorking)
const inputRef = ref<HTMLInputElement | null>(null)
const scrollLeft = ref(0)
const picker = useTimeRefPicker(text, inputRef)

const imagesBlocked = computed(() => store.promptAttachments.length > 0 && !engine.current.images)
const canSend = computed(() => (text.value.trim().length > 0 || store.promptAttachments.length > 0)
	&& !imagesBlocked.value && !store.capturingFrame && !inputDisabled.value)
const canCapture = computed(() => !!store.doc?.timeline.length && engine.current.images && !store.capturingFrame && !agent.mcpWorking
	&& store.promptAttachments.length < MAX_PROMPT_FRAMES)

const onKeyup = (e: KeyboardEvent) => {
	if (!picker.open.value || !['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) picker.sync()
}
const onKeydown = (e: KeyboardEvent) => {
	if (picker.onKeydown(e)) return
	if (e.key === 'Enter' && !e.isComposing) {
		e.preventDefault()
		submit()
	}
}

const placeholder = computed(() => {
	if (agent.mcpWorking) return `Locked: ${agent.mcpWorking.clientName} is working over MCP…`
	if (store.isEmpty && !store.hasLayers) return 'Import media to start…'
	if (!store.canPrompt && store.mediaProcessing) return 'Preparing media…'
	if (!store.canPrompt) return 'Media not ready yet…'
	return `Message ${engine.current.label}…`
})

const submit = () => {
	if (!canSend.value) return
	store.runPrompt(draftPrompt(text.value, store.promptAttachments.length))
	text.value = ''
}
</script>
