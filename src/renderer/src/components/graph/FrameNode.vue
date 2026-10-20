<template>
  <div
    class="frame-node rounded border border-dashed relative group"
    :class="[
      selected ? 'border-primary bg-primary/[0.04]' : 'border-[color:var(--ff-hairline-strong)] bg-transparent',
      isResizing ? 'cursor-nwse-resize' : (data.isLocked ? 'cursor-default' : 'cursor-move')
    ]"
    :style="{
      width: `${nodeWidth}px`,
      height: `${nodeHeight}px`,
    }"
  >
    <!-- Zoom-sensitive title -->
    <div
      class="absolute -top-8 left-0 flex items-center gap-2 px-0.5"
      :style="{
        transform: `scale(${1 / Math.max(0.4, viewport.zoom)})`,
        transformOrigin: 'bottom left'
      }"
    >
      <input
        v-if="isEditing"
        ref="inputRef"
        v-model="editTitle"
        class="bg-transparent border-b border-primary outline-none px-0.5 py-0.5 font-semibold text-xs text-zinc-900 dark:text-zinc-100 min-w-[120px]"
        @blur="saveTitle"
        @keydown.enter="saveTitle"
        @keydown.esc="cancelEditing"
      />
      <div v-else class="flex items-center gap-1.5 cursor-text group/title" @dblclick="startEditing">
        <span class="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300 whitespace-nowrap">
          {{ data.title || 'Untitled Group' }}
        </span>
        <button
          class="opacity-0 group-hover/title:opacity-100 text-zinc-400 hover:text-primary transition-colors"
          aria-label="Rename frame"
          @click="startEditing"
        >
          <span class="iconify tabler--pencil w-3 h-3"></span>
        </button>
      </div>
    </div>

    <!-- Actions -->
    <div
      v-if="selected"
      class="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-50 pointer-events-auto"
    >
      <SlimTooltip :text="data.isLocked ? 'Unlock Frame' : 'Lock Frame (prevents move/resize)'" placement="left">
        <button class="node-icon-btn" :class="data.isLocked ? '!text-primary' : ''"
          :aria-label="data.isLocked ? 'Unlock Frame' : 'Lock Frame'" @click.stop="toggleLock">
          <span class="iconify w-3.5 h-3.5" :class="data.isLocked ? 'tabler--lock' : 'tabler--lock-open'"></span>
        </button>
      </SlimTooltip>

      <!-- Delete (only if not locked) -->
      <SlimTooltip v-if="!data.isLocked" text="Delete Frame (ungroup children)" placement="left">
        <button class="node-icon-btn hover:!text-red-500" aria-label="Delete Frame" @click.stop="data.onDelete">
          <span class="iconify tabler--x w-3.5 h-3.5"></span>
        </button>
      </SlimTooltip>
    </div>

    <!-- Resize handle -->
    <div
      v-if="selected && !data.isLocked"
      class="absolute bottom-1.5 right-1.5 w-5 h-5 flex items-center justify-center cursor-nwse-resize text-zinc-400 dark:text-zinc-600 hover:text-primary transition-colors opacity-0 group-hover:opacity-100"
      @mousedown.stop.prevent="startResizing"
    >
      <span class="iconify tabler--arrow-down-right w-4 h-4"></span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useVueFlow } from '@vue-flow/core'
import SlimTooltip from '../SlimTooltip.vue'

const props = defineProps<{
  id: string
  data: {
    title: string
    width: number
    height: number
    isLocked?: boolean
    onUpdate?: (id: string, metadata: any) => void
    onDelete?: () => void
  }
  selected?: boolean
}>()

const { viewport } = useVueFlow()

const nodeWidth = ref(props.data.width || 400)
const nodeHeight = ref(props.data.height || 300)

const isResizing = ref(false)
const toggleLock = () => {
  if (props.data.onUpdate) {
    props.data.onUpdate(props.id, { isLocked: !props.data.isLocked })
  }
}

const startResizing = (e: MouseEvent) => {
  if (props.data.isLocked) return
  isResizing.value = true
  document.body.style.cursor = 'nwse-resize'
  document.body.style.userSelect = 'none'
  
  const startX = e.clientX
  const startY = e.clientY
  const startWidth = nodeWidth.value
  const startHeight = nodeHeight.value

  const onMouseMove = (moveEvent: MouseEvent) => {
    if (!isResizing.value) return
    const zoom = viewport.value.zoom || 1
    const deltaX = (moveEvent.clientX - startX) / zoom
    const deltaY = (moveEvent.clientY - startY) / zoom
    
    nodeWidth.value = Math.max(200, startWidth + deltaX)
    nodeHeight.value = Math.max(150, startHeight + deltaY)
  }

  const onMouseUp = () => {
    isResizing.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    
    if (props.data.onUpdate) {
      props.data.onUpdate(props.id, { 
        width: nodeWidth.value, 
        height: nodeHeight.value 
      })
    }
  }

  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

// Title Editing logic
const isEditing = ref(false)
const editTitle = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

const startEditing = () => {
  editTitle.value = props.data.title || 'Untitled Group'
  isEditing.value = true
  nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
}

const saveTitle = () => {
  if (!isEditing.value) return
  isEditing.value = false
  if (props.data.onUpdate) {
    props.data.onUpdate(props.id, { title: editTitle.value })
  }
}

const cancelEditing = () => {
  isEditing.value = false
}

// Sync from props
watch(() => props.data.width, (v) => { if (v) nodeWidth.value = v })
watch(() => props.data.height, (v) => { if (v) nodeHeight.value = v })

</script>

<style scoped>
.frame-node {
  /* Ensure the node is behind others but not interactive for background clicks unless needed */
  z-index: -1;
}
</style>
