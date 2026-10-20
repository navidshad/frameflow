<template>
  <div class="node-panel min-w-[280px] max-w-[320px] group cursor-move">
    <Handle type="target" :position="Position.Top" class="node-handle" />

    <!-- Header (AI: violet) -->
    <div class="node-head cursor-move">
      <span class="node-dot bg-secondary"></span>
      <span class="lbl !text-zinc-800 dark:!text-zinc-200">AI summary</span>
      <div class="flex-1"></div>
      <SlimTooltip text="Delete node and branches" placement="bottom">
        <button @click="data.onDelete" aria-label="Delete node and branches" class="node-icon-btn hover:!text-red-500 nodrag">
          <span class="iconify tabler--trash w-3.5 h-3.5"></span>
        </button>
      </SlimTooltip>
    </div>

    <!-- Summary content -->
    <div
      class="p-3 max-h-96 overflow-y-auto custom-scrollbar text-xs leading-relaxed text-zinc-700 dark:text-zinc-300 prose prose-sm dark:prose-invert prose-p:my-2 prose-ul:my-2 prose-li:my-0 nodrag select-text cursor-text"
      v-html="renderMarkdown(data.content)"
    ></div>

    <BaseMessageInput
      v-model="input"
      v-model:attachedImages="attachedImages"
      placeholder="Adjust or follow up..."
      compact
      class="nodrag interactive-in-pan"
      @send="submit"
    />

    <Handle type="source" :position="Position.Bottom" class="node-handle node-handle-out" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import SlimTooltip from '../SlimTooltip.vue'
import { renderMarkdown } from '../../utils/markdown'
import BaseMessageInput from '../chat/BaseMessageInput.vue'

const props = defineProps<{ data: any }>()
const input = ref('')
const attachedImages = ref<string[]>([])

const submit = (text: string, images: string[], count: number, isThinkingMode: boolean, autoUseImages: boolean) => {
  if ((text.trim() || images.length > 0) && props.data.onSubmit) {
    props.data.onSubmit(text, images, count, isThinkingMode, autoUseImages)
    input.value = ''
    attachedImages.value = []
  }
}
</script>
