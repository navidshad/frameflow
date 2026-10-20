<template>
  <div class="node-panel min-w-[300px] max-w-[340px] group cursor-move">
    <Handle v-if="data.hasInput !== false" type="target" :position="Position.Top" class="node-handle" />

    <!-- Header -->
    <div class="node-head cursor-move">
      <span class="node-dot bg-primary"></span>
      <span class="lbl !text-zinc-800 dark:!text-zinc-200">Source collection</span>
    </div>

    <!-- Name + counts -->
    <div class="px-3 pt-2.5 pb-2 cursor-move">
      <div class="text-xs font-semibold truncate" :title="data.filename || 'Project Images'">{{ data.filename || 'Project Images' }}</div>
      <div class="flex gap-2 mt-1 text-[10px] font-bold uppercase tracking-wide">
        <!-- An image-purpose thread can carry a reference video. -->
        <span v-if="referenceVideo" class="text-accent" :title="referenceVideo">Ref video</span>
        <span class="text-zinc-500 dark:text-zinc-400">{{ sourceImages.length }} Files</span>
      </div>
    </div>

    <!-- Image grid -->
    <div class="grid grid-cols-3 gap-1 px-3 pb-3">
      <button v-for="(img, idx) in visibleImages" :key="idx" type="button" aria-label="Open image"
        class="relative aspect-square rounded-[2px] overflow-hidden group/img cursor-pointer nodrag"
        :style="{ border: '1px solid var(--ff-hairline)' }" @click="openLightbox(idx)">
        <img :src="mediaUrl(img)" class="w-full h-full object-cover" draggable="false" />
        <span v-if="idx === 5 && sourceImages.length > 6" class="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-xs font-semibold font-mono">
          +{{ sourceImages.length - 6 }}
        </span>
      </button>
    </div>

    <!-- Active tasks progress -->
    <div v-if="activeTasks.length > 0" class="px-3 py-2 hair-t space-y-2 nodrag cursor-text">
      <div v-for="task in activeTasks" :key="task.id" class="text-[10px] select-text">
        <div class="flex justify-between items-center mb-1 text-zinc-500 dark:text-zinc-400">
          <span class="truncate pr-2 font-semibold uppercase tracking-tight">{{ task.status || task.name }}</span>
          <span class="font-mono">{{ task.progress !== undefined ? `${task.progress}%` : '' }}</span>
        </div>
        <div class="h-0.5 w-full bg-zinc-200 dark:bg-white/10">
          <div class="h-full bg-primary transition-all duration-300" :style="{ width: `${task.progress}%` }"></div>
        </div>
      </div>
    </div>

    <BaseMessageInput
      v-model="input"
      v-model:attachedImages="attachedImages"
      placeholder="Start a new analysis..."
      compact
      class="nodrag"
      @send="submit"
    />

    <!-- Lightbox -->
    <Teleport to="body">
      <div v-if="lightboxIdx !== null" class="fixed inset-0 z-[9999] bg-black/90 flex flex-col items-center justify-center p-8">
        <SlimTooltip text="Close Lightbox" placement="bottom">
          <button @click="lightboxIdx = null" aria-label="Close Lightbox"
            class="absolute top-6 right-6 w-8 h-8 flex items-center justify-center rounded-md text-white/80 hover:text-white hover:bg-white/10 transition z-50">
            <span class="iconify tabler--x w-5 h-5"></span>
          </button>
        </SlimTooltip>

        <img :src="mediaUrl(sourceImages[lightboxIdx])" class="max-w-full max-h-[80vh] rounded-[3px] object-contain" />

        <div class="mt-6 flex items-center gap-5">
          <SlimTooltip text="Previous Image" placement="top">
            <button @click="prevImg" aria-label="Previous Image"
              class="w-9 h-9 flex items-center justify-center rounded-md text-white/80 hover:text-white hover:bg-white/10 transition disabled:opacity-20" :disabled="lightboxIdx === 0">
              <span class="iconify tabler--chevron-left w-5 h-5"></span>
            </button>
          </SlimTooltip>
          <div class="text-zinc-400 font-mono text-xs tracking-widest">{{ lightboxIdx + 1 }} / {{ sourceImages.length }}</div>
          <SlimTooltip text="Next Image" placement="top">
            <button @click="nextImg" aria-label="Next Image"
              class="w-9 h-9 flex items-center justify-center rounded-md text-white/80 hover:text-white hover:bg-white/10 transition disabled:opacity-20" :disabled="lightboxIdx === sourceImages.length - 1">
              <span class="iconify tabler--chevron-right w-5 h-5"></span>
            </button>
          </SlimTooltip>
        </div>
      </div>
    </Teleport>

    <Handle type="source" :position="Position.Bottom" class="node-handle node-handle-out" />
  </div>
</template>

<script setup lang="ts">
import { toMediaUrl } from '@shared/media-url'
import { ref, computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import SlimTooltip from '../SlimTooltip.vue'
import { useVideoStore } from '../../stores/videoStore'
import BaseMessageInput from '../chat/BaseMessageInput.vue'

const props = defineProps<{ data: any }>()
const videoStore = useVideoStore()
const input = ref('')
const attachedImages = ref<string[]>([])
const lightboxIdx = ref<number | null>(null)

const sourceImages = computed(() => videoStore.currentThread?.preprocessing?.sourceImages || [])
const referenceVideo = computed(() => videoStore.currentThread?.videoPath || null)
const visibleImages = computed(() => sourceImages.value.slice(0, 6))

const activeTasks = computed(() => {
  return Object.values(videoStore.backgroundTasks || {})
    .filter(t => t.state === 'running' || t.state === 'pending')
})


const mediaUrl = (url: string) => toMediaUrl(url)

const submit = (text: string, images: string[], count: number, isThinkingMode: boolean, autoUseImages: boolean) => {
  if ((text.trim() || images.length > 0) && props.data.onSubmit) {
    props.data.onSubmit(text, images, count, isThinkingMode, autoUseImages)
    input.value = ''
    attachedImages.value = []
  }
}

const openLightbox = (idx: number) => {
  lightboxIdx.value = idx
}

const prevImg = () => {
  if (lightboxIdx.value !== null && lightboxIdx.value > 0) lightboxIdx.value--
}

const nextImg = () => {
  if (lightboxIdx.value !== null && lightboxIdx.value < sourceImages.value.length - 1) lightboxIdx.value++
}

</script>
