<template>
  <div class="w-full max-w-3xl mx-auto space-y-3">
    <!-- Purpose. First, because it re-labels and re-validates everything below. -->
    <div class="flex bg-zinc-100/50 dark:bg-zinc-900/50 rounded-xl p-1.5 w-full max-w-xs border border-zinc-200 dark:border-zinc-800 backdrop-blur-sm shadow-sm">
      <button v-for="option in PURPOSES" :key="option.value" @click="purpose = option.value"
        class="flex-1 py-2 text-sm font-bold rounded-lg transition-all flex items-center justify-center gap-2"
        :class="purpose === option.value
          ? 'bg-white dark:bg-zinc-800 shadow-sm text-zinc-900 dark:text-white scale-[1.02]'
          : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 scale-100'">
        <span class="iconify w-4 h-4" :class="option.icon"></span>
        {{ option.label }}
      </button>
    </div>

    <p class="text-xs text-zinc-500 dark:text-zinc-400 px-1">{{ hint }}</p>

    <!-- Attachments -->
    <div v-if="videoPath || imagePaths.length" class="flex flex-wrap items-center gap-2 px-1">
      <!-- Video chip -->
      <div v-if="videoPath"
        class="flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-sm max-w-xs">
        <span class="iconify tabler--movie w-4 h-4 text-primary shrink-0"></span>
        <span class="text-xs font-bold text-zinc-700 dark:text-zinc-200 truncate">{{ videoName }}</span>
        <span v-if="purpose === 'image'"
          class="text-[9px] font-black uppercase tracking-widest text-zinc-400 border border-zinc-300 dark:border-zinc-600 rounded px-1 py-0.5 shrink-0">Ref</span>
        <button @click="clearVideo" class="text-zinc-400 hover:text-red-500 transition shrink-0">
          <span class="iconify tabler--x w-3.5 h-3.5"></span>
        </button>
      </div>

      <!-- Image thumbnails (image purpose only — the editor's prompt is text-only) -->
      <div v-for="(img, idx) in visibleImages" v-show="purpose === 'image'" :key="img"
        class="relative w-16 h-16 rounded-xl group shadow-md border border-zinc-200 dark:border-zinc-800 transition-all hover:scale-105">
        <img :src="`media://${img}`" class="w-full h-full object-cover rounded-xl" />
        <div class="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-all z-30">
          <button @click.stop="removeImage(idx)"
            class="flex items-center justify-center w-4 h-4 bg-red-500 text-white rounded-full shadow-lg hover:bg-red-600 active:scale-90 transition-all">
            <span class="iconify tabler--x w-2.5 h-2.5"></span>
          </button>
        </div>
      </div>
      <div v-if="hiddenImageCount > 0 && purpose === 'image'"
        class="w-16 h-16 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-500">
        +{{ hiddenImageCount }}
      </div>
    </div>

    <!-- Prompt. BaseMessageInput carries the textarea, Cmd+Enter, samples,
         thinking toggle and send button; only the attach slot is ours. -->
    <BaseMessageInput
      v-model="prompt"
      v-model:autoUseImages="autoUseImages"
      :placeholder="placeholder"
      :send-disabled="!!blockedReason || !!busy"
      :send-disabled-reason="busy ? 'Setting up your project…' : (blockedReason || undefined)"
      :show-samples="purpose === 'image'"
      :show-thinking="purpose === 'image'"
      :show-auto-images="purpose === 'image'"
      :allow-empty-send="purpose === 'video' && !!videoPath"
      @send="submit">
      <template #attach>
        <SlimTooltip :text="primaryAttachLabel" placement="top">
          <button @click="pickPrimary" :disabled="busy"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-100 dark:bg-white/5 border border-black/5 dark:border-white/10 text-[11px] font-bold text-zinc-600 dark:text-zinc-300 hover:text-primary transition active:scale-95 disabled:opacity-50">
            <span class="iconify tabler--paperclip w-3.5 h-3.5"></span>
            {{ primaryAttachLabel }}
          </button>
        </SlimTooltip>
        <SlimTooltip v-if="purpose === 'image'" :text="secondaryAttachLabel" placement="top">
          <button @click="pickSecondary" :disabled="busy"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-100 dark:bg-white/5 border border-black/5 dark:border-white/10 text-[11px] font-bold text-zinc-500 dark:text-zinc-400 hover:text-primary transition active:scale-95 disabled:opacity-50">
            <span class="iconify tabler--photo-plus w-3.5 h-3.5"></span>
            {{ secondaryAttachLabel }}
          </button>
        </SlimTooltip>
        <SlimTooltip text="Add a video from a link" placement="top">
          <button @click="$emit('pick-link')" :disabled="busy"
            class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-100 dark:bg-white/5 border border-black/5 dark:border-white/10 text-[11px] font-bold text-zinc-500 dark:text-zinc-400 hover:text-primary transition active:scale-95 disabled:opacity-50">
            <span class="iconify tabler--link w-3.5 h-3.5"></span>
            From link
          </button>
        </SlimTooltip>
      </template>
    </BaseMessageInput>

    <p v-if="blockedReason" class="text-[11px] text-amber-600 dark:text-amber-400 px-1">
      {{ blockedReason }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { ThreadType } from '@shared/types'
import BaseMessageInput from '../chat/BaseMessageInput.vue'
import SlimTooltip from '../SlimTooltip.vue'

const props = defineProps<{
  /** Video-purpose sends are blocked without ffmpeg, as the upload screen did. */
  ffmpegAvailable?: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', payload: {
    purpose: ThreadType
    videoPath?: string
    videoName?: string
    imagePaths: string[]
    prompt: string
    count: number
    isThinkingMode: boolean
    autoUseImages: boolean
  }): void
  (e: 'pick-link'): void
}>()

const PURPOSES = [
  { value: 'video' as const, label: 'Video', icon: 'tabler--movie' },
  { value: 'image' as const, label: 'Images', icon: 'tabler--photo' }
]

const MAX_VISIBLE_THUMBS = 8

const purpose = ref<ThreadType>('video')
const prompt = ref('')
const videoPath = ref<string | undefined>(undefined)
const videoName = ref<string | undefined>(undefined)
const imagePaths = ref<string[]>([])

/**
 * Image purpose defaults this ON deliberately. determineImageIntent tells the
 * model "IMAGE ACCESS IS DISABLED" unless autoUseImages or attachedImages is
 * set, and the model then replies asking the user to enable Smart
 * Auto-References — so without this every image project's FIRST turn refuses.
 */
const autoUseImages = ref(true)
watch(purpose, (p) => { autoUseImages.value = p === 'image' })

const visibleImages = computed(() => imagePaths.value.slice(0, MAX_VISIBLE_THUMBS))
const hiddenImageCount = computed(() => Math.max(0, imagePaths.value.length - MAX_VISIBLE_THUMBS))

const hint = computed(() => purpose.value === 'video'
  ? 'Opens a timeline editor with your video imported. Your prompt waits there until the footage is ready.'
  : 'Creating images. A video you attach is used as reference.')

const placeholder = computed(() => purpose.value === 'video'
  // Teach both directions — length now comes from the request, not a mode.
  ? 'What should this edit do? e.g. "cut the filler but keep the whole lecture" or "make a 2-minute highlight"'
  : 'What should these images become? e.g. "make a title card from these"')

const primaryAttachLabel = computed(() =>
  purpose.value === 'video' ? 'Add video' : 'Add images')
const secondaryAttachLabel = computed(() => 'Add reference video')

/** Empty when the composer can send. */
const blockedReason = computed<string | null>(() => {
  if (props.busy) return null
  if (purpose.value === 'video') {
    if (!videoPath.value) return 'Attach a video to get started.'
    if (props.ffmpegAvailable === false) return 'FFmpeg is required to process video.'
    return null
  }
  // Images OR a reference video: "make a thumbnail from my video" legitimately
  // has zero images, and reference-frame sampling gives extractImageData its
  // input. With neither, the first turn dies in determineImageIntent with
  // "Image data not found".
  if (!imagePaths.value.length && !videoPath.value) {
    return 'Attach images, or a video to work from.'
  }
  return null
})

const api = () => (window as any).api

const pickVideo = async () => {
  const result = await api().selectVideo()
  if (result?.path) {
    videoPath.value = result.path
    videoName.value = result.name || result.path.split('/').pop()
  }
}

const pickImages = async () => {
  const result = await api().showOpenDialog({
    title: 'Select images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  })
  if (result && !result.canceled && result.filePaths.length) {
    const merged = new Set([...imagePaths.value, ...result.filePaths])
    imagePaths.value = [...merged]
  }
}

// Two labelled buttons rather than one combined filter: the native dialog
// cannot report ROLE, so a mixed pick would leave us guessing whether a video
// is the subject or a reference — the exact inference this design removes.
const pickPrimary = () => purpose.value === 'video' ? pickVideo() : pickImages()
const pickSecondary = () => pickVideo()

const clearVideo = () => { videoPath.value = undefined; videoName.value = undefined }
const removeImage = (idx: number) => imagePaths.value.splice(idx, 1)

/** Called by the parent when the link modal returns a downloaded file. */
const setVideo = (path: string, name?: string) => {
  videoPath.value = path
  videoName.value = name || path.split('/').pop()
}

const submit = (
  text: string, _images: string[], count: number, isThinkingMode: boolean, auto: boolean
) => {
  if (blockedReason.value || props.busy) return
  emit('submit', {
    purpose: purpose.value,
    videoPath: videoPath.value,
    videoName: videoName.value,
    imagePaths: imagePaths.value,
    prompt: text,
    count,
    isThinkingMode,
    autoUseImages: auto
  })
}

defineExpose({ setVideo })
</script>
