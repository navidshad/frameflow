<template>
	<Modal :model-value="modelValue" title="Revision graph" size="xl"
		@update:model-value="$emit('update:modelValue', $event)">
		<div class="h-[70vh] rounded-xl overflow-hidden border border-zinc-200 dark:border-zinc-800 relative">
			<VueFlow :nodes="nodes" :edges="edges" :min-zoom="0.2" :max-zoom="2"
				:nodes-draggable="false" :nodes-connectable="false" :edges-updatable="false"
				class="revision-flow" @pane-ready="onPaneReady">
				<Background pattern-color="#888" :gap="24" />
				<Controls :show-interactive="false" />
				<template #node-revision="props">
					<RevisionGraphNode v-bind="props" />
				</template>
			</VueFlow>
			<p class="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] text-zinc-400 bg-white/70 dark:bg-zinc-900/70 backdrop-blur px-2 py-1 rounded-lg pointer-events-none">
				Click a revision to switch — branch by editing or prompting from there
			</p>
		</div>
	</Modal>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { VueFlow, useVueFlow, type Edge, type Node } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { Modal } from 'pilotui/complex'
import type { EditorRevision } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'
import RevisionGraphNode from './RevisionGraphNode.vue'

const props = defineProps<{ modelValue: boolean }>()
defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

const store = useEditorStore()
const { fitView } = useVueFlow()

const COL_W = 280   // horizontal spread per branch column
const ROW_H = 170   // vertical distance per generation

/**
 * Tidy tree layout: every node sits at (column · COL_W, depth · ROW_H).
 * A node's column = its FIRST child's column (main line stays vertical);
 * leaves claim the next free column, so sibling branches fan right without
 * collisions — the same visual convention as the chat graph.
 */
const layout = computed(() => {
	const positions = new Map<string, { x: number; y: number }>()
	let nextColumn = 0

	const assign = (rev: EditorRevision, depth: number): number => {
		const children = store.revisionChildren.get(rev.id) || []
		let column: number
		if (children.length === 0) {
			column = nextColumn++
		} else {
			const childColumns = children.map((c) => assign(c, depth + 1))
			column = childColumns[0]
		}
		positions.set(rev.id, { x: column * COL_W, y: depth * ROW_H })
		return column
	}

	for (const root of store.revisionChildren.get(null) || []) assign(root, 0)
	return positions
})

const nodes = computed<Node[]>(() =>
	store.revisions.map((rev) => ({
		id: rev.id,
		type: 'revision',
		position: layout.value.get(rev.id) || { x: 0, y: 0 },
		data: { revision: rev },
		draggable: false
	}))
)

const edges = computed<Edge[]>(() =>
	store.revisions
		.filter((rev) => rev.parentId !== null)
		.map((rev) => ({
			id: `e-${rev.parentId}-${rev.id}`,
			source: rev.parentId!,
			target: rev.id,
			animated: false
		}))
)

const onPaneReady = () => fitView({ padding: 0.2 })

watch(() => props.modelValue, (open) => {
	if (open) setTimeout(() => fitView({ padding: 0.2 }), 50)
})
</script>

<style scoped>
.revision-flow {
	width: 100%;
	height: 100%;
}
</style>
