<template>
	<button
		class="shrink-0 px-3 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:border-primary/40 hover:text-primary transition active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
		data-retry
		:disabled="store.promptRunning"
		title="Run this request again on the same engine"
		@click="store.retryTurn(turn)">
		Retry
	</button>
</template>

<script setup lang="ts">
import type { PromptTurn } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'

/** Offered by the card beside a failure note; engineRetry decides when. */
defineProps<{ turn: PromptTurn }>()
const store = useEditorStore()
</script>
