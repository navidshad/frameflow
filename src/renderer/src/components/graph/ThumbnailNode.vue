<template>
  <div class="glass-card glass-card-hover p-0 rounded-3xl min-w-[280px] max-w-[320px] overflow-hidden flex flex-col group transition-all duration-300 cursor-move">
    <Handle type="target" :position="Position.Top" class="w-3 h-3 bg-zinc-500 border-2 border-white dark:border-zinc-800" />
    
    <!-- Main Image Container -->
    <div class="relative aspect-video bg-black overflow-hidden group/player">
      <!-- Controls Overlay (Hover) -->
      <div class="absolute top-2 right-2 flex flex-col gap-2 z-20 opacity-0 group-hover/player:opacity-100 transition-opacity">
        <SlimTooltip v-if="mediaContentUrl" key="full-screen" text="Full Screen View" placement="left">
          <button @click="isFullScreen = true" class="p-1.5 bg-black/50 backdrop-blur-md rounded-lg hover:bg-black/80 text-white transition-all shadow-lg">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"></path></svg>
          </button>
        </SlimTooltip>
        <SlimTooltip key="details" text="Toggle Details" placement="left">
          <button @click="toggleDetails" class="p-1.5 bg-black/50 backdrop-blur-md rounded-lg hover:bg-black/80 transition-all shadow-lg" :class="{'text-blue-400': showDetails, 'text-white': !showDetails}">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
          </button>
        </SlimTooltip>
        <SlimTooltip key="save" text="Save Image" placement="left">
          <button @click="() => handleSave()" class="p-1.5 bg-black/50 backdrop-blur-md rounded-lg hover:bg-black/80 text-white transition-all shadow-lg">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M8 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3m-1 7l-4 4-4-4m4 4V10" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </SlimTooltip>
        <SlimTooltip key="refine" text="Refine using all references" placement="left">
          <button @click="addReferencesToInput" class="p-1.5 bg-black/50 backdrop-blur-md rounded-lg hover:bg-primary/80 text-white transition-all shadow-lg group-hover:scale-110 active:scale-95">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11l-5 5" /><path d="M17 6l-5 5" /><path d="M5 20l14 -14" /><path d="M19 19v-11" /><path d="M11 19h8" /></svg>
          </button>
        </SlimTooltip>
        <SlimTooltip key="attachment" :text="isAvailableForAttachment ? 'Remove from attachments' : 'Add to available attachments'" placement="left">
          <button @click="toggleAttachment" class="p-1.5 bg-black/50 backdrop-blur-md rounded-lg hover:bg-black/80 transition-all shadow-lg" :class="{'text-primary-light': isAvailableForAttachment, 'text-white': !isAvailableForAttachment}">
            <svg v-if="isAvailableForAttachment" xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01" /><path d="M11.5 21h-5.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v5" /><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3 3" /><path d="M14 14l1 -1c.928 -.893 2.072 -.893 3 0l0 0" /><path d="M15 19l2 2l4 -4" /></svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01" /><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5" /><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3 3" /><path d="M14 14l1 -1c.67 -.644 1.45 -.824 2.182 -.54" /><path d="M16 19h6" /><path d="M19 16v6" /></svg>
          </button>
        </SlimTooltip>
        <SlimTooltip key="delete" text="Delete node and branches" placement="left">
          <button @click="data.onDelete" class="p-1.5 bg-black/50 backdrop-blur-md rounded-lg hover:bg-red-500/80 text-white transition-all shadow-lg">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </SlimTooltip>
      </div>

      <!-- Image Content -->
      <img 
        :src="mediaContentUrl" 
        class="w-full h-full object-contain cursor-move transition-transform duration-500 hover:scale-105" 
        @click="isFullScreen = true"
        draggable="false"
      />
    </div>

    <!-- Node Info Tags (Unified Variation) -->
    <div class="px-4 py-2.5 bg-zinc-50/50 dark:bg-white/[0.02] border-b border-black/5 dark:border-white/5 flex items-center gap-3 cursor-move">
      <!-- Version -->
      <div v-if="data.version" class="text-[10px] font-bold text-primary dark:text-primary-light font-mono leading-none">
         {{ data.version }}
      </div>

      <div v-if="data.version" class="w-px h-3 bg-black/10 dark:bg-white/10"></div>

      <!-- Media Type -->
      <div class="text-[9px] font-black uppercase tracking-[0.15em] text-zinc-500 dark:text-zinc-400 leading-none">
        {{ displayType }}
      </div>
      
      <div class="w-px h-3 bg-black/10 dark:bg-white/10"></div>

      <!-- Preview Type -->
      <div class="text-[9px] font-black uppercase tracking-widest text-accent dark:text-accent-light leading-none">
        {{ activeFileType }}
      </div>
    </div>

    <!-- Reference Frames Gallery (Visible by default if present) -->
    <div v-if="referenceFrames.length > 0" class="px-3 py-2 bg-black/10 dark:bg-black/40 border-b border-black/5 dark:border-white/5 nodrag">
        <div class="flex items-center justify-between mb-2">
            <div class="flex items-center gap-2">
                <span class="text-[8px] font-black uppercase tracking-widest text-zinc-500">{{ displayReferenceLabel }}</span>
                <button @click="addReferencesToInput" class="p-1 rounded bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-primary transition-all shadow-sm" title="Use as refinement attachments">
                    <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M12 4v16m8-8H4"></path></svg>
                </button>
            </div>
            <span class="text-[8px] font-bold text-zinc-400">{{ referenceFrames.length }} detected</span>
        </div>
        <div class="flex gap-2 overflow-x-auto pb-1 custom-scrollbar scroll-smooth">
            <div 
                v-for="(frame, idx) in referenceFrames" 
                :key="idx"
                class="flex-shrink-0 w-16 aspect-video rounded-md overflow-hidden border transition-all cursor-pointer hover:border-primary/60 active:scale-95 group/ref"
                :class="[
                  previewUrl === mediaUrl(frame.url) ? 'border-primary ring-1 ring-primary/20 scale-95 shadow-lg' : 'border-black/10 dark:border-white/10 grayscale-[0.5] hover:grayscale-0'
                ]"
                @click="previewUrl = mediaUrl(frame.url)"
            >
                <img :src="mediaUrl(frame.url)" class="w-full h-full object-cover" />
            </div>
            <!-- Reset to actual toggle -->
             <div 
                v-if="previewUrl !== mediaUrl(actualFile?.url)"
                class="flex-shrink-0 w-16 aspect-video rounded-md overflow-hidden border border-accent/40 bg-accent/10 flex items-center justify-center cursor-pointer hover:bg-accent/20 transition-all text-accent-light group/reset"
                @click="previewUrl = mediaUrl(actualFile?.url)"
                title="Back to Generated Thumbnail"
            >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M3 10h10a8 8 0 018 8v2M3 10l4 4m-4-4l4-4"></path></svg>
            </div>
        </div>
    </div>

    <!-- Details Metadata Section -->
    <div v-if="showDetails" class="px-4 py-3 bg-white/5 border-b border-white/5 space-y-4 animate-in slide-in-from-top duration-300 nodrag cursor-text">
      <!-- Model Content / Explanation -->
      <div v-if="data.content" class="pb-4 border-b border-white/5">
          <div class="text-[8px] font-black uppercase tracking-widest text-primary-light mb-2">Model Feedback</div>
          <div 
              class="prose prose-xs dark:prose-invert prose-p:my-0 prose-pre:my-2 prose-ul:my-1 text-zinc-800 dark:text-zinc-300/90 leading-relaxed font-medium select-text"
              v-html="renderMarkdown(data.content)"
          ></div>
      </div>
      
      <div v-if="metadata || isMetadataLoading" class="grid grid-cols-2 gap-3 pb-4">
        <div v-if="isMetadataLoading" class="col-span-2 py-4 flex items-center justify-center space-x-2">
           <div class="w-3 h-3 border-2 border-primary border-t-transparent animate-spin rounded-full"></div>
           <span class="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Loading Media Info...</span>
        </div>
        <template v-else-if="metadata">
          <div class="flex flex-col gap-0.5 select-text">
            <span class="text-[9px] font-bold text-zinc-500 dark:text-zinc-500 uppercase tracking-widest">Resolution</span>
            <span class="text-[11px] text-zinc-700 dark:text-zinc-200 font-mono">{{ metadata?.width }}x{{ metadata?.height }}</span>
          </div>
          <div class="flex flex-col gap-0.5 select-text">
            <span class="text-[9px] font-bold text-zinc-500 dark:text-zinc-500 uppercase tracking-widest">File Size</span>
            <span class="text-[11px] text-zinc-700 dark:text-zinc-200 font-mono">{{ formatFileSize(metadata?.size) }}</span>
          </div>
          <div class="flex flex-col gap-0.5 select-text">
            <span class="text-[9px] font-bold text-zinc-500 dark:text-zinc-500 uppercase tracking-widest">Format</span>
            <span class="text-[11px] text-zinc-700 dark:text-zinc-200 font-mono uppercase">{{ (metadata?.format?.split(',')[0] || 'Image').replace('image2', 'PNG') }}</span>
          </div>
        </template>
      </div>

      <!-- High-Res Upscaling Section -->
      <div v-if="!isMetadataLoading" class="pt-4 border-t border-white/5 space-y-3 nodrag cursor-default">
          <div class="flex items-center justify-between">
              <span class="text-[9px] font-black uppercase tracking-widest text-primary-light">High-Res Upscaling</span>
              <span class="text-[8px] font-bold text-zinc-500 italic">Nano Banana</span>
          </div>
          <div class="flex gap-2">
            <!-- Upscale x2 or Download 2K -->
            <button 
                v-if="!isAtLeast2K"
                @click="handleUpscale('x2')" 
                :disabled="!!isUpscaling"
                class="flex-1 px-3 py-2 rounded-xl bg-primary/10 hover:bg-primary/20 border border-primary/20 text-[10px] font-bold text-primary-light transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
                <div v-if="isUpscaling === 'x2'" class="w-3 h-3 border-2 border-primary border-t-transparent animate-spin rounded-full"></div>
                {{ isUpscaling === 'x2' ? 'Upscaling...' : 'Upscale x2' }}
            </button>
            <button 
                v-else
                @click="() => handleSave(mediaUrl(actualFile.upscale2k))"
                class="flex-1 px-3 py-2 rounded-xl bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 text-[10px] font-bold text-green-500 transition-all flex items-center justify-center gap-2"
            >
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Download 2K
            </button>

            <!-- Upscale x4 or Download 4K -->
            <button 
                v-if="!isAtLeast4K"
                @click="handleUpscale('x4')" 
                :disabled="!!isUpscaling"
                class="flex-1 px-3 py-2 rounded-xl bg-accent/10 hover:bg-accent/20 border border-accent/20 text-[10px] font-bold text-accent-light transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
                <div v-if="isUpscaling === 'x4'" class="w-3 h-3 border-2 border-accent border-t-transparent animate-spin rounded-full"></div>
                {{ isUpscaling === 'x4' ? 'Upscaling...' : 'Upscale x4' }}
            </button>
            <button 
                v-else
                @click="() => handleSave(mediaUrl(actualFile.upscale4k))"
                class="flex-1 px-3 py-2 rounded-xl bg-green-500/10 hover:bg-green-500/20 border border-green-500/20 text-[10px] font-bold text-green-500 transition-all flex items-center justify-center gap-2"
            >
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Download 4K
            </button>
          </div>
      </div>
    </div>
    
    <BaseMessageInput 
      v-if="showInput"
      ref="messageInput"
      v-model="input"
      v-model:attachedImages="attachedImages"
      v-model:autoUseImages="localAutoUseImages"
      placeholder="Adjust or follow up..."
      compact
      class="p-2 border-t border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] nodrag interactive-in-pan animate-in slide-in-from-bottom duration-300"
      @send="submit"
    />

    <!-- Full Screen Modal -->
    <Teleport to="body">
      <div v-if="isFullScreen" class="fixed inset-0 z-[9999] bg-black/95 flex flex-col items-center justify-center p-8 backdrop-blur-3xl animate-in fade-in duration-300">
        <button @click="isFullScreen = false" class="absolute top-8 right-8 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-90 z-50">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
        </button>
        <img :src="mediaContentUrl" class="max-w-full max-h-full rounded-2xl shadow-2xl ring-1 ring-white/20 object-contain" />
        <div class="mt-6 text-xl font-bold text-white opacity-80 italic tracking-tight">Result: Thumbnail (V{{ props.data.version || 1 }})</div>
      </div>
    </Teleport>

    <Handle type="source" :position="Position.Bottom" class="w-3 h-3 bg-blue-500 border-2 border-white dark:border-zinc-800" />
  </div>
</template>

<script setup lang="ts">
import { fromMediaUrl, toMediaUrl } from '@shared/media-url'
import { ref, computed, watch, nextTick } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import SlimTooltip from '../SlimTooltip.vue'
import BaseMessageInput from '../chat/BaseMessageInput.vue'
import { renderMarkdown } from '../../utils/markdown'
import { useVideoStore } from '../../stores/videoStore'

const props = defineProps<{ data: any }>()
const emit = defineEmits(['toggle-details'])
const isFullScreen = ref(false)
const showDetails = ref(props.data.showDetails || false)

watch(() => props.data.showDetails, (newVal) => {
  if (newVal !== undefined && newVal !== showDetails.value) {
    showDetails.value = newVal
  }
})

const toggleDetails = () => {
  showDetails.value = !showDetails.value
  emit('toggle-details', showDetails.value)
}

const input = ref('')
const attachedImages = ref<string[]>([])
const localAutoUseImages = ref(false)
const metadata = ref<any>(null)
const isMetadataLoading = ref(false)
const previewUrl = ref<string | null>(null)
const videoStore = useVideoStore()
const isUpscaling = ref<string | null>(null)
const showInput = ref(false)
const messageInput = ref<any>(null)

const files = computed(() => props.data.files || [])
const actualFile = computed(() => files.value.find((f: any) => f.type === 'actual'))
const referenceFrames = computed(() => files.value.filter((f: any) => f.type === 'preview'))

const mediaUrl = (url?: string) => toMediaUrl(url || '')

const mediaContentUrl = computed(() => {
  if (previewUrl.value) return previewUrl.value
  const file = actualFile.value
  if (file?.upscale4k) return mediaUrl(file.upscale4k)
  if (file?.upscale2k) return mediaUrl(file.upscale2k)
  const fallback = file || referenceFrames.value[0]
  return mediaUrl(fallback?.url)
})

const activeFileType = computed(() => {
    if (previewUrl.value) {
        if (previewUrl.value === mediaUrl(actualFile.value?.url)) return 'Actual'
        return 'Preview Reference'
    }
    return actualFile.value ? 'Actual' : 'Preview'
})

const displayType = computed(() => {
    const type = props.data.type || 'thumbnail'
    if (type === 'image' || type === 'result-image') return 'Image Result'
    return 'Thumbnail'
})

const displayReferenceLabel = computed(() => {
    const type = props.data.type || 'thumbnail'
    if (type === 'image' || type === 'result-image') return 'Reference Images'
    return 'Reference Frames'
})

const versionedTitle = computed(() => {
  const type = props.data.type || 'thumbnail'
  if (type === 'image' || type === 'result-image') return 'AI Generated Image'
  return 'AI Generated Thumbnail'
})

const isAtLeast2K = computed(() => {
  if (actualFile.value?.upscale2k) return true
  return (metadata.value?.width || 0) >= 2000
})

const isAtLeast4K = computed(() => {
  if (actualFile.value?.upscale4k) return true
  return (metadata.value?.width || 0) >= 3800
})

const isAvailableForAttachment = computed(() => {
  const path = actualFile.value?.url
  if (!path) return false
  const currentRefs = videoStore.currentThread?.preprocessing?.['reference-frames'] || []
  return currentRefs.includes(fromMediaUrl(path))
})

const toggleAttachment = async () => {
  const path = actualFile.value?.url
  if (!path) return
  await videoStore.toggleReferenceFrame(fromMediaUrl(path))
}

const addReferencesToInput = async () => {
  showInput.value = true
  
  const urlsToAdd = []
  if (actualFile.value?.url) urlsToAdd.push(mediaUrl(actualFile.value.url))
  referenceFrames.value.forEach((f: any) => {
    if (f.url) urlsToAdd.push(mediaUrl(f.url))
  })

  // Merge without duplicates
  const currentSet = new Set(attachedImages.value)
  urlsToAdd.forEach(url => currentSet.add(url))
  attachedImages.value = Array.from(currentSet)

  // Focus input
  await nextTick()
  messageInput.value?.focus()
}

const fetchMetadata = async () => {
  if (!mediaContentUrl.value || metadata.value || isMetadataLoading.value) return
  isMetadataLoading.value = true
  try {
    const rawPath = fromMediaUrl(mediaContentUrl.value)
    metadata.value = await (window as any).api.getVideoMetadata(rawPath)
  } catch (e) {
    console.error('Failed to fetch image metadata:', e)
  } finally {
    isMetadataLoading.value = false
  }
}

watch(() => props.data.id, (msgId) => {
  if (msgId) {
    const msg = videoStore.messages.find(m => m.id === msgId)
    if (msg && msg.autoUseImages !== undefined) {
      localAutoUseImages.value = msg.autoUseImages
    }
  }
}, { immediate: true })

watch(showDetails, (newVal) => {
  if (newVal) fetchMetadata()
}, { immediate: true })

const handleSave = async (specificUrl?: string) => {
  const url = specificUrl || mediaContentUrl.value
  if (url && (window as any).api) {
    await (window as any).api.saveVideo(fromMediaUrl(url))
  }
}

const handleUpscale = async (factor: string) => {
  const currentPath = fromMediaUrl(mediaContentUrl.value)
  if (!currentPath) return

  isUpscaling.value = factor
  try {
    const threadId = videoStore.currentThreadId
    if (!threadId) throw new Error('No active thread found')

    const resultPath = await (window as any).api.upscaleImage({
      threadId,
      messageId: props.data.id,
      imagePath: currentPath,
      upscaleFactor: factor
    })
    
    if (resultPath) {
      previewUrl.value = toMediaUrl(resultPath)
      // Clear metadata and re-fetch to show new resolution
      metadata.value = null
      await fetchMetadata()
    }
  } catch (e) {
    console.error('Upscaling failed:', e)
  } finally {
    isUpscaling.value = null
  }
}

const submit = (text: string, images: string[], count: number, isThinkingMode: boolean, autoUseImages: boolean) => {
  if ((text.trim() || images.length > 0) && props.data.onSubmit) {
    props.data.onSubmit(text, images, count, isThinkingMode, autoUseImages)
    input.value = ''
    attachedImages.value = []
  }
}

const formatFileSize = (bytes?: number) => {
  if (!bytes) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  height: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.2);
  border-radius: 10px;
}
</style>
