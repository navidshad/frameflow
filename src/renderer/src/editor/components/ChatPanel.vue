<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<!-- Turn history -->
		<div ref="scrollRef" class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 py-3 space-y-3">
			<!-- Empty state -->
			<div v-if="turns.length === 0" class="h-full flex flex-col items-center justify-center gap-2 text-center px-4">
				<span class="text-2xl">{{ store.activePersona?.icon || '🎬' }}</span>
				<p class="text-xs font-bold text-zinc-600 dark:text-zinc-300">
					{{ store.activePersona?.name || 'Your editor' }} is ready
				</p>
				<p class="text-[11px] text-zinc-400 leading-relaxed">
					Ask for a cut, a cleanup, or a question about the footage. Every request and result stays here.
				</p>
			</div>

			<template v-for="turn in turns" :key="turn.id">
				<!-- User prompt -->
				<div class="flex flex-col items-end gap-1">
					<div class="max-w-[85%] px-3 py-2 rounded-2xl rounded-br-md bg-primary text-white text-xs leading-relaxed whitespace-pre-wrap">
						{{ turn.prompt }}
					</div>
					<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400 flex items-center gap-1">
						<span v-if="turn.scopeLabel" class="text-secondary">{{ turn.scopeLabel }}</span>
						<span>{{ formatTime(turn.createdAt) }}</span>
					</span>
				</div>

				<!-- Assistant response -->
				<div class="flex items-start gap-2">
					<span class="text-sm leading-none mt-1 shrink-0">{{ personaIcon(turn.personaId) }}</span>
					<div class="flex-1 min-w-0">
						<!-- Running -->
						<div v-if="turn.status === 'pending' || turn.status === 'running'"
							class="px-3 py-2 rounded-2xl rounded-tl-md bg-zinc-100 dark:bg-zinc-900 inline-flex items-center gap-2">
							<div class="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin"></div>
							<span class="text-[11px] text-zinc-500">Working on it…</span>
						</div>

						<!-- Error -->
						<div v-else-if="turn.status === 'error'"
							class="px-3 py-2 rounded-2xl rounded-tl-md bg-red-500/10 border border-red-500/20">
							<p class="text-[11px] text-red-500 leading-snug">{{ turn.error || 'The request failed.' }}</p>
							<button class="mt-1.5 px-2 py-0.5 rounded-lg bg-red-500/10 text-red-500 text-[9px] font-bold uppercase tracking-widest hover:bg-red-500/20 transition"
								@click="store.runPrompt(turn.prompt)">
								Retry
							</button>
						</div>

						<!-- Question answer -->
						<div v-else-if="turn.answer"
							class="px-3 py-2 rounded-2xl rounded-tl-md bg-zinc-100 dark:bg-zinc-900 text-xs text-zinc-700 dark:text-zinc-300 leading-relaxed whitespace-pre-wrap">
							{{ turn.answer }}
						</div>

						<!-- Applied edit -->
						<div v-else class="px-3 py-2 rounded-2xl rounded-tl-md bg-zinc-100 dark:bg-zinc-900 space-y-1.5">
							<p v-if="turn.rationale" class="text-[11px] italic text-zinc-500 dark:text-zinc-400 leading-snug">
								{{ turn.rationale }}
							</p>
							<div class="flex items-center gap-1.5 flex-wrap">
								<span v-if="revisionSeq(turn)"
									class="px-1.5 py-px rounded bg-secondary/15 text-secondary text-[9px] font-bold font-mono">
									V{{ revisionSeq(turn) }}
								</span>
								<span v-for="chip in opChips(turn)" :key="chip"
									class="px-1.5 py-px rounded bg-zinc-200/70 dark:bg-zinc-800 text-[9px] font-bold text-zinc-500">
									{{ chip }}
								</span>
								<span v-if="turn.cost" class="text-[9px] font-mono text-zinc-400 ml-auto">
									${{ turn.cost.toFixed(4) }}
								</span>
							</div>
							<p v-if="turn.droppedOps?.length" class="text-[9px] text-amber-500 leading-snug">
								{{ turn.droppedOps.length }} op{{ turn.droppedOps.length === 1 ? '' : 's' }} dropped during validation
							</p>
						</div>
					</div>
				</div>
			</template>
		</div>

		<!-- Latest applied result actions (Back to parent, etc.) -->
		<AiResultCard v-if="store.lastResult" class="shrink-0 mx-2 mb-2" />

		<!-- Input, pinned -->
		<div class="shrink-0 border-t border-zinc-200/60 dark:border-zinc-800 p-2">
			<PromptBar />
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { PromptTurn } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'
import PromptBar from './PromptBar.vue'
import AiResultCard from './AiResultCard.vue'

const store = useEditorStore()

const scrollRef = ref<HTMLElement | null>(null)

const turns = computed<PromptTurn[]>(() =>
	[...(store.doc?.turns || [])].sort((a, b) => a.createdAt - b.createdAt)
)

const personaIcon = (personaId: string) => store.findPersona?.(personaId)?.icon
	|| store.personas.find((p) => p.id === personaId)?.icon
	|| '🤖'

const revisionSeq = (turn: PromptTurn) => {
	if (!turn.revisionId) return null
	return store.revisions.find((r) => r.id === turn.revisionId)?.seq ?? null
}

const opChips = (turn: PromptTurn) => {
	const d = turn.diff
	if (!d) return []
	const chips: string[] = []
	if (d.addItems?.length) chips.push(`+${d.addItems.length} added`)
	if (d.removeItemIds?.length) chips.push(`−${d.removeItemIds.length} removed`)
	if (d.updateItems?.length) chips.push(`${d.updateItems.length} changed`)
	return chips
}

const formatTime = (ts: number) => {
	const d = new Date(ts)
	return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Follow the conversation: stick to the bottom when turns change/stream
const scrollToBottom = () => {
	nextTick(() => {
		const el = scrollRef.value
		if (el) el.scrollTop = el.scrollHeight
	})
}
watch(() => [turns.value.length, turns.value[turns.value.length - 1]?.status], scrollToBottom, { immediate: true })
</script>
