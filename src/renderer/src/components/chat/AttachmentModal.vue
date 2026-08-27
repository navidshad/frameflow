<template>
  <Modal :modelValue="modelValue" @update:modelValue="$emit('update:modelValue', $event)" size="lg"
    title="Choose Attachments">
    <!-- Suppress default trigger as we use custom triggers in parents -->
    <template #trigger><span class="hidden"></span></template>

    <template #default="{ toggleModal }">
      <div class="flex flex-col h-[60vh]">
        <!-- Action Header: Upload -->
        <div class="flex items-center justify-between mb-6">
          <div class="text-sm text-zinc-500">
            <span class="font-bold text-zinc-900 dark:text-white">{{ allProjectImages.length }}</span> images available
            in this project
          </div>
          <Button @click="triggerFileUpload" variant="primary" size="sm">
            <template #left-icon>
              <span class="icon-[tabler--upload] w-4 h-4"></span>
            </template>
            Upload New
          </Button>
        </div>

        <!-- Library Grid -->
        <div class="flex-1 overflow-y-auto custom-scrollbar pr-1 [scrollbar-gutter:stable]">
          <div v-if="allProjectImages.length > 0" class="grid grid-cols-5 sm:grid-cols-6 gap-3 p-1">
            <div v-for="(img, index) in allProjectImages" :key="index"
              class="group relative aspect-square rounded-xl overflow-hidden border-2 cursor-pointer transition-all hover:scale-[1.02] active:scale-95"
              :class="isSelected(img) ? 'border-primary ring-2 ring-primary/20' : 'border-zinc-100 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'"
              @click="toggleSelection(img)">
              <img :src="normalizeUrl(img)" class="w-full h-full object-cover" />

              <!-- Selection Overlay -->
              <div v-if="isSelected(img)"
                class="absolute inset-0 bg-primary/20 flex items-center justify-center animate-in fade-in zoom-in-75 duration-200">
                <div class="bg-primary text-white p-1.5 rounded-full shadow-lg scale-110">
                  <span class="icon-[tabler--check] w-4 h-4 font-bold"></span>
                </div>
              </div>

              <!-- Hover Status -->
              <div v-else class="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors"></div>
            </div>
          </div>

          <!-- Empty State -->
          <div v-else class="h-full flex flex-col items-center justify-center text-center opacity-50 py-12">
            <span class="icon-[tabler--photo-off] w-12 h-12 mb-4"></span>
            <p class="text-sm font-medium">No images found in this project</p>
            <p class="text-xs">Upload new images to get started</p>
          </div>
        </div>

        <!-- Footer Actions -->
        <div class="mt-6 flex items-center justify-between border-t border-zinc-100 dark:border-zinc-800 pt-6">
          <div class="flex items-center space-x-2">
            <div v-if="selectedCount > 0"
              class="px-2.5 py-1 bg-primary/10 text-primary rounded-full text-[10px] font-black uppercase tracking-wider">
              {{ selectedCount }} selected
            </div>
          </div>
          <div class="flex space-x-3">
            <Button variant="outline" size="md" @click="toggleModal(false)">Cancel</Button>
            <Button variant="primary" size="md" @click="confirmSelection" :disabled="selectedCount === 0"
              class="min-w-[120px]">
              Add to Prompt
            </Button>
          </div>
        </div>
      </div>
    </template>
  </Modal>
</template>

<script setup lang="ts">
import { toMediaUrl } from '@shared/media-url'
import { ref, computed } from 'vue'
import { useVideoStore } from '../../stores/videoStore'
import { Modal } from 'pilotui/complex'
import { Button } from 'pilotui/elements'

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
