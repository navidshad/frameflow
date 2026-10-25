<template>
	<div class="h-11 shrink-0 hair-t flex items-center gap-3 px-3.5">
		<input v-model="text" type="text" :disabled="inputDisabled" :placeholder="placeholder"
			class="flex-1 min-w-0 h-7 bg-transparent border-0 border-b border-b-[color:var(--ff-hairline-strong)] focus:border-b-primary outline-none text-[13px] placeholder-zinc-400"
			@keydown.enter.prevent="submit" />
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
import { computed } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import EngineChip from './EngineChip.vue'
import { useAgentStore } from '../../stores/agentStore'

/**
 * The chat folded to one row under the picture, so a message is always one
 * click away. It shares the draft with the chat's own prompt bar, so opening the
 * column keeps what was typed.
 */
defineProps<{ badge?: boolean; foldedForRoom?: boolean }>()
defineEmits<{ (e: 'open'): void }>()

const store = useEditorStore()

const text = computed({
	get: () => store.promptDraft,
	set: (v: string) => { store.promptDraft = v }
})

const agent = useAgentStore()
const inputDisabled = computed(() => store.promptRunning || !store.canPrompt || !!agent.mcpWorking)
const canSend = computed(() => text.value.trim().length > 0 && !inputDisabled.value)

const placeholder = computed(() => {
	if (agent.mcpWorking) return `Locked: ${agent.mcpWorking.clientName} is working over MCP…`
	if (store.isEmpty && !store.hasLayers) return 'Import media to start…'
	if (!store.canPrompt && store.mediaProcessing) return 'Preparing media…'
	if (!store.canPrompt) return 'Media not ready yet…'
	return `Message ${store.activePersona?.name || 'your editor'}…`
})

const submit = () => {
	if (!canSend.value) return
	store.runPrompt(text.value.trim())
	text.value = ''
}
</script>
