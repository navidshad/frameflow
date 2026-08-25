<template>
  <div class="glass-card glass-card-hover p-0 rounded-3xl min-w-[280px] max-w-[320px] overflow-hidden flex flex-col group cursor-move">
    <Handle type="target" :position="Position.Top" class="w-3 h-3 bg-zinc-500 border-2 border-white dark:border-zinc-800" />
    
    <!-- Media Container with Overlays -->
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
        <SlimTooltip key="save" text="Save Video" placement="left">
          <button @click="handleSave" class="p-1.5 bg-black/50 backdrop-blur-md rounded-lg hover:bg-black/80 text-white transition-all shadow-lg">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M8 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3m-1 7l-4 4-4-4m4 4V10" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </SlimTooltip>
        <SlimTooltip key="open-editor" text="Open this cut in the timeline editor" placement="left">
          <button @click="openInEditor(data.id)" :disabled="editorBusy"
            class="p-1.5 bg-black/50 backdrop-blur-md rounded-lg hover:bg-black/80 text-white transition-all shadow-lg disabled:opacity-40">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
          </button>
        </SlimTooltip>
        <SlimTooltip key="delete" text="Delete node and branches" placement="left">
          <button @click="data.onDelete" class="p-1.5 bg-black/50 backdrop-blur-md rounded-lg hover:bg-red-500/80 text-white transition-all shadow-lg">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </SlimTooltip>
      </div>

      <!-- Video Content -->
      <div class="w-full h-full relative cursor-move">
        <video 
          ref="videoRef"
          :src="mediaContentUrl" 
          class="w-full h-full object-contain transition-opacity"
          @click="togglePlay"
        ></video>
        <div v-if="!isPlaying" @click="togglePlay" class="absolute inset-0 flex items-center justify-center bg-transparent cursor-pointer transition">
          <div class="w-10 h-10 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center border border-white/20 shadow-xl group-hover/player:scale-110 transition duration-300">
             <svg class="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
      </div>
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

    <!-- Details Metadata Section -->
    <div v-if="showDetails" class="px-4 py-3 bg-white/5 border-b border-white/5 space-y-4 animate-in slide-in-from-top duration-300 nodrag cursor-text">
      <div v-if="metadata || isMetadataLoading" class="grid grid-cols-2 gap-3 pb-4 border-b border-white/5">
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
            <span class="text-[9px] font-bold text-zinc-500 dark:text-zinc-500 uppercase tracking-widest">Duration</span>
            <span class="text-[11px] text-zinc-700 dark:text-zinc-200 font-mono">{{ formatDurationSeconds(metadata?.duration) }}</span>
          </div>
          <div class="flex flex-col gap-0.5 select-text">
            <span class="text-[9px] font-bold text-zinc-500 dark:text-zinc-500 uppercase tracking-widest">Frame Rate</span>
            <span class="text-[11px] text-zinc-700 dark:text-zinc-200 font-mono">{{ metadata?.fps }} FPS</span>
          </div>
          <div class="flex flex-col gap-0.5 select-text">
            <span class="text-[9px] font-bold text-zinc-500 dark:text-zinc-500 uppercase tracking-widest">File Size</span>
            <span class="text-[11px] text-zinc-700 dark:text-zinc-200 font-mono">{{ formatFileSize(metadata?.size) }}</span>
          </div>
          <div class="flex flex-col gap-0.5 select-text">
            <span class="text-[9px] font-bold text-zinc-500 dark:text-zinc-500 uppercase tracking-widest">Format</span>
            <span class="text-[11px] text-zinc-700 dark:text-zinc-200 font-mono">{{ metadata?.format?.split(',')[0] }}</span>
          </div>
          <div v-if="metadata?.codec && metadata.codec !== 'unknown'" class="flex flex-col gap-0.5 select-text">
            <span class="text-[9px] font-bold text-zinc-500 dark:text-zinc-500 uppercase tracking-widest">Codec</span>
            <span class="text-[11px] text-zinc-700 dark:text-zinc-200 font-mono capitalize">{{ metadata?.codec }}</span>
          </div>
        </template>
      </div>

      <!-- Timeline segments -->
      <div v-if="props.data.timeline?.length > 0" class="space-y-3 pt-2">
        <div class="text-[9px] font-black text-zinc-400 dark:text-zinc-500 uppercase tracking-widest flex items-center gap-2">
           <div class="h-px flex-1 bg-black/5 dark:bg-white/5"></div>
           Timeline Segments Map
           <div class="h-px flex-1 bg-black/5 dark:bg-white/5"></div>
        </div>
        <div class="max-h-64 overflow-y-auto custom-scrollbar space-y-2.5 pr-1 cursor-default">
          <div v-for="(segment, idx) in props.data.timeline" :key="idx" 
               class="p-3 bg-black/[0.03] dark:bg-black/40 rounded-2xl border border-black/5 dark:border-white/5 hover:border-primary/30 transition-all flex flex-col gap-2 group/segment shadow-sm hover:shadow-md select-text cursor-text">
             <div class="flex justify-between items-center">
               <span class="text-[9px] font-black font-mono text-primary dark:text-blue-400 bg-primary/10 dark:bg-blue-400/10 px-1.5 py-0.5 rounded">
                 [{{ formatTime(segment.start) }} - {{ formatTime(segment.end) }}]
               </span>
               <span class="text-[8px] text-zinc-400 dark:text-zinc-600 font-black uppercase tracking-widest">Segment {{ Number(idx) + 1 }}</span>
             </div>
             <div class="text-[11px] text-zinc-700 dark:text-zinc-300 leading-relaxed font-medium italic">"{{ segment.text }}"</div>
             <div v-if="segment.visual" class="text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed mt-1 bg-white/50 dark:bg-white/5 p-2 rounded-xl border border-black/5 dark:border-white/5">
                <div class="font-black opacity-40 uppercase text-[7px] tracking-widest mb-1 flex items-center gap-1">
                   <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                   Visual Scene context
                </div>
                {{ segment.visual }}
             </div>
          </div>
        </div>
      </div>
    </div>
    
    <BaseMessageInput 
      v-model="input"
      v-model:attachedImages="attachedImages"
      v-model:autoUseImages="localAutoUseImages"
      placeholder="Adjust or follow up..."
      compact
      class="p-2 border-t border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] nodrag interactive-in-pan"
      @send="submit"
    />

    <!-- Full Screen Modal -->
    <Teleport to="body">
      <div v-if="isFullScreen" class="fixed inset-0 z-[9999] bg-black/95 flex flex-col items-center justify-center p-8 backdrop-blur-3xl animate-in fade-in duration-300">
        <button @click="isFullScreen = false" class="absolute top-8 right-8 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-90 z-50">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
        </button>
        <video :src="mediaContentUrl" controls autoplay class="max-w-full max-h-full rounded-2xl shadow-2xl ring-1 ring-white/20"></video>
        <div class="mt-6 text-xl font-bold text-white opacity-80 italic tracking-tight">Result: Video (V{{ props.data.version || 1 }})</div>
      </div>
    </Teleport>

    <Handle type="source" :position="Position.Bottom" class="w-3 h-3 bg-blue-500 border-2 border-white dark:border-zinc-800" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import SlimTooltip from '../SlimTooltip.vue'
import { useVideoStore } from '../../stores/videoStore'
import BaseMessageInput from '../chat/BaseMessageInput.vue'
import { useOpenInEditor } from '../../composables/useOpenInEditor'

const props = defineProps<{ data: any }>()
const emit = defineEmits(['toggle-details'])
const videoStore = useVideoStore()
const { openInEditor, busy: editorBusy } = useOpenInEditor()
const videoRef = ref<HTMLVideoElement | null>(null)
const isPlaying = ref(false)
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

const mediaUrl = (url: string) => {
  if (!url) return ''
  return url.startsWith('media://') ? url : `media://${url}`
}

const mediaContentUrl = computed(() => {
  const file = props.data.files?.find((f: any) => f.type === 'actual' || f.type === 'preview')
  if (!file) return undefined
  return mediaUrl(file.url)
})

const activeFileType = computed(() => {
    const file = props.data.files?.find((f: any) => f.type === 'actual' || f.type === 'preview')
    if (file?.type === 'actual') return 'Actual'
    if (file?.type === 'preview') return 'Preview'
    return 'Result'
})

const displayType = computed(() => {
    const type = props.data.type || 'video'
    if (type === 'video' || type === 'result-video') return 'Video'
    return 'Clip'
})

const togglePlay = () => {
  if (!videoRef.value) return
  if (videoRef.value.paused) {
    videoRef.value.play()
    isPlaying.value = true
  } else {
    videoRef.value.pause()
    isPlaying.value = false
  }
}

const fetchMetadata = async () => {
  if (!mediaContentUrl.value || metadata.value || isMetadataLoading.value) return
  isMetadataLoading.value = true
  try {
    const rawPath = mediaContentUrl.value.replace('media://', '')
    metadata.value = await (window as any).api.getVideoMetadata(rawPath)
  } catch (e) {
    console.error('Failed to fetch video metadata:', e)
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

const handleSave = async () => {
  const file = props.data.files?.[0]
  if (file && (window as any).api) {
    await (window as any).api.saveVideo(file.url)
  }
}

const submit = (text: string, images: string[], count: number, isThinkingMode: boolean, autoUseImages: boolean) => {
  if ((text.trim() || images.length > 0) && props.data.onSubmit) {
    props.data.onSubmit(text, images, count, isThinkingMode, autoUseImages)
    input.value = ''
    attachedImages.value = []
  }
}

const formatDurationSeconds = (seconds?: number) => {
  if (!seconds) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

const formatFileSize = (bytes?: number) => {
  if (!bytes) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

const formatTime = (val?: string | number) => {
  if (val === undefined || val === null) return '00:00'
  if (typeof val === 'string') {
    const clean = val.trim().replace(',', '.')
    const parts = clean.split(':')
    if (parts.length === 3) {
      const ss = parts[2].split('.')[0]
      return `${parts[1]}:${ss}`
    }
    if (parts.length === 2) {
      return parts[0] + ':' + parts[1].split('.')[0]
    }
    return val.split('.')[0]
  }
  const m = Math.floor(val / 60)
  const s = Math.floor(val % 60)
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}
</script>

<style scoped>
.custom-scrollbar::-webkit-scrollbar {
  width: 4px;
}
.custom-scrollbar::-webkit-scrollbar-track {
  background: transparent;
}
.custom-scrollbar::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.2);
  border-radius: 10px;
}
</style>
