<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<!-- Header -->
		<div class="px-4 pt-4 pb-2 flex items-center justify-between shrink-0">
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Revisions</span>
			<div class="flex items-center gap-1">
				<SaveRevisionButton />
				<button
					class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-500 hover:text-primary hover:bg-primary/10 transition active:scale-95"
					title="View as graph" :disabled="store.revisions.length === 0"
					@click="showGraph = true">
					<span class="iconify tabler--sitemap w-4 h-4"></span>
				</button>
			</div>
		</div>

		<!-- Tree list -->
		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-3">
			<!-- Empty state -->
			<div v-if="store.revisions.length === 0"
				class="h-full flex flex-col items-center justify-center text-center gap-3 py-8">
				<div class="w-12 h-12 rounded-2xl bg-secondary/10 flex items-center justify-center text-secondary">
					<span class="iconify tabler--bookmark w-6 h-6"></span>
				</div>
				<p class="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed px-4">
					Save a revision or run an AI edit to start the tree. Every prompt result becomes a
					revision you can branch from.
				</p>
			</div>

			<template v-else>
				<RevisionListItem v-for="entry in flatTree" :key="entry.revision.id"
					:revision="entry.revision" :depth="entry.depth" />
			</template>
		</div>

		<RevisionGraphModal v-model="showGraph" />
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { EditorRevision } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'
import RevisionListItem from './RevisionListItem.vue'
import SaveRevisionButton from './SaveRevisionButton.vue'
import RevisionGraphModal from './RevisionGraphModal.vue'

const store = useEditorStore()
const showGraph = ref(false)

/** DFS over the revision tree: main line first (createdAt order), depth-indented. */
const flatTree = computed<{ revision: EditorRevision; depth: number }[]>(() => {
	const out: { revision: EditorRevision; depth: number }[] = []
	const walk = (parentId: string | null, depth: number) => {
		for (const rev of store.revisionChildren.get(parentId) || []) {
			out.push({ revision: rev, depth })
			walk(rev.id, depth + 1)
		}
	}
	walk(null, 0)
	return out
})
</script>
