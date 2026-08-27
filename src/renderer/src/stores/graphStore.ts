import { defineStore } from 'pinia'
import { ref, type Ref } from 'vue'
import type { Node, Edge } from '@vue-flow/core'

export const useGraphStore = defineStore('graph', () => {
  // `ref([]) as Ref<T[]>`, not `ref<T[]>([])`: Vue's UnwrapRef recursion over
  // vue-flow's Node/Edge types exceeds TypeScript's instantiation depth
  // (TS2589) from Vue 3.5.42 on. The cast short-circuits the type computation;
  // runtime behaviour is an ordinary deep ref, unchanged.
  const nodes = ref([]) as Ref<Node[]>
  const edges = ref([]) as Ref<Edge[]>

  const addNode = (node: Node) => {
    nodes.value.push(node)
  }

  const addEdge = (edge: Edge) => {
    edges.value.push(edge)
  }

  const setNodes = (newNodes: Node[]) => {
    nodes.value = newNodes
  }

  const setEdges = (newEdges: Edge[]) => {
    edges.value = newEdges
  }

  return { nodes, edges, addNode, addEdge, setNodes, setEdges }
})
