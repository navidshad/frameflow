<template>
  <div class="node-panel min-w-[250px] cursor-move">
    <Handle type="target" :position="Position.Top" class="node-handle" />

    <!-- Header: amber while it works -->
    <div class="node-head cursor-move">
      <span class="node-dot" :class="{
        'bg-amber-400 animate-pulse': data.status === 'running',
        'bg-accent-light': data.status === 'completed',
        'bg-red-500': data.status === 'failed',
        'bg-zinc-400': !['running', 'completed', 'failed'].includes(data.status)
      }"></span>
      <span class="lbl !text-zinc-800 dark:!text-zinc-200">Task · {{ data.type || 'Task' }}</span>
      <div class="flex-1"></div>
      <SlimTooltip v-if="data.onDelete" text="Delete task node" placement="top">
        <button @click="data.onDelete" aria-label="Delete task node" class="node-icon-btn hover:!text-red-500 nodrag">
          <span class="iconify tabler--trash w-3.5 h-3.5"></span>
        </button>
      </SlimTooltip>
    </div>

    <div class="p-3 space-y-2">
      <!-- Status + stop -->
      <div class="flex items-center gap-2 text-xs">
        <span v-if="data.status === 'running'" class="iconify tabler--loader-2 w-3.5 h-3.5 animate-spin text-primary"></span>
        <span v-else-if="data.status === 'completed'" class="iconify tabler--check w-3.5 h-3.5 text-accent"></span>
        <span v-else-if="data.status === 'failed'" class="iconify tabler--x w-3.5 h-3.5 text-red-500"></span>
        <span class="flex-1 capitalize">{{ data.status || 'pending' }}</span>
        <SlimTooltip v-if="data.onStop && data.status === 'running'" :text="isConfirmingStop ? 'Click again to confirm' : 'Stop process'" placement="top">
          <button @click="handleStop"
            class="text-[11px] font-semibold nodrag transition-colors"
            :class="isConfirmingStop ? 'text-amber-500 animate-pulse' : 'text-red-500 hover:text-red-600'">
            {{ isConfirmingStop ? 'Confirm?' : 'Stop' }}
          </button>
        </SlimTooltip>
      </div>

      <!-- Progress steps -->
      <div class="space-y-1 nodrag cursor-text font-mono text-[11px]">
        <div v-for="(step, index) in data.steps" :key="index" class="flex items-center gap-2">
          <span v-if="step.status === 'done'" class="text-accent">✓</span>
          <span v-else-if="step.status === 'active'" class="text-primary">●</span>
          <span v-else class="text-zinc-400">○</span>
          <span :class="step.status === 'active' ? 'text-zinc-900 dark:text-zinc-100 font-semibold' : 'text-zinc-500 dark:text-zinc-400'">
            {{ step.name }}
          </span>
        </div>
      </div>

      <!-- Overall progress -->
      <div v-if="data.progress !== undefined && data.progress !== null" class="h-0.5 w-full bg-zinc-200 dark:bg-white/10">
        <div class="h-full bg-primary transition-all duration-500" :style="{ width: `${data.progress}%` }"></div>
      </div>
    </div>

    <Handle type="source" :position="Position.Bottom" class="node-handle node-handle-out" />
  </div>
</template>

<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import SlimTooltip from '../SlimTooltip.vue'

const props = defineProps<{ data: any }>()

const isConfirmingStop = ref(false)
let stopTimeout: NodeJS.Timeout | null = null

const handleStop = () => {
  if (!isConfirmingStop.value) {
    isConfirmingStop.value = true
    stopTimeout = setTimeout(() => {
      isConfirmingStop.value = false
    }, 3000)
    return
  }

  // Actual stop
  if (stopTimeout) clearTimeout(stopTimeout)
  isConfirmingStop.value = false
  props.data.onStop?.()
}

onBeforeUnmount(() => {
  if (stopTimeout) clearTimeout(stopTimeout)
})
</script>
