<template>
  <div
    class="px-5 py-3 z-20 w-full flex items-center justify-between bg-zinc-50 dark:bg-zinc-950/80 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800 shadow-sm flex-shrink-0">
    <div class="flex items-center gap-4 flex-1 min-w-0">
      <SlimTooltip text="Back to Home" placement="bottom">
        <button @click="$emit('back')"
          class="flex items-center justify-center w-8 h-8 bg-zinc-100 dark:bg-zinc-800 rounded-full border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition text-zinc-600 dark:text-zinc-300 flex-shrink-0">
          <svg class="w-4 h-4 ml-[-2px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"></path>
          </svg>
        </button>
      </SlimTooltip>

      <!-- Editable title (editor projects) — click to rename in place -->
      <input v-if="editable && renaming" ref="titleInput" v-model="draft"
        class="text-xl font-bold font-heading text-zinc-900 dark:text-zinc-100 tracking-tight min-w-[200px] max-w-[40%] ml-2 bg-transparent border-b border-primary/50 outline-none"
        @keydown.enter.prevent="commitRename" @keydown.esc.prevent="cancelRename" @blur="commitRename" />
      <button v-else-if="editable"
        class="group/title flex items-center gap-1.5 min-w-0 max-w-[40%] ml-2"
        title="Rename project" @click="startRename">
        <span class="text-xl font-bold font-heading text-zinc-900 dark:text-zinc-100 truncate tracking-tight">
          {{ title || 'Untitled Project' }}
        </span>
        <span class="iconify tabler--pencil w-3.5 h-3.5 text-zinc-400 opacity-0 group-hover/title:opacity-100 transition shrink-0"></span>
      </button>
      <h1 v-else
        class="text-xl font-bold font-heading text-zinc-900 dark:text-zinc-100 truncate tracking-tight min-w-[200px] max-w-[40%] ml-2">
        {{ title || 'Graph Task Manager' }}
      </h1>

      <!-- Vertical Separator -->
      <div v-if="totalCost > 0" class="h-6 w-px bg-zinc-200 dark:bg-zinc-800 mx-1 flex-shrink-0"></div>

      <!-- Project Cost -->
      <div v-if="totalCost > 0"
        class="flex items-center px-3 py-1.5 bg-zinc-100 dark:bg-zinc-900/40 rounded-xl border border-zinc-200 dark:border-zinc-800/40 transition-all hover:border-green-500/30 group flex-shrink-0">
        <div class="flex flex-col items-start leading-none gap-0.5">
          <span
            class="text-[8px] font-black uppercase tracking-widest text-zinc-500 group-hover:text-green-500 transition-colors leading-none">Project
            Cost</span>
          <span
            class="text-xs font-mono font-bold text-zinc-900 dark:text-zinc-100 italic transition-transform group-hover:scale-105 leading-none">${{
              totalCost.toFixed(4) }}</span>
        </div>
        <div class="ml-3 p-1 bg-green-500/10 rounded-lg group-hover:bg-green-500/20 transition-colors">
          <svg class="w-3.5 h-3.5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z">
            </path>
          </svg>
        </div>
      </div>
    </div>

    <!-- Right Action Area -->
    <div class="flex items-center justify-end gap-3 min-w-[20px] mr-12">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
import SlimTooltip from '../SlimTooltip.vue'

const props = defineProps<{
  title?: string
  totalCost: number
  editable?: boolean
}>()

const emit = defineEmits<{
  (e: 'back'): void
  (e: 'rename', value: string): void
}>()

const renaming = ref(false)
const draft = ref('')
const titleInput = ref<HTMLInputElement | null>(null)

const startRename = async () => {
  draft.value = props.title || ''
  renaming.value = true
  await nextTick()
  titleInput.value?.focus()
  titleInput.value?.select()
}

const commitRename = () => {
  if (!renaming.value) return // guard: blur fires after esc/enter already closed it
  renaming.value = false
  const next = draft.value.trim()
  if (next && next !== props.title) emit('rename', next)
}

const cancelRename = () => {
  renaming.value = false
}
</script>
