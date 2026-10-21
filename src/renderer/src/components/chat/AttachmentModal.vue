<template>
  <AppDialog :model-value="modelValue" title="Choose Attachments" size="lg"
    @update:model-value="$emit('update:modelValue', $event)">
    <div class="flex flex-col h-[50vh]">
      <!-- Upload -->
      <div class="flex items-center mb-2.5">
        <span class="flex-1 text-[11px] text-zinc-500 dark:text-zinc-400">
          <span class="font-semibold text-zinc-800 dark:text-zinc-100">{{ allProjectImages.length }}</span> images available
          in this project
        </span>
        <button class="btn-text btn-text-primary !h-auto !px-0 !text-[11px]" @click="triggerFileUpload">Upload new</button>
      </div>

      <!-- Library grid -->
      <div class="flex-1 overflow-y-auto custom-scrollbar [scrollbar-gutter:stable]">
        <div v-if="allProjectImages.length > 0" class="grid grid-cols-4 sm:grid-cols-5 gap-1">
          <button v-for="(img, index) in allProjectImages" :key="index" type="button"
            class="group relative aspect-square rounded-[2px] overflow-hidden transition"
            :class="isSelected(img) ? 'ring-2 ring-primary' : 'ring-1 ring-[color:var(--ff-hairline)] hover:ring-[color:var(--ff-hairline-strong)]'"
            :aria-pressed="isSelected(img)" @click="toggleSelection(img)">
            <img :src="normalizeUrl(img)" class="w-full h-full object-cover" />
            <span v-if="isSelected(img)"
              class="absolute top-1 right-1 w-4 h-4 rounded-full bg-primary text-white flex items-center justify-center">
              <span class="iconify tabler--check w-3 h-3"></span>
            </span>
          </button>
        </div>

        <!-- Empty state -->
        <div v-else class="h-full flex flex-col items-center justify-center text-center text-zinc-500 py-12">
          <span class="iconify tabler--photo-off w-8 h-8 mb-3 opacity-60"></span>
          <p class="text-xs font-medium">No images found in this project</p>
          <p class="text-[11px] mt-1">Upload new images to get started</p>
        </div>
      </div>
    </div>

    <template #footer-start>
      <span v-if="selectedCount > 0" class="text-[11px] text-zinc-500">{{ selectedCount }} selected</span>
    </template>
    <template #footer>
      <button class="btn-text" @click="$emit('update:modelValue', false)">Cancel</button>
      <button class="btn-fill" :disabled="selectedCount === 0" @click="confirmSelection">Add to Prompt</button>
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { toMediaUrl } from '@shared/media-url'
import { ref, computed } from 'vue'
import { useVideoStore } from '../../stores/videoStore'
import AppDialog from '../AppDialog.vue'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits(['update:modelValue', 'select'])

const videoStore = useVideoStore()
const tempSelected = ref<string[]>([])

const allProjectImages = computed(() => {
  const thread = videoStore.currentThread;
  if (!thread) return [];

  // Combine source images and extracted reference frames
  const sourceImages = thread.preprocessing?.sourceImages || [];
  const referenceFrames = thread.preprocessing?.['reference-frames'] || [];

  // De-duplicate if necessary and return
  return [...new Set([...sourceImages, ...referenceFrames])];
})

const selectedCount = computed(() => tempSelected.value.length)

const normalizeUrl = (url: string) => toMediaUrl(url)

const isSelected = (url: string) => tempSelected.value.includes(url)

const toggleSelection = (url: string) => {
  const index = tempSelected.value.indexOf(url)
  if (index === -1) {
    tempSelected.value.push(url)
  } else {
    tempSelected.value.splice(index, 1)
  }
}

const triggerFileUpload = async () => {
  const result = await (window as any).api.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  })

  if (result && !result.canceled && result.filePaths.length > 0) {
    emit('select', result.filePaths)
    emit('update:modelValue', false)
    tempSelected.value = []
  }
}

const confirmSelection = () => {
  emit('select', [...tempSelected.value])
  emit('update:modelValue', false)
  tempSelected.value = []
}
</script>
