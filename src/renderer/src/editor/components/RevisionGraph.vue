<template>
	<div class="w-full h-full relative">
		<VueFlow :nodes="nodes" :edges="edges" :min-zoom="0.2" :max-zoom="2"
			:nodes-draggable="false" :nodes-connectable="false" :edges-updatable="false"
			class="revision-flow" @pane-ready="onPaneReady">
			<Background pattern-color="#888" :gap="compact ? 16 : 24" />
			<Controls :show-interactive="false" />
			<template #node-revision="nodeProps">
				<RevisionGraphNode v-bind="nodeProps" />
			</template>
		</VueFlow>
		<p v-if="!compact"
			class="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] text-zinc-400 bg-white/70 dark:bg-zinc-900/70 backdrop-blur px-2 py-1 rounded-lg pointer-events-none">
			Click a revision to switch — branch by editing or prompting from there
		</p>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch, nextTick } from 'vue'
import { VueFlow, useVueFlow, type Edge, type Node } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import type { EditorRevision } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'
import RevisionGraphNode from './RevisionGraphNode.vue'

const props = withDefaults(defineProps<{
	/** Inline in the ~300px side panel. Shrinks the layout and centres rather than fits. */
	compact?: boolean
}>(), { compact: false })

const store = useEditorStore()
const { fitView, setCenter, getNodes } = useVueFlow()

// Compact has to fit a 148px card in a ~300px column; the roomy values are what
// the overlay uses, matching the chat graph's visual convention.
const COL_W = computed(() => (props.compact ? 170 : 280)) // horizontal spread per branch column
const ROW_H = computed(() => (props.compact ? 104 : 170)) // vertical distance per generation

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
		positions.set(rev.id, { x: column * COL_W.value, y: depth * ROW_H.value })
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
		data: { revision: rev, compact: props.compact },
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

/**
 * Compact centres on the current revision at 1× instead of fitting the tree.
 * fitView on a multi-column tree inside a 300px column drives zoom to the 0.2
 * floor and renders unreadable cards — inline is the LOCAL view ("where am I"),
 * the overlay is the global one.
 */
const focus = () => {
	if (!props.compact) {
		fitView({ padding: 0.2, maxZoom: 1 })
		return
	}
	const currentId = store.doc?.currentRevisionId
	const node = currentId ? getNodes.value.find((n) => n.id === currentId) : null
	if (node) {
		const w = node.dimensions?.width || 148
		const h = node.dimensions?.height || 88
		setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1 })
	} else {
		fitView({ padding: 0.2, maxZoom: 1 })
	}
}

const onPaneReady = () => focus()
onMounted(() => nextTick(() => setTimeout(focus, 50)))
watch(() => store.doc?.currentRevisionId, () => { if (props.compact) focus() })
</script>

<style scoped>
.revision-flow {
	width: 100%;
	height: 100%;
}
</style>
