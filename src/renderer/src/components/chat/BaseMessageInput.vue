<template>
  <div class="flex flex-col space-y-2" :class="[compact ? '' : 'max-w-4xl mx-auto w-full']">
    <!-- Attached Images Preview -->
    <div v-if="attachedImages.length > 0" class="flex flex-wrap gap-2 px-1 mb-1">
      <div v-for="(img, idx) in attachedImages" :key="idx"
        class="relative rounded-xl group shadow-md border border-zinc-200 dark:border-zinc-800 transition-all hover:scale-105 active:scale-95"
        :class="compact ? 'w-10 h-10' : 'w-16 h-16'">
        <img :src="normalizeUrl(img)" class="w-full h-full object-cover rounded-xl" />

        <!-- Remove Button: Positioned absolute relative to thumbnail, avoids overflow-hidden clipping -->
        <div
          class="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-all z-30 scale-75 group-hover:scale-100 origin-center pointer-events-auto">

          <button @click.stop="removeAttachment(idx)"
            class="flex items-center justify-center w-4 h-4 bg-red-500 text-white rounded-full shadow-lg hover:bg-red-600 active:scale-90 transition-all">
            <Icon name="iconify tabler--x" class="w-2.5 h-2.5" />
          </button>

        </div>
      </div>
    </div>

    <!-- Main Input area -->
    <div class="flex flex-col transition-all duration-300" :class="[
      compact
        ? 'space-y-1 bg-zinc-50/50 dark:bg-white/[0.02] p-2 rounded-xl border border-black/5 dark:border-white/5'
        : 'space-y-4 p-4 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-950/20 backdrop-blur-xl shadow-lg focus-within:ring-2 focus-within:ring-primary/20'
    ]">
      <!-- Row 1: Textarea -->
      <div class="flex-1 min-w-0">
        <textarea v-model="internalText" ref="textareaRef" :placeholder="placeholder" :rows="1"
          class="w-full bg-transparent border-none focus:ring-0 focus:outline-none text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 resize-none py-2 px-1 leading-relaxed custom-scrollbar"
          :class="compact ? 'text-[11px] max-h-[150px]' : 'text-sm max-h-[300px]'" @input="adjustTextarea"
          @keydown.enter="handleEnter"></textarea>
      </div>

      <!-- Row 2: Actions -->
      <div class="flex items-center justify-between gap-2 border-t border-black/5 dark:border-white/5 pt-1.5 mt-1">
        <div class="flex items-center gap-1.5">
          <!-- Attachment Toggle.
               Overridable because AttachmentModal is THREAD-scoped: it lists
               videoStore.currentThread's sourceImages, and currentThreadId is
               never cleared on leaving a thread. Anywhere outside a thread
               (the Home composer) must supply its own attach controls. -->
          <slot name="attach">
            <SlimTooltip text="Add Attachments" :placement="compact ? 'top' : 'bottom'">
              <IconButton @click="showAttachmentModal = true" icon="IconPlus" :size="compact ? 'sm' : 'md'" rounded="full"
                variant="ghost" class="text-zinc-400 hover:text-primary transition-all active:scale-95" />
            </SlimTooltip>
          </slot>

          <!-- Auto Use Images Toggle -->
          <SlimTooltip v-if="showAutoImages" text="Smart Auto-References: Include project images as context" :placement="compact ? 'top' : 'bottom'">
             <button 
              @click="toggleAutoUseImages"
              type="button"
              class="flex items-center justify-center p-1.5 rounded-lg border transition-all active:scale-95"
              :class="[
                props.autoUseImages
                  ? 'bg-primary/10 border-primary/30 text-primary shadow-sm shadow-primary/10'
                  : 'bg-zinc-100 dark:bg-white/5 border-black/5 dark:border-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
              ]"
            >
              <Icon name="iconify tabler--blade-filled" class="w-3.5 h-3.5" :class="{ 'animate-pulse': props.autoUseImages }" />
            </button>
          </SlimTooltip>
        </div>

        <div class="flex items-center gap-1.5">
          <!-- Results Count -->
          <SlimTooltip v-if="showSamples" text="Number of result variations to generate" :placement="compact ? 'top' : 'bottom'">
            <div
              class="flex items-center bg-zinc-100 dark:bg-white/5 rounded-xl px-2 py-1 border border-black/5 dark:border-white/10 group/count hover:border-primary/30 transition-colors"
              :class="compact ? 'scale-90 origin-right' : ''">
              <span
                class="text-[9px] font-black uppercase tracking-widest text-zinc-400 group-hover/count:text-primary/70 transition-colors mr-1.5 select-none pl-1">Samples</span>
              <select v-model="resultsCount"
                class="bg-transparent border-none text-[11px] font-black text-zinc-700 dark:text-zinc-300 focus:ring-0 p-0 pr-4 cursor-pointer hover:text-primary transition-colors">
                <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
          </SlimTooltip>

          <!-- Thinking Mode Toggle -->
          <SlimTooltip v-if="showThinking" text="Thinking Mode (CoT)" :placement="compact ? 'top' : 'bottom'">
            <button @click="isThinkingMode = !isThinkingMode"
              class="flex items-center justify-center p-2 rounded-xl border transition-all active:scale-95" :class="[
                isThinkingMode
                  ? 'bg-purple-500/10 border-purple-500/30 text-purple-600 dark:text-purple-400 shadow-sm shadow-purple-500/10'
                  : 'bg-zinc-100 dark:bg-white/5 border-black/5 dark:border-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
              ]">
              <Icon name="iconify tabler--brain" class="w-4 h-4" :class="isThinkingMode ? 'animate-pulse' : ''" />
            </button>
          </SlimTooltip>

          <SlimTooltip
            :text="sendDisabled && sendDisabledReason
              ? sendDisabledReason
              : (submitIcon === 'IconSend' ? 'Send Message (Enter)' : 'Execute Task')"
            :placement="compact ? 'top' : 'bottom'">
            <IconButton @click="handleSend" :icon="submitIcon" color="primary" :size="compact ? 'xs' : 'sm'" rounded="lg"
              :disabled="sendDisabled || (!allowEmptySend && !internalText.trim() && attachedImages.length === 0)" />
          </SlimTooltip>
        </div>
      </div>
    </div>

    <AttachmentModal v-model="showAttachmentModal" @select="handleImagesSelected" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { Icon, IconButton } from 'pilotui/elements'
import SlimTooltip from '../SlimTooltip.vue'
import AttachmentModal from './AttachmentModal.vue'

const props = withDefaults(defineProps<{
  modelValue: string
  placeholder?: string
  attachedImages?: string[]
  compact?: boolean
  submitIcon?: string
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
  submitIcon: 'IconSend',
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

const normalizeUrl = (url: string) => {
  if (!url) return ''
  return url.startsWith('media://') ? url : `media://${url}`
}

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
