<template>
  <div class="h-full w-full flex flex-col relative bg-zinc-50 dark:bg-zinc-950 overflow-hidden">
    <!-- Ambient Backgrounds -->
    <div
      class="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] bg-primary/20 dark:bg-primary/10 rounded-full blur-[140px] pointer-events-none transition-all duration-1000 animate-pulse-soft">
    </div>
    <div
      class="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-secondary/20 dark:bg-secondary/10 rounded-full blur-[140px] pointer-events-none transition-all duration-1000 animate-pulse-soft">
    </div>

    <GraphHeader 
      :title="videoStore.currentVideoName" 
      :total-cost="totalCost"
      @back="router.push('/home')"
    />
    
    <div 
      ref="containerRef" 
      class="flex-1 w-full relative"
      @mousedown="onPaneMouseDown"
      @mousemove="onPaneMouseMove"
      @mouseup="onPaneMouseUp"
    >
      <GraphToolbar v-model="graphMode" />

      <VueFlow :nodes="graphStore.nodes" :edges="graphStore.edges" 
        :class="['vue-flow-custom', { 'pan-mode': graphMode === 'pan' }]" 
        @pane-ready="onPaneReady"
        @node-drag-stop="onNodeDragStop" :min-zoom="0.01" :max-zoom="4"
        :pan-on-drag="graphMode === 'pan'" 
        :nodes-draggable="graphMode !== 'pan'"
        :selection-key-code="graphMode === 'select' ? true : null" 
        :pan-on-scroll="true"
        :zoom-on-scroll="true"
        :pan-on-scroll-mode="'all'"
        :selection-mode="'partial'">
        <Background pattern-color="#888" :gap="20" />
        <Controls />

        <template #node-conversation="props">
          <ConversationNode v-bind="props"
            @node-resize-stop="videoStore.updateNodeMetadata(props.id, { width: $event })" />
        </template>
        <template #node-task="props">
          <TaskProgressNode v-bind="props" />
        </template>
        <template #node-thumbnail="props">
          <ThumbnailNode v-bind="props" @toggle-details="videoStore.updateNodeMetadata(props.id, { showDetails: $event })" />
        </template>
        <template #node-summary="props">
          <SummaryNode v-bind="props" />
        </template>
        <template #node-image-collection="props">
          <ImageCollectionNode v-bind="props" />
        </template>
        <template #node-frame="props">
          <FrameNode v-bind="props" />
        </template>
      </VueFlow>

      <!-- Frame Creation Overlay -->
      <div v-if="frameCreationRect" class="absolute border-2 border-dashed border-secondary bg-secondary/5 pointer-events-none z-50 rounded-xl"
        :style="{ 
          left: `${frameCreationRect.x}px`, 
          top: `${frameCreationRect.y}px`, 
          width: `${frameCreationRect.width}px`, 
          height: `${frameCreationRect.height}px` 
        }">
        <div class="absolute -top-6 left-0 text-[10px] font-bold text-secondary uppercase tracking-widest bg-white/80 dark:bg-zinc-900/80 px-2 py-0.5 rounded">Creating Frame...</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref } from 'vue'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
// Vue Flow CSS is imported once in main.ts — it is shared with the editor's
// revision graph, which has no import of its own.

import { useGraphStore } from '../stores/graphStore'
import { useTaskStore } from '../stores/taskStore'
import { useVideoStore } from '../stores/videoStore'
import { useRoute, useRouter } from 'vue-router'
import { isLegacyVideoThread } from '@shared/legacy'

import ConversationNode from '../components/graph/ConversationNode.vue'
import TaskProgressNode from '../components/graph/TaskProgressNode.vue'
import ThumbnailNode from '../components/graph/ThumbnailNode.vue'
import SummaryNode from '../components/graph/SummaryNode.vue'
import ImageCollectionNode from '../components/graph/ImageCollectionNode.vue'
import FrameNode from '../components/graph/FrameNode.vue'

import { useGraphLayout } from '../composables/useGraphLayout'
import GraphHeader from '../components/graph/GraphHeader.vue'
import GraphToolbar from '../components/graph/GraphToolbar.vue'

const graphMode = ref<'pan' | 'select' | 'frame'>('select')
const isTemporaryPan = ref(false)
const containerRef = ref<HTMLElement | null>(null)
const frameCreationRect = ref<{ x: number, y: number, width: number, height: number } | null>(null)
const frameCreationStart = ref<{ x: number, y: number } | null>(null)

const graphStore = useGraphStore()
const taskStore = useTaskStore()
const videoStore = useVideoStore()
const { fitView, project, findNode, getNodes } = useVueFlow()
const route = useRoute()
const router = useRouter()

// Use modular layout logic
useGraphLayout(videoStore, graphStore)

const totalCost = computed(() => {
  return (videoStore.currentThread?.usageHistory || []).reduce((acc, record) => acc + (record.cost || 0), 0)
})

const onPaneReady = () => {
  fitView()
}

const onNodeDragStop = (event: any) => {
  const { nodes: draggedNodes } = event
  const newPositions: any = {}

  // Current graph state - get live instances for accurate positions/dimensions
  const allNodes = getNodes.value
  const frames = allNodes.filter(n => n.type === 'frame')

  draggedNodes.forEach((nodeSnapshot: any) => {
    // Get live node from internal state to ensure computedPosition is absolute
    const node = findNode(nodeSnapshot.id)
    if (!node) return

    const nx = node.computedPosition?.x ?? node.position.x
    const ny = node.computedPosition?.y ?? node.position.y
    const nw = node.dimensions?.width || nodeSnapshot.dimensions?.width || 380
    const nh = node.dimensions?.height || nodeSnapshot.dimensions?.height || 200

    const nodeCenter = {
      x: nx + nw / 2,
      y: ny + nh / 2
    }

    // If it's a frame, update its absolute world coordinates
    if (node.type === 'frame') {
      const currentMeta = videoStore.currentThread?.nodePositions?.[node.id] || {}
      newPositions[node.id] = { 
        ...currentMeta,
        x: nx,
        y: ny
      }
      return
    }

    let parentFrameId: string | undefined = undefined
    
    // Scan all frames using their absolute positions
    for (const frame of frames) {
      const fx = frame.computedPosition?.x ?? frame.position.x
      const fy = frame.computedPosition?.y ?? frame.position.y
      const fw = frame.dimensions?.width || frame.data.width || 400
      const fh = frame.dimensions?.height || frame.data.height || 300

      if (nodeCenter.x >= fx && nodeCenter.x <= fx + fw &&
          nodeCenter.y >= fy && nodeCenter.y <= fy + fh) {
        parentFrameId = frame.id
        break
      }
    }

    const currentMeta = videoStore.currentThread?.nodePositions?.[node.id] || {}
    
    if (parentFrameId) {
      const frameNode = findNode(parentFrameId)
      if (frameNode) {
        // Correct conversion to local frame coordinates:
        // Absolute Node Pos - Absolute Frame Pos = Relative Local Offset
        const fx = frameNode.computedPosition?.x ?? frameNode.position.x
        const fy = frameNode.computedPosition?.y ?? frameNode.position.y
        
        newPositions[node.id] = { 
          ...currentMeta,
          x: nx - fx, 
          y: ny - fy, 
          parentNode: parentFrameId 
        }
      }
    } else {
      // Return to absolute world coordinates if not over any frame
      newPositions[node.id] = { 
        ...currentMeta,
        x: nx, 
        y: ny, 
        parentNode: null 
      }
    }
  })

  videoStore.updateNodePositions(newPositions)
}

const onPaneMouseDown = (event: MouseEvent) => {
  if (graphMode.value !== 'frame' || !containerRef.value) return
  
  // Ensure we are clicking the background, not a node or toolbar
  const target = event.target as HTMLElement
  if (target.closest('.vue-flow__node') || target.closest('button')) return

  const rect = containerRef.value.getBoundingClientRect()
  const x = event.clientX - rect.left
  const y = event.clientY - rect.top

  frameCreationStart.value = { x, y }
  frameCreationRect.value = { x, y, width: 0, height: 0 }
}

const onPaneMouseMove = (event: MouseEvent) => {
  if (!frameCreationStart.value || graphMode.value !== 'frame' || !containerRef.value) return

  const rect = containerRef.value.getBoundingClientRect()
  const currentX = event.clientX - rect.left
  const currentY = event.clientY - rect.top
  
  const startX = frameCreationStart.value.x
  const startY = frameCreationStart.value.y

  frameCreationRect.value = {
    x: Math.min(startX, currentX),
    y: Math.min(startY, currentY),
    width: Math.abs(currentX - startX),
    height: Math.abs(currentY - startY)
  }
}

const uuid = () => Math.random().toString(36).substring(2, 9)

const onPaneMouseUp = async (event: MouseEvent) => {
  if (!frameCreationRect.value || !frameCreationStart.value || graphMode.value !== 'frame') {
    frameCreationStart.value = null
    frameCreationRect.value = null
    return
  }

  const rect = frameCreationRect.value
  
  // Only create if it's large enough
  if (rect.width > 20 && rect.height > 20) {
    // Project viewport coordinates to flow coordinates
    const flowPos = project({ x: rect.x, y: rect.y })
    const flowDim = project({ x: rect.x + rect.width, y: rect.y + rect.height })
    const width = flowDim.x - flowPos.x
    const height = flowDim.y - flowPos.y

    const frameId = `frame-${uuid()}`
    
    // 1. Create the frame node in store
    await videoStore.updateNodeMetadata(frameId, {
      x: flowPos.x,
      y: flowPos.y,
      width,
      height,
      title: 'New Group',
      isFrame: true,
      onDelete: async () => {
        const result = await (window as any).api.showConfirmation({
          title: 'Delete Frame',
          message: 'Are you sure you want to delete this frame?',
          detail: 'Children nodes will be ungrouped but NOT deleted.',
          type: 'warning'
        })
        if (result.response === 1) {
          await videoStore.deleteFrame(frameId)
        }
      }
    })

    // 2. Identify nodes inside and group them
    const allNodes = getNodes.value
    const nodesToGroup = allNodes.filter(node => {
      if (node.type === 'frame' || node.id === frameId) return false
      
      const nx = node.computedPosition.x
      const ny = node.computedPosition.y
      
      return nx >= flowPos.x && nx <= flowPos.x + width &&
             ny >= flowPos.y && ny <= flowPos.y + height
    })

    const groupUpdates: any = {}
    nodesToGroup.forEach(node => {
      const currentMeta = videoStore.currentThread?.nodePositions?.[node.id] || {}
      groupUpdates[node.id] = {
        ...currentMeta,
        x: node.computedPosition.x - flowPos.x,
        y: node.computedPosition.y - flowPos.y,
        parentNode: frameId
      }
    })

    if (Object.keys(groupUpdates).length > 0) {
      await videoStore.updateNodePositions(groupUpdates)
    }
    
    // Switch back to pan mode after creation
    graphMode.value = 'pan'
  }

  frameCreationStart.value = null
  frameCreationRect.value = null
}

const handleKeyDown = (e: KeyboardEvent) => {
  if (e.code === 'Space' && !isTemporaryPan.value) {
    const activeElement = document.activeElement
    const isInput = activeElement && (
      activeElement.tagName === 'INPUT' || 
      activeElement.tagName === 'TEXTAREA' || 
      (activeElement as HTMLElement).isContentEditable
    )
    
    if (!isInput) {
      e.preventDefault()
      if (graphMode.value !== 'pan') {
        graphMode.value = 'pan'
        isTemporaryPan.value = true
      }
    }
  }
}

const handleKeyUp = (e: KeyboardEvent) => {
  if (e.code === 'Space' && isTemporaryPan.value) {
    graphMode.value = 'select'
    isTemporaryPan.value = false
  }
}

onMounted(async () => {
  const videoId = route.params.id as string || 'default'

  if (videoId !== 'default') {
    await videoStore.selectThread(videoId)

    // Deep link to a thread from the retired AI video pipeline: this page can no
    // longer render it (its root node and result nodes are gone). Bounce rather
    // than draw an empty canvas.
    const thread = videoStore.currentThread
    if (thread && isLegacyVideoThread(thread)) {
      router.replace('/home')
      return
    }
  }

  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
})
</script>

<style>
.vue-flow-custom {
  --vf-bg: transparent;
}

.vue-flow__node {
  border: none;
  background: transparent;
  padding: 0;
  border-radius: 0;
}

/* Ensure normal pane cursor in selection mode */
.vue-flow-custom:not(.pan-mode) .vue-flow__pane {
  cursor: default !important;
}

/* Pan Mode Interactions - Simplified for maximum navigation reliability */
.pan-mode.vue-flow-custom {
  cursor: grab !important;
  user-select: none !important;
}

.pan-mode.vue-flow-custom .vue-flow__pane {
  cursor: grab !important;
}

.pan-mode.vue-flow-custom .vue-flow__pane.dragging {
  cursor: grabbing !important;
}

/* Force grab cursor on EVERYTHING in pan mode */
.pan-mode.vue-flow-custom * {
  cursor: inherit !important;
}

/* Exception: allow text cursor ONLY when typing in a focused input */
.pan-mode.vue-flow-custom input:focus,
.pan-mode.vue-flow-custom textarea:focus {
  cursor: text !important;
  user-select: auto !important;
}

/* Disable interaction on graph elements to allow perfect click-through panning */
.pan-mode.vue-flow-custom .vue-flow__node,
.pan-mode.vue-flow-custom .vue-flow__edge,
.pan-mode.vue-flow-custom .vue-flow__handle,
.pan-mode.vue-flow-custom .vue-flow__edge-path {
  pointer-events: none !important;
}

/* Re-enable interaction specifically for chat inputs */
.pan-mode.vue-flow-custom .interactive-in-pan {
  pointer-events: auto !important;
  user-select: auto !important;
}
</style>
