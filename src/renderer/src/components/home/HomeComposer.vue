<template>
  <div class="w-full">
    <!-- Purpose. First, because it re-labels and re-validates everything below. -->
    <div class="flex gap-[22px] hair-b" role="tablist" aria-label="What are you making">
      <button v-for="option in PURPOSES" :key="option.value" role="tab" :aria-selected="purpose === option.value"
        class="tab-u !text-[13px] flex items-center gap-2" :class="{ 'tab-u-active': purpose === option.value }"
        @click="purpose = option.value">
        <span class="iconify w-4 h-4" :class="option.icon"></span>
        {{ option.label }}
      </button>
    </div>

    <p class="mt-3 text-xs text-zinc-500 dark:text-zinc-400">{{ hint }}</p>

    <!-- Attachments -->
    <div v-if="videoPath || imagePaths.length" class="mt-4 flex flex-wrap items-center gap-2">
      <!-- Video chip -->
      <div v-if="videoPath" class="flex items-center gap-2 h-7 pl-2.5 pr-1.5 rounded-md max-w-xs"
        :style="{ border: '1px solid var(--ff-hairline-strong)' }">
        <span class="iconify tabler--movie w-3.5 h-3.5 text-primary shrink-0"></span>
        <span class="text-xs font-semibold text-zinc-700 dark:text-zinc-200 truncate">{{ videoName }}</span>
        <span v-if="purpose === 'image'" class="lbl shrink-0 !text-[9px]">Ref</span>
        <button @click="clearVideo" aria-label="Remove video" class="text-zinc-400 hover:text-red-500 transition-colors shrink-0">
          <span class="iconify tabler--x w-3.5 h-3.5"></span>
        </button>
      </div>

      <!-- Image thumbnails (image purpose only — the editor's prompt is text-only) -->
      <div v-for="(img, idx) in visibleImages" v-show="purpose === 'image'" :key="img"
        class="relative w-14 h-14 rounded-[3px] group" :style="{ border: '1px solid var(--ff-hairline-strong)' }">
        <img :src="toMediaUrl(img)" class="w-full h-full object-cover rounded-[2px]" />
        <button @click.stop="removeImage(idx)" aria-label="Remove image"
          class="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 opacity-0 group-hover:opacity-100 transition-opacity hover:!bg-red-500 hover:!text-white">
          <span class="iconify tabler--x w-2.5 h-2.5"></span>
        </button>
      </div>
      <div v-if="hiddenImageCount > 0 && purpose === 'image'"
        class="w-14 h-14 rounded-[3px] flex items-center justify-center text-xs font-semibold text-zinc-500"
        :style="{ border: '1px dashed var(--ff-hairline-strong)' }">
        +{{ hiddenImageCount }}
      </div>
    </div>

    <!-- Prompt. BaseMessageInput carries the textarea, Cmd+Enter, samples,
         thinking toggle and send button; only the attach slot is ours. -->
    <div class="mt-[18px]">
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
            <button @click="pickPrimary" :disabled="busy" class="btn-text !text-zinc-700 dark:!text-zinc-200 !px-2.5">
              <span class="iconify tabler--paperclip w-4 h-4"></span>
              {{ primaryAttachLabel }}
            </button>
          </SlimTooltip>
          <SlimTooltip v-if="purpose === 'image'" :text="secondaryAttachLabel" placement="top">
            <button @click="pickSecondary" :disabled="busy" class="btn-text !text-zinc-700 dark:!text-zinc-200 !px-2.5">
              <span class="iconify tabler--movie w-4 h-4"></span>
              {{ secondaryAttachLabel }}
            </button>
          </SlimTooltip>
          <SlimTooltip text="Add a video from a link" placement="top">
            <button @click="$emit('pick-link')" :disabled="busy" class="btn-text !text-zinc-700 dark:!text-zinc-200 !px-2.5">
              <span class="iconify tabler--link w-4 h-4"></span>
              From link
            </button>
          </SlimTooltip>
        </template>
      </BaseMessageInput>
    </div>

    <!-- Why Send is off, and the way round the composer -->
    <div class="mt-2.5 flex items-center gap-4 min-h-[18px]">
      <p v-if="blockedReason" class="text-xs text-amber-600 dark:text-amber-400">{{ blockedReason }}</p>
      <div class="flex-1"></div>
      <slot name="aside" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { toMediaUrl } from '@shared/media-url'
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
