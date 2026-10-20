<template>
  <div class="node-panel min-w-[280px] max-w-[320px] group cursor-move">
    <Handle type="target" :position="Position.Top" class="node-handle" />

    <!-- Header: the actions are a small icon row -->
    <div class="node-head cursor-move">
      <span class="node-dot bg-accent-light"></span>
      <span class="lbl !text-zinc-800 dark:!text-zinc-200">Result · {{ displayType.toLowerCase() }}</span>
      <div class="flex-1"></div>
      <div class="node-actions nodrag flex items-center gap-2">
        <SlimTooltip v-if="mediaContentUrl" key="full-screen" text="Full Screen View" placement="bottom">
          <button @click="isFullScreen = true" aria-label="Full Screen View" class="node-icon-btn">
            <span class="iconify tabler--arrows-maximize w-3.5 h-3.5"></span>
          </button>
        </SlimTooltip>
        <SlimTooltip key="details" text="Toggle Details" placement="bottom">
          <button @click="toggleDetails" aria-label="Toggle Details" class="node-icon-btn" :class="{ '!text-primary': showDetails }">
            <span class="iconify tabler--info-circle w-3.5 h-3.5"></span>
          </button>
        </SlimTooltip>
        <SlimTooltip key="save" text="Save Image" placement="bottom">
          <button @click="() => handleSave()" aria-label="Save Image" class="node-icon-btn">
            <span class="iconify tabler--download w-3.5 h-3.5"></span>
          </button>
        </SlimTooltip>
        <SlimTooltip key="refine" text="Refine using all references" placement="bottom">
          <button @click="addReferencesToInput" aria-label="Refine using all references" class="node-icon-btn hover:!text-primary">
            <span class="iconify tabler--wand w-3.5 h-3.5"></span>
          </button>
        </SlimTooltip>
        <SlimTooltip key="attachment" :text="isAvailableForAttachment ? 'Remove from attachments' : 'Add to available attachments'" placement="bottom">
          <button @click="toggleAttachment" aria-label="Toggle attachment" class="node-icon-btn" :class="{ '!text-primary': isAvailableForAttachment }">
            <span class="iconify w-3.5 h-3.5" :class="isAvailableForAttachment ? 'tabler--photo-check' : 'tabler--photo-plus'"></span>
          </button>
        </SlimTooltip>
        <SlimTooltip key="delete" text="Delete node and branches" placement="bottom">
          <button @click="data.onDelete" aria-label="Delete node and branches" class="node-icon-btn hover:!text-red-500">
            <span class="iconify tabler--trash w-3.5 h-3.5"></span>
          </button>
        </SlimTooltip>
      </div>
    </div>

    <!-- Image -->
    <div class="relative aspect-video bg-black overflow-hidden">
      <img :src="mediaContentUrl" class="w-full h-full object-contain cursor-move" @click="isFullScreen = true" draggable="false" />
    </div>

    <!-- Version / kind / which file is showing -->
    <div class="px-3 py-1.5 hair-b flex items-center gap-3 cursor-move font-mono text-[10px]">
      <span v-if="data.version" class="text-zinc-700 dark:text-zinc-200">{{ data.version }}</span>
      <span class="uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{{ displayType }}</span>
      <span class="uppercase tracking-wide text-accent">{{ activeFileType }}</span>
    </div>

    <!-- Reference frames (visible by default when present) -->
    <div v-if="referenceFrames.length > 0" class="px-3 py-2 hair-b nodrag">
      <div class="flex items-center gap-2 mb-2">
        <span class="lbl !text-[9px]">{{ displayReferenceLabel }}</span>
        <div class="flex-1"></div>
        <button @click="addReferencesToInput" class="text-[10px] font-semibold text-primary hover:text-primary-dark transition-colors"
          title="Use as refinement attachments">Use as attachments</button>
        <span class="text-[10px] text-zinc-500">{{ referenceFrames.length }} detected</span>
      </div>
      <div class="flex gap-1.5 overflow-x-auto pb-1 custom-scrollbar scroll-smooth">
        <button v-for="(frame, idx) in referenceFrames" :key="idx" type="button"
          class="shrink-0 w-16 aspect-video rounded-[2px] overflow-hidden transition"
          :class="previewUrl === mediaUrl(frame.url) ? 'ring-2 ring-primary' : 'ring-1 ring-[color:var(--ff-hairline-strong)] opacity-70 hover:opacity-100'"
          @click="previewUrl = mediaUrl(frame.url)">
          <img :src="mediaUrl(frame.url)" class="w-full h-full object-cover" />
        </button>
        <!-- Reset to actual toggle -->
        <button v-if="previewUrl !== mediaUrl(actualFile?.url)" type="button"
          class="shrink-0 w-16 aspect-video rounded-[2px] flex items-center justify-center text-accent ring-1 ring-accent/50 hover:bg-accent/10 transition"
          title="Back to Generated Thumbnail" @click="previewUrl = mediaUrl(actualFile?.url)">
          <span class="iconify tabler--arrow-back-up w-4 h-4"></span>
        </button>
      </div>
    </div>

    <!-- Details -->
    <div v-if="showDetails" class="px-3 py-3 hair-b space-y-3 nodrag cursor-text">
      <!-- Model content / explanation -->
      <div v-if="data.content">
        <div class="lbl !text-primary">Model feedback</div>
        <div class="mt-1.5 prose prose-xs dark:prose-invert prose-p:my-0 prose-pre:my-2 prose-ul:my-1 text-zinc-700 dark:text-zinc-300 leading-relaxed select-text"
          v-html="renderMarkdown(data.content)"></div>
      </div>

      <div v-if="metadata || isMetadataLoading">
        <div v-if="isMetadataLoading" class="flex items-center gap-2 text-[10px] text-zinc-500 uppercase tracking-wide">
          <span class="iconify tabler--loader-2 w-3 h-3 animate-spin text-primary"></span>Loading media info...
        </div>
        <div v-else-if="metadata" class="flex gap-4 text-[11px] text-zinc-500 dark:text-zinc-400 font-mono select-text">
          <span>{{ metadata?.width }}×{{ metadata?.height }}</span>
          <span class="uppercase">{{ (metadata?.format?.split(',')[0] || 'Image').replace('image2', 'PNG') }}</span>
          <span>{{ formatFileSize(metadata?.size) }}</span>
        </div>
      </div>

      <!-- High-res upscaling -->
      <div v-if="!isMetadataLoading" class="space-y-1.5 cursor-default">
        <div class="flex items-center">
          <span class="lbl !text-primary">High-res upscaling</span>
          <div class="flex-1"></div>
          <span class="text-[10px] text-zinc-500">Nano Banana</span>
        </div>
        <div class="flex gap-4 text-xs font-semibold">
          <!-- Upscale x2 or Download 2K -->
          <button v-if="!isAtLeast2K" @click="handleUpscale('x2')" :disabled="!!isUpscaling"
            class="btn-text btn-text-primary !px-0 !h-6">
            <span v-if="isUpscaling === 'x2'" class="iconify tabler--loader-2 w-3 h-3 animate-spin"></span>
            {{ isUpscaling === 'x2' ? 'Upscaling...' : 'Upscale ×2' }}
          </button>
          <button v-else @click="() => handleSave(mediaUrl(actualFile.upscale2k))" class="btn-text !px-0 !h-6 !text-accent">Download 2K</button>

          <!-- Upscale x4 or Download 4K -->
          <button v-if="!isAtLeast4K" @click="handleUpscale('x4')" :disabled="!!isUpscaling"
            class="btn-text btn-text-primary !px-0 !h-6">
            <span v-if="isUpscaling === 'x4'" class="iconify tabler--loader-2 w-3 h-3 animate-spin"></span>
            {{ isUpscaling === 'x4' ? 'Upscaling...' : 'Upscale ×4' }}
          </button>
          <button v-else @click="() => handleSave(mediaUrl(actualFile.upscale4k))" class="btn-text !px-0 !h-6 !text-accent">Download 4K</button>
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
      class="nodrag interactive-in-pan"
      @send="submit"
    />

    <!-- Full screen -->
    <Teleport to="body">
      <div v-if="isFullScreen" class="fixed inset-0 z-[9999] bg-black/90 flex flex-col items-center justify-center p-8">
        <button @click="isFullScreen = false" aria-label="Close preview"
          class="absolute top-6 right-6 w-8 h-8 flex items-center justify-center rounded-md text-white/80 hover:text-white hover:bg-white/10 transition z-50">
          <span class="iconify tabler--x w-5 h-5"></span>
        </button>
        <img :src="mediaContentUrl" class="max-w-full max-h-full rounded-[3px] object-contain" />
        <div class="mt-4 text-sm font-semibold text-white/80">Result: Thumbnail (V{{ props.data.version || 1 }})</div>
      </div>
    </Teleport>

    <Handle type="source" :position="Position.Bottom" class="node-handle node-handle-out" />
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
