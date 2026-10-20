<template>
  <AppDialog :model-value="modelValue" title="Retry Generation" size="md"
    @update:model-value="$emit('update:modelValue', $event)">
    <p class="text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug mb-1.5">
      The generation will restart from this message. You can choose to either branch out or remove existing
      subsequent messages.
    </p>

    <OptionRow :checked="shouldRemoveBranch" label="Clean up branch"
      description="Remove subsequent messages in this branch" @toggle="shouldRemoveBranch = !shouldRemoveBranch" />

    <!-- Multi-gen count -->
    <div class="flex items-center gap-3 py-1.5">
      <div class="flex-1">
        <label for="retry-count" class="block text-xs font-semibold">Generation Count</label>
        <span class="block text-[11px] text-zinc-500 dark:text-zinc-400">How many parallel variations to trigger</span>
      </div>
      <span class="lbl">Results</span>
      <select id="retry-count" v-model="resultsCount" class="field !w-14 cursor-pointer">
        <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
      </select>
    </div>

    <OptionRow :checked="isThinkingMode" tone="ai" description="Activate Chain of Thought (CoT)"
      @toggle="isThinkingMode = !isThinkingMode">
      <template #label><span class="lbl !text-[9px] mr-1.5">Experimental</span>Thinking Mode</template>
    </OptionRow>

    <OptionRow :checked="autoUseImages" label="Smart Auto-References"
      description="Automatically use project images as references" @toggle="autoUseImages = !autoUseImages" />

    <template #footer>
      <button class="btn-text" @click="$emit('update:modelValue', false)">Cancel</button>
      <button class="btn-fill" @click="handleConfirm">Retry Generation</button>
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import AppDialog from '../AppDialog.vue'
import OptionRow from '../OptionRow.vue'
import { useVideoStore } from '../../stores/videoStore'

const props = defineProps<{
  modelValue: boolean
  messageId: string | null
}>()

const emit = defineEmits(['update:modelValue', 'confirm'])

const videoStore = useVideoStore()
const shouldRemoveBranch = ref(true)
const resultsCount = ref(1)
const isThinkingMode = ref(false)
const autoUseImages = ref(false)

// Sync with message initial state when opened
watch([() => props.modelValue, () => props.messageId], ([isOpen, msgId]) => {
  if (isOpen && msgId && videoStore.currentThread) {
    const msg = videoStore.currentThread.messages.find(m => m.id === msgId)
    if (msg) {
      autoUseImages.value = msg.autoUseImages || false
    }
  }
}, { immediate: true })

const handleConfirm = () => {
  if (props.messageId) {
    emit('confirm', props.messageId, shouldRemoveBranch.value, resultsCount.value, isThinkingMode.value, autoUseImages.value)
    emit('update:modelValue', false)
  }
}
</script>
