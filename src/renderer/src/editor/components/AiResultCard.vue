<template>
	<div v-if="result"
		class="rounded-xl bg-primary/5 dark:bg-primary/10 p-3 animate-fade-in-up">
		<!-- Header -->
		<div class="flex items-center justify-between gap-3 mb-2">
			<div class="flex items-center gap-2 min-w-0">
				<span class="text-base leading-none">{{ persona?.icon || '✨' }}</span>
				<span class="text-xs font-bold text-zinc-800 dark:text-zinc-200 font-heading">Applied</span>
				<span class="text-[10px] font-bold text-primary font-mono">V{{ result.revisionSeq }}</span>
				<span v-if="result.scopeLabel"
					class="text-[9px] font-bold uppercase tracking-widest text-zinc-400 truncate">{{ result.scopeLabel }}</span>
			</div>
			<div class="flex items-center gap-1.5 shrink-0">
				<span v-if="result.counts.added" class="px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[9px] font-bold font-mono">+{{ result.counts.added }}</span>
				<span v-if="result.counts.removed" class="px-1.5 py-0.5 rounded bg-red-500/10 text-red-500 text-[9px] font-bold font-mono">−{{ result.counts.removed }}</span>
				<span v-if="result.counts.updated" class="px-1.5 py-0.5 rounded bg-secondary/10 text-secondary text-[9px] font-bold font-mono">{{ result.counts.updated }} changed</span>
				<span v-if="result.counts.markers" class="px-1.5 py-0.5 rounded bg-accent/10 text-accent text-[9px] font-bold font-mono">{{ result.counts.markers }} markers</span>
				<button class="w-5 h-5 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
					title="Dismiss" @click="store.dismissResult()">
					<span class="iconify tabler--x w-3 h-3"></span>
				</button>
			</div>
		</div>

		<!-- Rationale -->
		<p v-if="result.rationale" class="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
			{{ result.rationale }}
		</p>

		<!-- Notices -->
		<div v-if="result.droppedOps.length"
			class="mt-2 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20">
			<p class="text-[10px] font-medium text-amber-600 dark:text-amber-400 leading-snug">
				<span class="iconify tabler--alert-triangle w-3 h-3 inline-block align-[-1px] mr-1"></span>
				{{ result.droppedOps.length }} proposed change{{ result.droppedOps.length === 1 ? '' : 's' }} could not be
				applied (the timeline had changed).
			</p>
		</div>
		<div v-if="result.thinContext"
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
		<p v-if="result.truncated" class="mt-2 text-[10px] text-zinc-400 leading-snug">
			<span class="iconify tabler--info-circle w-3 h-3 inline-block align-[-1px] mr-1"></span>
			Long project — the AI saw a summarized view of out-of-scope material.
		</p>

		<!-- Footer -->
		<div class="mt-3 flex items-center justify-between gap-3">
			<span v-if="turn?.usage" class="text-[9px] font-mono text-zinc-400">
				~{{ turn.usage.totalTokens.toLocaleString() }} tok · ${{ (turn.cost || 0).toFixed(4) }}
			</span>
			<button v-if="parentRevision"
				class="ml-auto px-3 py-1.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:border-primary/40 hover:text-primary transition active:scale-95"
				:title="'Switch back to the previous revision — this result stays in the tree'"
				@click="goBack">
				<span class="iconify tabler--arrow-back-up w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
				Back to V{{ parentRevision.seq }}
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '../../stores/editorStore'

const store = useEditorStore()

const result = computed(() => store.lastResult)

const turn = computed(() =>
	store.doc?.turns.find((t) => t.id === result.value?.turnId) || null
)

const persona = computed(() => {
	const id = turn.value?.personaId
	return store.personas.find((p) => p.id === id) || store.activePersona
})

const parentRevision = computed(() =>
	store.revisions.find((r) => r.id === result.value?.parentRevisionId) || null
)

const goBack = async () => {
	if (!result.value?.parentRevisionId) return
	const ok = await store.switchRevision(result.value.parentRevisionId)
	if (ok) store.dismissResult()
}
</script>
