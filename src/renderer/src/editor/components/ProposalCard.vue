<template>
	<div v-if="proposal"
		class="rounded-2xl border border-primary/30 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-xl shadow-premium p-4 animate-fade-in-up">
		<!-- Header -->
		<div class="flex items-center justify-between gap-3 mb-2">
			<div class="flex items-center gap-2 min-w-0">
				<span class="text-base leading-none">{{ persona?.icon || '✨' }}</span>
				<span class="text-xs font-bold text-zinc-800 dark:text-zinc-200 font-heading">Proposed edit</span>
				<span v-if="proposal.scopeLabel"
					class="text-[9px] font-bold uppercase tracking-widest text-zinc-400 truncate">{{ proposal.scopeLabel }}</span>
			</div>
			<div class="flex items-center gap-1.5 shrink-0">
				<span v-if="counts.added" class="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[9px] font-bold font-mono">+{{ counts.added }}</span>
				<span v-if="counts.removed" class="px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 text-[9px] font-bold font-mono">−{{ counts.removed }}</span>
				<span v-if="counts.updated" class="px-1.5 py-0.5 rounded bg-secondary/10 text-secondary text-[9px] font-bold font-mono">{{ counts.updated }} changed</span>
				<span v-if="proposal.addMarkers.length" class="px-1.5 py-0.5 rounded bg-accent/10 text-accent text-[9px] font-bold font-mono">{{ proposal.addMarkers.length }} markers</span>
			</div>
		</div>

		<!-- Rationale -->
		<p v-if="proposal.rationale" class="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
			{{ proposal.rationale }}
		</p>

		<!-- Notices -->
		<div v-if="proposal.droppedOps.length"
			class="mt-2 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
			<p class="text-[10px] font-medium text-amber-600 dark:text-amber-400 leading-snug">
				<span class="iconify tabler--alert-triangle w-3 h-3 inline-block align-[-1px] mr-1"></span>
				{{ proposal.droppedOps.length }} proposed change{{ proposal.droppedOps.length === 1 ? '' : 's' }} no longer
				apply — the timeline changed after this was generated.
			</p>
		</div>
		<div v-if="proposal.thinContext"
			class="mt-2 px-2.5 py-1.5 rounded-lg bg-zinc-500/5 border border-zinc-500/10 flex items-center justify-between gap-2">
			<p class="text-[10px] font-medium text-zinc-500 leading-snug">
				<span class="iconify tabler--info-circle w-3 h-3 inline-block align-[-1px] mr-1"></span>
				Context is thin — scene descriptions would improve results.
			</p>
			<button v-if="store.selectedAsset"
				class="px-2 py-1 rounded-lg bg-secondary/10 text-secondary text-[9px] font-bold uppercase tracking-widest hover:bg-secondary/20 transition shrink-0"
				@click="store.describeAsset(store.selectedAsset.id)">
				Describe scenes
			</button>
		</div>
		<p v-if="proposal.truncated" class="mt-2 text-[10px] text-zinc-400 leading-snug">
			<span class="iconify tabler--info-circle w-3 h-3 inline-block align-[-1px] mr-1"></span>
			Long project — the AI saw a summarized view of out-of-scope material.
		</p>

		<!-- Footer -->
		<div class="mt-3 flex items-center justify-between gap-3">
			<span v-if="turn?.usage" class="text-[9px] font-mono text-zinc-400">
				~{{ turn.usage.totalTokens.toLocaleString() }} tok · ${{ (turn.cost || 0).toFixed(4) }}
			</span>
			<div class="flex items-center gap-2 ml-auto">
				<button
					class="px-3 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition active:scale-95"
					@click="store.rejectProposal()">
					Reject
				</button>
				<button v-if="hasApplicableOps"
					class="px-3 py-1.5 rounded-xl bg-primary text-white text-xs font-bold shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-95"
					@click="store.acceptProposal()">
					Accept all
				</button>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '../../stores/editorStore'

const store = useEditorStore()

const proposal = computed(() => store.pendingProposal)

const turn = computed(() =>
	store.doc?.turns.find((t) => t.id === proposal.value?.turnId) || null
)

const persona = computed(() => {
	const id = turn.value?.personaId
	return store.personas.find((p) => p.id === id) || store.activePersona
})

const counts = computed(() => ({
	added: proposal.value?.diff.addItems?.length || 0,
	removed: proposal.value?.diff.removeItemIds?.length || 0,
	updated: proposal.value?.diff.updateItems?.length || 0
}))

const hasApplicableOps = computed(() =>
	counts.value.added + counts.value.removed + counts.value.updated > 0 ||
	(proposal.value?.addMarkers.length || 0) > 0
)
</script>
