<template>
  <div class="glass-card glass-card-hover p-0 rounded-3xl min-w-[300px] max-w-[340px] overflow-hidden flex flex-col group cursor-move">
    <Handle v-if="data.hasInput !== false" type="target" :position="Position.Top" class="w-3 h-3 bg-zinc-500 border-2 border-white dark:border-zinc-800" />
    
    <!-- Gallery Section -->
    <div class="p-4 bg-zinc-950/5 dark:bg-black/40 border-b border-black/5 dark:border-white/5 cursor-move">
      <div class="flex items-center justify-between mb-3">
        <div class="flex flex-col">
          <div class="text-[10px] text-zinc-500 uppercase tracking-[0.2em] font-black leading-none mb-1">Source Collection</div>
          <h3 class="text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate max-w-[180px]">{{ data.filename || 'Project Images' }}</h3>
        </div>
        <div class="flex items-center gap-1.5">
          <!-- An image-purpose thread can carry a reference video. -->
          <div v-if="referenceVideo"
            class="px-2 py-1 rounded-lg bg-zinc-500/10 text-zinc-500 dark:text-zinc-400 text-[10px] font-bold border border-zinc-500/20 flex items-center gap-1"
            :title="referenceVideo">
            <span class="iconify tabler--movie w-3 h-3"></span>
            Ref video
          </div>
          <div class="px-2 py-1 rounded-lg bg-primary/10 text-primary text-[10px] font-bold border border-primary/20">
            {{ sourceImages.length }} Files
          </div>
        </div>
      </div>

      <!-- Image Grid -->
      <div class="grid grid-cols-3 gap-2 py-1">
        <div 
          v-for="(img, idx) in visibleImages" 
          :key="idx"
          class="relative aspect-square rounded-xl overflow-hidden border border-black/5 dark:border-white/10 group/img cursor-pointer nodrag"
          @click="openLightbox(idx)"
        >
          <img :src="mediaUrl(img)" class="w-full h-full object-cover transition-transform duration-500 group-hover/img:scale-110" draggable="false" />
          <div v-if="idx === 5 && sourceImages.length > 6" class="absolute inset-0 bg-black/60 backdrop-blur-[2px] flex items-center justify-center text-white text-xs font-bold font-mono">
            +{{ sourceImages.length - 6 }}
          </div>
        </div>
      </div>
    </div>

    <!-- Active Tasks Progress -->
    <div v-if="activeTasks.length > 0" class="p-3 bg-white/5 border-b border-white/5 space-y-2 nodrag cursor-text">
      <div v-for="task in activeTasks" :key="task.id" class="text-[10px] select-text">
        <div class="flex justify-between items-center mb-1 text-zinc-400">
          <span class="truncate pr-2 font-bold uppercase tracking-tight">{{ task.status || task.name }}</span>
          <span>{{ task.progress !== undefined ? `${task.progress}%` : '' }}</span>
        </div>
        <div class="h-1 w-full bg-zinc-800/50 dark:bg-zinc-800 rounded-full overflow-hidden">
          <div class="h-full bg-primary transition-all duration-300" :style="{ width: `${task.progress}%` }"></div>
        </div>
      </div>
    </div>

    <BaseMessageInput 
      v-model="input"
      v-model:attachedImages="attachedImages"
      placeholder="Start a new analysis..."
      compact
      class="p-2 border-t border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] nodrag"
      @send="submit"
    />

    <!-- Lightbox Modal -->
    <Teleport to="body">
      <div v-if="lightboxIdx !== null" class="fixed inset-0 z-[9999] bg-black/95 flex flex-col items-center justify-center p-8 backdrop-blur-3xl animate-in fade-in duration-300">
        <SlimTooltip text="Close Lightbox" placement="bottom">
          <button @click="lightboxIdx = null" class="absolute top-8 right-8 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-90 z-50">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
          </button>
        </SlimTooltip>
        
        <img :src="mediaUrl(sourceImages[lightboxIdx])" class="max-w-full max-h-[80vh] rounded-2xl shadow-2xl ring-1 ring-white/20 object-contain" />
        
        <div class="mt-8 flex items-center gap-6">
          <SlimTooltip text="Previous Image" placement="top">
            <button @click="prevImg" class="p-4 bg-white/5 hover:bg-white/10 rounded-2xl text-white transition-all active:scale-95 disabled:opacity-20" :disabled="lightboxIdx === 0">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>
            </button>
          </SlimTooltip>
          <div class="text-zinc-400 font-mono text-sm tracking-widest">{{ lightboxIdx + 1 }} / {{ sourceImages.length }}</div>
          <SlimTooltip text="Next Image" placement="top">
            <button @click="nextImg" class="p-4 bg-white/5 hover:bg-white/10 rounded-2xl text-white transition-all active:scale-95 disabled:opacity-20" :disabled="lightboxIdx === sourceImages.length - 1">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
            </button>
          </SlimTooltip>
        </div>
      </div>
    </Teleport>

    <Handle type="source" :position="Position.Bottom" class="w-3 h-3 bg-blue-500 border-2 border-white dark:border-zinc-800" />
  </div>
</template>

<script setup lang="ts">
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


const mediaUrl = (url: string) => {
  if (!url) return ''
  return url.startsWith('media://') ? url : `media://${url}`
}

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
