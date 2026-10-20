<template>
  <div class="flex flex-col" :class="compact ? 'gap-0' : 'w-full gap-2'">
    <!-- Attached images -->
    <div v-if="attachedImages.length > 0" class="flex flex-wrap gap-2" :class="compact ? 'px-3 pt-2' : ''">
      <div v-for="(img, idx) in attachedImages" :key="idx" class="relative group rounded-[3px]"
        :class="compact ? 'w-10 h-10' : 'w-14 h-14'" :style="{ border: '1px solid var(--ff-hairline-strong)' }">
        <img :src="normalizeUrl(img)" class="w-full h-full object-cover rounded-[2px]" />
        <button @click.stop="removeAttachment(idx)" aria-label="Remove attachment"
          class="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500 dark:hover:bg-red-500 dark:hover:text-white">
          <span class="iconify tabler--x w-2.5 h-2.5"></span>
        </button>
      </div>
    </div>

    <!-- One flat field, bounded by hairlines -->
    <div :class="compact ? 'hair-t' : 'hair-y-strong'">
      <textarea v-model="internalText" ref="textareaRef" :placeholder="placeholder" :rows="1"
        class="w-full block bg-transparent border-none focus:ring-0 focus:outline-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 resize-none leading-relaxed custom-scrollbar"
        :class="compact ? 'text-[11px] max-h-[150px] px-3 py-2' : 'text-base max-h-[300px] px-0.5 pt-[18px] pb-5 min-h-[48px]'"
        @input="adjustTextarea" @keydown.enter="handleEnter"></textarea>

      <!-- Actions -->
      <div class="flex items-center justify-between gap-2 hair-t" :class="compact ? 'px-2 py-1' : 'pt-2 pb-2.5'">
        <div class="flex items-center gap-1.5">
          <!-- Attachment toggle.
               Overridable because AttachmentModal is THREAD-scoped: it lists
               videoStore.currentThread's sourceImages, and currentThreadId is
               never cleared on leaving a thread. Anywhere outside a thread
               (the Home composer) must supply its own attach controls. -->
          <slot name="attach">
            <SlimTooltip text="Add Attachments" :placement="compact ? 'top' : 'bottom'">
              <button type="button" class="btn-icon" aria-label="Add attachments" @click="showAttachmentModal = true">
                <span class="iconify tabler--plus w-4 h-4"></span>
              </button>
            </SlimTooltip>
          </slot>

          <!-- Auto Use Images Toggle -->
          <SlimTooltip v-if="showAutoImages" text="Smart Auto-References: Include project images as context" :placement="compact ? 'top' : 'bottom'">
            <button type="button" @click="toggleAutoUseImages" :aria-pressed="props.autoUseImages"
              class="btn-icon" :class="props.autoUseImages ? '!text-primary bg-primary/10' : ''">
              <span class="iconify tabler--blade-filled w-3.5 h-3.5"></span>
            </button>
          </SlimTooltip>
        </div>

        <div class="flex items-center gap-1.5">
          <!-- Results Count -->
          <SlimTooltip v-if="showSamples" text="Number of result variations to generate" :placement="compact ? 'top' : 'bottom'">
            <label class="flex items-center gap-1.5 px-1 cursor-pointer">
              <span class="lbl select-none">Samples</span>
              <select v-model="resultsCount"
                class="bg-transparent border-none text-[11px] font-semibold text-zinc-800 dark:text-zinc-200 focus:ring-0 focus:outline-none p-0 pr-1 cursor-pointer hover:text-primary transition-colors">
                <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
              </select>
            </label>
          </SlimTooltip>

          <!-- Thinking Mode Toggle (AI: violet) -->
          <SlimTooltip v-if="showThinking" text="Thinking Mode (CoT)" :placement="compact ? 'top' : 'bottom'">
            <button type="button" @click="isThinkingMode = !isThinkingMode" :aria-pressed="isThinkingMode"
              class="btn-icon" :class="isThinkingMode ? '!text-secondary bg-secondary/10' : ''">
              <span class="iconify tabler--brain w-4 h-4"></span>
            </button>
          </SlimTooltip>

          <SlimTooltip
            :text="sendDisabled && sendDisabledReason ? sendDisabledReason : 'Send Message (Enter)'"
            :placement="compact ? 'top' : 'bottom'">
            <button type="button" aria-label="Send" @click="handleSend"
              class="flex items-center justify-center rounded-md bg-primary text-white transition-colors hover:bg-primary-dark disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-primary"
              :class="compact ? 'w-7 h-6' : 'w-9 h-[30px]'"
              :disabled="sendDisabled || (!allowEmptySend && !internalText.trim() && attachedImages.length === 0)">
              <span class="iconify tabler--send w-4 h-4"></span>
            </button>
          </SlimTooltip>
        </div>
      </div>
    </div>

    <AttachmentModal v-model="showAttachmentModal" @select="handleImagesSelected" />
  </div>
</template>

<script setup lang="ts">
import { toMediaUrl } from '@shared/media-url'
import { ref, watch, onMounted } from 'vue'
import SlimTooltip from '../SlimTooltip.vue'
import AttachmentModal from './AttachmentModal.vue'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  attachedImages?: string[]
  compact?: boolean
  autoUseImages?: boolean
  /** Block sending for a caller-specific reason (e.g. no source file chosen). */
  sendDisabled?: boolean
  /** Shown on the send tooltip so the block is never a silent no-op. */
  sendDisabledReason?: string
  /** Controls that only mean something for the AI-graph pipeline; hidden for the editor path. */
  showSamples?: boolean
  showThinking?: boolean
  showAutoImages?: boolean
  /** Allow sending with no text — e.g. "just open this file", where the prompt is optional. */
  allowEmptySend?: boolean
}>(), {
  placeholder: 'Type a message...',
  attachedImages: () => [],
  compact: false,
  autoUseImages: false,
  sendDisabled: false,
  showSamples: true,
  showThinking: true,
  showAutoImages: true,
  allowEmptySend: false
})

const emit = defineEmits(['update:modelValue', 'update:attachedImages', 'send', 'update:autoUseImages'])

const internalText = ref(props.modelValue)
const resultsCount = ref(1)
const isThinkingMode = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const showAttachmentModal = ref(false)

// Sync modelValue
watch(() => props.modelValue, (newVal) => {
  internalText.value = newVal
})

watch(internalText, (newVal) => {
  emit('update:modelValue', newVal)
})

const normalizeUrl = (url: string) => toMediaUrl(url)

const toggleAutoUseImages = () => {
  emit('update:autoUseImages', !props.autoUseImages)
}

const adjustTextarea = () => {
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto'
    textareaRef.value.style.height = textareaRef.value.scrollHeight + 'px'
  }
}

const handleEnter = (e: KeyboardEvent) => {
  if (!(e.metaKey || e.ctrlKey)) return
  // Mirror the send button's rule, allowEmptySend included — otherwise the
  // keyboard and the button disagree about whether an empty prompt can send.
  const hasContent = internalText.value.trim() || props.attachedImages.length > 0
  if (!hasContent && !props.allowEmptySend) return
  e.preventDefault()
  handleSend()
}

const handleImagesSelected = (images: string[]) => {
  const updated = [...props.attachedImages, ...images]
  emit('update:attachedImages', updated)
}

const removeAttachment = (index: number) => {
  const updated = [...props.attachedImages]
  updated.splice(index, 1)
  emit('update:attachedImages', updated)
}

const handleSend = () => {
  if (props.sendDisabled) return
  if (!props.allowEmptySend && !internalText.value.trim() && props.attachedImages.length === 0) return
  emit('send', internalText.value, [...props.attachedImages], resultsCount.value, isThinkingMode.value, props.autoUseImages)

  // Clear local state if parent doesn't reset via props (standard pattern)
  internalText.value = ''
  emit('update:attachedImages', [])

  setTimeout(adjustTextarea, 0)
}

onMounted(() => {
  adjustTextarea()
})

defineExpose({
  focus: () => textareaRef.value?.focus()
})
</script>
