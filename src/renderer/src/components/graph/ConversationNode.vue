<template>
  <div class="node-panel min-w-[320px] group relative cursor-move"
    :style="{ width: nodeWidth + 'px', maxWidth: '800px' }">
    <!-- Resize Handle -->
    <div
      class="absolute top-0 right-0 w-1.5 h-full cursor-ew-resize hover:bg-primary/40 transition-colors z-[60] opacity-0 group-hover:opacity-100"
      @mousedown.stop.prevent="startResizing"></div>

    <Handle type="target" :position="Position.Top" class="node-handle" />

    <!-- Header with actions -->
    <div class="node-head cursor-move">
      <span class="node-dot bg-primary"></span>
      <span class="lbl !text-zinc-800 dark:!text-zinc-200">Conversation</span>
      <div class="flex-1"></div>
      <div class="node-actions flex items-center gap-2">
        <SlimTooltip v-if="!showInput && !data.hasInputInitially" text="Branch from this node" placement="bottom">
          <button @click="showInput = true" aria-label="Branch from this node" class="node-icon-btn">
            <span class="iconify tabler--git-branch w-3.5 h-3.5"></span>
          </button>
        </SlimTooltip>
        <SlimTooltip text="Delete node and branches" placement="bottom">
          <button @click="data.onDelete" aria-label="Delete node and branches" class="node-icon-btn hover:!text-red-500">
            <span class="iconify tabler--trash w-3.5 h-3.5"></span>
          </button>
        </SlimTooltip>
      </div>
    </div>

    <!-- Messages -->
    <div class="p-3 space-y-3">
      <div v-for="msg in data.messages" :key="msg.id" class="flex flex-col gap-1"
        :class="msg.role === 'user' ? 'items-end' : 'items-start'">

        <div class="flex items-center gap-2 px-0.5" :class="{ 'flex-row-reverse': msg.role !== 'user' }">
          <div class="flex items-center gap-2.5 opacity-0 group-hover:opacity-100 transition-opacity text-[9px] font-bold uppercase tracking-[.08em]">
            <button v-if="msg.role === 'user'" @click="confirmRetry(msg.id)"
              class="text-zinc-500 hover:text-primary transition-colors">Retry</button>
            <button v-if="msg.role === 'user' && editingMessageId !== msg.id" @click="startEditing(msg)"
              class="text-zinc-500 hover:text-primary transition-colors">Edit</button>
            <button v-if="msg.role === 'user'" @click="handleImprovise(msg.id)"
              class="text-secondary hover:text-secondary-dark dark:hover:text-secondary-light transition-colors">Improvise</button>
            <button @click="removeMessage(msg.id)"
              class="text-zinc-500 hover:text-red-500 transition-colors">Remove</button>
          </div>
          <span class="lbl !text-[9px]">{{ msg.role }}</span>
        </div>

        <div class="flex items-start gap-0.5 w-full group/msg" :class="msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'">
          <div class="text-xs leading-relaxed max-w-[88%] break-words relative"
            :class="msg.role === 'user'
              ? 'px-3 py-2 bg-primary/15 dark:bg-primary/20 text-zinc-900 dark:text-zinc-50 rounded-[10px_10px_2px_10px]'
              : 'text-zinc-700 dark:text-zinc-300'">

            <div v-if="msg.isPending && !msg.content" class="text-zinc-400 italic">AI is thinking...</div>
            <template v-else>
              <div v-html="renderMarkdown(msg.content)"
                class="prose prose-sm max-w-none dark:prose-invert prose-p:my-0 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 pointer-events-auto nodrag select-text cursor-text"></div>
            </template>

            <!-- Attached images -->
            <div v-if="msg.attachedImages && msg.attachedImages.length > 0" class="mt-2 flex flex-wrap gap-1.5 nodrag">
              <button v-for="(img, idx) in msg.attachedImages" :key="idx" type="button" aria-label="Preview image"
                class="relative w-10 h-10 rounded-[3px] overflow-hidden group/img cursor-pointer"
                :style="{ border: '1px solid var(--ff-hairline-strong)' }" @click="openPreview(img)">
                <img :src="mediaUrl(img)" class="w-full h-full object-cover" draggable="false" />
                <span class="absolute inset-0 bg-black/30 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center">
                  <span class="iconify tabler--zoom-in w-4 h-4 text-white"></span>
                </span>
              </button>
            </div>

            <!-- Files -->
            <div v-if="msg.files && msg.files.filter((f: any) => f.type !== 'original').length > 0" class="mt-2.5 space-y-2 nodrag">
              <div v-for="file in msg.files.filter((f: any) => f.type !== 'original')" :key="file.url"
                class="group/file hair-t pt-2 cursor-default">
                <div v-if="file.url.match(/\.(jpg|jpeg|png|webp)$/i) || file.type === 'preview' || file.type === 'actual'"
                  class="mb-2 rounded-[3px] overflow-hidden aspect-video bg-black/20"
                  :style="{ border: '1px solid var(--ff-hairline)' }">
                  <img :src="mediaUrl(file.url)" class="w-full h-full object-cover" draggable="false" />
                </div>

                <div class="flex items-center justify-between gap-2">
                  <div class="flex flex-col min-w-0">
                    <span class="text-[8px] font-bold uppercase tracking-widest text-primary/80">{{ file.type }}</span>
                    <span class="text-[9px] truncate text-zinc-500 font-mono">{{ file.url.split('/').pop() }}</span>
                  </div>
                  <SlimTooltip text="Save" placement="top">
                    <button @click.stop="handleSave(file.url)" aria-label="Save file" class="node-icon-btn hover:!text-primary shrink-0">
                      <span class="iconify tabler--download w-3.5 h-3.5"></span>
                    </button>
                  </SlimTooltip>
                </div>
              </div>
            </div>

            <!-- Running -->
            <div v-if="msg.isPending" class="mt-2.5 pt-2 hair-t flex items-center gap-3">
              <span class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wide text-primary">
                <span class="w-1.5 h-1.5 bg-primary rounded-full animate-ping"></span>Active Task
              </span>
              <SlimTooltip text="Stop process" placement="left">
                <button @click="videoStore.abortProcessing(msg.id)"
                  class="ml-auto text-[10px] font-bold uppercase tracking-wide text-red-500 hover:text-red-600 transition-colors">Stop</button>
              </SlimTooltip>
            </div>

            <!-- Improvise suggestion (AI: violet) -->
            <div v-if="improvisingIds.has(msg.id) || improvisedSuggestions[msg.id]"
              class="mt-2.5 pl-2.5 border-l-2 border-secondary/60">
              <div v-if="improvisingIds.has(msg.id)" class="text-[10px] text-secondary font-bold uppercase animate-pulse">
                Magic in progress...
              </div>
              <div v-else-if="improvisedSuggestions[msg.id]" class="space-y-2">
                <div class="text-xs leading-relaxed italic text-zinc-700 dark:text-zinc-200 select-text nodrag cursor-text prose prose-xs prose-p:my-1 dark:prose-invert"
                  v-html="renderMarkdown(improvisedSuggestions[msg.id])"></div>
                <div class="flex items-center gap-3 text-[10px] font-bold uppercase tracking-wide">
                  <button @click="acceptSuggestion(msg.id)" class="text-accent hover:opacity-80 transition-opacity">Accept</button>
                  <button @click="handleImprovise(msg.id)" class="text-secondary hover:opacity-80 transition-opacity">Retry</button>
                  <button @click="discardSuggestion(msg.id)" class="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors">Ignore</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Copy -->
          <div v-if="msg.content && !msg.isPending"
            class="mt-px opacity-0 group-hover/msg:opacity-100 transition-opacity shrink-0"
            :class="{ 'opacity-100': copiedId === msg.id }">
            <SlimTooltip :text="copiedId === msg.id ? 'Copied!' : 'Copy message'" placement="top">
              <button @click="copyMessage(msg.id, msg.content)" aria-label="Copy message" class="node-icon-btn">
                <span class="iconify w-3.5 h-3.5" :class="copiedId === msg.id ? 'tabler--check text-accent' : 'tabler--copy'"></span>
              </button>
            </SlimTooltip>
          </div>
        </div>
      </div>
    </div>

    <!-- Input -->
    <BaseMessageInput v-if="data.hasInputInitially || showInput" v-model="input" v-model:attachedImages="attachedImages"
      v-model:autoUseImages="localAutoUseImages"
      :placeholder="data.hasInputInitially ? 'Ask a follow-up...' : 'Branch from here...'" compact
      class="nodrag interactive-in-pan" @send="submit" />

    <RetryModal v-model="isRetryModalOpen" :message-id="currentRetryMessageId" @confirm="handleRetryConfirmed" />

    <Handle type="source" :position="Position.Bottom" class="node-handle node-handle-out" />

    <!-- Edit dialog -->
    <AppDialog v-model="isModalOpen" title="Edit Message" size="xl" @close="cancelEdit">
      <textarea v-model="editText" placeholder="Edit message..." rows="12"
        class="field !text-sm leading-relaxed resize-y min-h-[200px]"></textarea>
      <template #footer>
        <button class="btn-text" @click="cancelEdit">Cancel</button>
        <button class="btn-fill" @click="saveEdit">Save Changes</button>
      </template>
    </AppDialog>

    <!-- Full screen preview -->
    <Teleport to="body">
      <div v-if="isFullScreen" class="fixed inset-0 z-[9999] bg-black/90 flex flex-col items-center justify-center p-8"
        @click="isFullScreen = false">
        <button @click="isFullScreen = false" aria-label="Close preview"
          class="absolute top-6 right-6 w-8 h-8 flex items-center justify-center rounded-md text-white/80 hover:text-white hover:bg-white/10 transition z-50">
          <span class="iconify tabler--x w-5 h-5"></span>
        </button>
        <img :src="fullScreenImageUrl" class="max-w-full max-h-full rounded-[3px] object-contain" @click.stop />
      </div>
    </Teleport>
  </div>
</template>
<script setup lang="ts">
import { fromMediaUrl, toMediaUrl } from '@shared/media-url'
import { ref, watch } from 'vue'
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { useVideoStore } from '../../stores/videoStore'
import { dialog } from '../../composables/useDialog'
import SlimTooltip from '../SlimTooltip.vue'
import AppDialog from '../AppDialog.vue'
import { renderMarkdown } from '../../utils/markdown'
import BaseMessageInput from '../chat/BaseMessageInput.vue'
import RetryModal from '../chat/RetryModal.vue'

const props = defineProps<{ data: any }>()
const emit = defineEmits(['node-resize-stop'])
const { viewport } = useVueFlow()
const videoStore = useVideoStore()

// Resizing logic
const nodeWidth = ref(props.data.width || 380)

// Sync width if it changes from parent/store
watch(() => props.data.width, (newWidth) => {
  if (newWidth && !isResizing.value) {
    nodeWidth.value = newWidth
  }
})
const isResizing = ref(false)

const startResizing = (e: MouseEvent) => {
  isResizing.value = true
  document.body.style.cursor = 'ew-resize'
  document.body.style.userSelect = 'none'
  const startX = e.clientX
  const startWidth = nodeWidth.value

  const onMouseMove = (moveEvent: MouseEvent) => {
    if (!isResizing.value) return
    const zoom = viewport.value.zoom || 1
    const deltaX = (moveEvent.clientX - startX) / zoom
    const newWidth = Math.min(800, Math.max(320, startWidth + deltaX))
    nodeWidth.value = newWidth
  }

  const onMouseUp = () => {
    if (isResizing.value) {
      isResizing.value = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      emit('node-resize-stop', nodeWidth.value)
    }
  }

  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}
const input = ref('')
const showInput = ref(false)
const copiedId = ref<string | null>(null)
const attachedImages = ref<string[]>([])

const improvisingIds = ref(new Set<string>())
const improvisedSuggestions = ref<Record<string, string>>({})
const localAutoUseImages = ref(false)

// Inherit image access setting from last message in branch
watch(() => props.data.messages, (msgs) => {
  if (msgs && msgs.length > 0) {
    const lastMsg = msgs[msgs.length - 1]
    localAutoUseImages.value = lastMsg.autoUseImages || false
  }
}, { immediate: true })

const handleImprovise = async (messageId: string) => {
  improvisingIds.value.add(messageId)
  delete improvisedSuggestions.value[messageId]
  
  const result = await videoStore.improviseMessage(messageId)
  if (result) {
    improvisedSuggestions.value[messageId] = result
  }
  improvisingIds.value.delete(messageId)
}

const acceptSuggestion = async (messageId: string) => {
  const content = improvisedSuggestions.value[messageId]
  if (!content) return
  
  const success = await videoStore.updateMessageContent(messageId, content)
  if (success) {
    discardSuggestion(messageId)
  }
}

const discardSuggestion = (messageId: string) => {
  delete improvisedSuggestions.value[messageId]
}

const editingMessageId = ref<string | null>(null)
const editText = ref('')
const isModalOpen = ref(false)

const isFullScreen = ref(false)
const fullScreenImageUrl = ref('')

const openPreview = (url: string) => {
  fullScreenImageUrl.value = mediaUrl(url)
  isFullScreen.value = true
}

const startEditing = (msg: any) => {
  editingMessageId.value = msg.id
  editText.value = msg.content
  isModalOpen.value = true
}

const cancelEdit = () => {
  editingMessageId.value = null
  editText.value = ''
  isModalOpen.value = false
}

const saveEdit = async () => {
  if (!editingMessageId.value) return
  if (editText.value.trim() === '') return

  const success = await videoStore.updateMessageContent(editingMessageId.value, editText.value)
  if (success) {
    cancelEdit()
  }
}

const isRetryModalOpen = ref(false)
const currentRetryMessageId = ref<string | null>(null)

const confirmRetry = async (messageId: string) => {
  currentRetryMessageId.value = messageId
  isRetryModalOpen.value = true
}

const handleRetryConfirmed = async (messageId: string, shouldRemoveBranch: boolean, count: number, isThinkingMode: boolean, autoUseImages: boolean) => {
  await videoStore.retryMessage(messageId, shouldRemoveBranch, count, isThinkingMode, autoUseImages)
}

const removeMessage = async (messageId: string) => {
  const confirmed = await dialog.confirm({
    title: 'Remove Message',
    message: 'Are you sure you want to remove this message from the conversation?',
    detail: 'This will delete the message and its artifacts. Subsequent messages in this node will be preserved.',
    confirmLabel: 'Remove',
    danger: true
  })

  if (confirmed) {
    await videoStore.removeSingleMessage(messageId)
  }
}

const copyMessage = (id: string, content: string) => {
  navigator.clipboard.writeText(content).then(() => {
    copiedId.value = id
    setTimeout(() => {
      if (copiedId.value === id) copiedId.value = null
    }, 2000)
  })
}

const submit = (text: string, images: string[], count: number, isThinkingMode: boolean, autoUseImages: boolean) => {
  if ((text.trim() || images.length > 0) && props.data.onSubmit) {
    props.data.onSubmit(text, images, count, isThinkingMode, autoUseImages)
    input.value = ''
    attachedImages.value = []
    showInput.value = false
  }
}

const mediaUrl = (url: string) => toMediaUrl(url)

const handleSave = async (url: string) => {
  if (url && (window as any).api) {
    const cleanPath = fromMediaUrl(url)
    await (window as any).api.saveVideo(cleanPath)
  }
}
</script>
