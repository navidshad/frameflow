<template>
  <div class="glass-card p-0 rounded-3xl min-w-[320px] overflow-hidden flex flex-col group relative cursor-move"
    :class="[isResizing ? '' : 'glass-card-hover']"
    :style="{ width: nodeWidth + 'px', maxWidth: '800px' }">
    <!-- Resize Handle -->
    <div
      class="absolute top-0 right-0 w-1.5 h-full cursor-ew-resize hover:bg-primary/40 transition-colors z-[60] opacity-0 group-hover:opacity-100"
      @mousedown.stop.prevent="startResizing"></div>

    <Handle type="target" :position="Position.Top"
      class="w-3 h-3 bg-zinc-400 dark:bg-zinc-500 border-2 border-white dark:border-zinc-800" />

    <!-- Header with Actions -->
    <div
      class="px-4 py-2 bg-black/5 dark:bg-white/5 border-b border-black/5 dark:border-white/5 flex items-center justify-between cursor-move">
      <div class="flex items-center space-x-2 cursor-move">
        <div class="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_rgba(var(--primary),0.5)]"></div>
        <span
          class="text-[10px] font-black uppercase tracking-widest text-zinc-500 dark:text-zinc-400">Conversation</span>
      </div>
      <div class="flex items-center space-x-1">
        <SlimTooltip v-if="!showInput && !data.hasInputInitially" text="Branch from this node" placement="bottom">
          <button @click="showInput = true"
            class="p-1 hover:bg-blue-500/10 rounded-md text-zinc-400 hover:text-blue-500 transition-colors"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>
            </svg>
          </button>
        </SlimTooltip>
        <SlimTooltip text="Delete node and branches" placement="bottom">
          <button @click="data.onDelete"
            class="p-1 hover:bg-red-500/10 rounded-md text-zinc-400 hover:text-red-500 transition-colors"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16">
              </path>
            </svg>
          </button>
        </SlimTooltip>
      </div>
    </div>

    <!-- Messages List -->
    <div class="p-4 space-y-4">
      <div v-for="msg in data.messages" :key="msg.id"
        class="flex flex-col space-y-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
        :class="msg.role === 'user' ? 'items-end' : 'items-start'">

        <div class="flex items-center gap-2 px-1" :class="{ 'flex-row-reverse': msg.role !== 'user' }">


          <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <div v-if="msg.role === 'user'" @click="confirmRetry(msg.id)"
              class="text-[9px] font-bold text-blue-500 hover:underline cursor-pointer uppercase">
              Retry
            </div>
            <div v-if="msg.role === 'user' && editingMessageId !== msg.id" @click="startEditing(msg)"
              class="text-[9px] font-bold text-zinc-400 hover:text-primary cursor-pointer uppercase">
              Edit</div>
            <div v-if="msg.role === 'user'" @click="handleImprovise(msg.id)"
              class="text-[9px] font-bold text-purple-500 hover:text-purple-400 cursor-pointer uppercase flex items-center gap-0.5">
              <svg class="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2l2.4 7.2h7.6l-6.1 4.4 2.3 7.4-6.2-4.6-6.2 4.6 2.3-7.4-6.1-4.4h7.6z" />
              </svg>
              Improvise
            </div>
            <div @click="removeMessage(msg.id)"
              class="text-[9px] font-bold text-zinc-400 hover:text-red-500 cursor-pointer uppercase">
              Remove</div>
          </div>

          <div class="flex items-center">
            <span class="text-[9px] uppercase font-black tracking-widest text-zinc-500 dark:text-zinc-500">
              {{ msg.role }}
            </span>
          </div>
        </div>

        <div class="flex items-start gap-0.5 w-full group/msg" :class="msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'">
          <div
            class="px-4 py-2.5 rounded-[1.25rem] text-sm leading-relaxed max-w-[85%] break-words relative transition-all duration-300"
            :class="[
              msg.role === 'user'
                ? 'bg-gradient-to-br from-primary to-primary-dark text-white rounded-tr-none shadow-lg shadow-primary/20 font-medium'
                : 'bg-white/60 dark:bg-zinc-800/60 text-zinc-900 dark:text-zinc-100 rounded-tl-none border border-black/5 dark:border-white/5 backdrop-blur-sm',
              msg.isPending ? 'ring-2 ring-primary/20 bg-primary/5 dark:bg-primary/10 transition-all duration-1000 animate-pulse' : ''
            ]">

            <div v-if="msg.isPending && !msg.content"
              class="text-zinc-400 italic font-medium flex items-center space-x-2">
              <span>AI is thinking...</span>
            </div>
            <template v-else>
              <div v-html="renderMarkdown(msg.content)"
                class="prose prose-sm max-w-none prose-p:my-0 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 shadow-none border-none pointer-events-auto nodrag select-text cursor-text"
                :class="msg.role === 'user' ? 'prose-invert text-white' : 'dark:prose-invert'"></div>
            </template>

            <!-- Attached Images -->
            <div v-if="msg.attachedImages && msg.attachedImages.length > 0" class="mt-2 mb-1 flex flex-wrap gap-1.5 nodrag">
              <div v-for="(img, idx) in msg.attachedImages" :key="idx"
                class="relative w-10 h-10 rounded-lg overflow-hidden group/img cursor-pointer transition-all duration-300 hover:scale-[1.1] shadow-sm border border-black/5 dark:border-white/10"
                @click="openPreview(img)">
                <img :src="mediaUrl(img)" class="w-full h-full object-cover" draggable="false" />
                <div
                  class="absolute inset-0 bg-black/20 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center">
                  <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"></path>
                  </svg>
                </div>
              </div>
            </div>

            <!-- Files -->
            <div v-if="msg.files && msg.files.filter((f: any) => f.type !== 'original').length > 0"
              class="mt-3 space-y-2 nodrag">
              <div v-for="file in msg.files.filter((f: any) => f.type !== 'original')" :key="file.url"
                class="group/file p-2 bg-black/5 dark:bg-white/5 rounded-xl border border-black/5 dark:border-white/10 hover:border-primary/30 transition-all overflow-hidden cursor-default">
                <div v-if="file.url.match(/\.(jpg|jpeg|png|webp)$/i) || file.type === 'preview' || file.type === 'actual'"
                  class="mb-2 rounded-lg overflow-hidden border border-black/10 dark:border-white/10 aspect-video bg-black/20">
                  <img :src="mediaUrl(file.url)"
                    class="w-full h-full object-cover group-hover/file:scale-110 transition-transform duration-500" draggable="false" />
                </div>

                <div class="flex items-center justify-between gap-2">
                  <div class="flex flex-col min-w-0">
                    <span class="text-[8px] font-black uppercase tracking-widest text-primary/70">{{ file.type }}</span>
                    <span class="text-[9px] truncate text-zinc-500 font-mono">{{ file.url.split('/').pop() }}</span>
                  </div>
                    <SlimTooltip text="Save" placement="top">
                      <button @click.stop="handleSave(file.url)"
                        class="p-1 px-1.5 bg-primary/10 hover:bg-primary/20 text-primary rounded-md transition-colors flex-shrink-0"
                      >
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path d="M8 17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3m-1 7l-4 4-4-4m4 4V10"
                            stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </button>
                    </SlimTooltip>
                </div>
              </div>
            </div>

            <div v-if="msg.isPending" class="mt-3 pt-2 border-t border-blue-500/10 flex items-center justify-between">
              <div class="flex items-center space-x-2 text-[10px] font-bold text-blue-500 uppercase tracking-tighter">
                <div class="w-2 h-2 bg-blue-500 rounded-full animate-ping"></div>
                <span>Active Task</span>
              </div>

              <SlimTooltip v-if="msg.isPending" text="Stop process" placement="left">
                <button @click="videoStore.abortProcessing(msg.id)"
                  class="flex items-center space-x-1.5 px-2 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-500 rounded-lg transition-all border border-red-500/20 hover:border-red-500/40 ml-4"
                >
                  <div class="w-1.5 h-1.5 bg-red-500 rounded-sm"></div>
                  <span class="text-[9px] font-bold tracking-wider uppercase leading-none">Stop</span>
                </button>
              </SlimTooltip>

              <div class="flex space-x-1 grayscale opacity-50 ml-auto">
                <div class="w-1 h-1 bg-blue-500 rounded-full animate-bounce [animation-delay:0s]"></div>
                <div class="w-1 h-1 bg-blue-500 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                <div class="w-1 h-1 bg-blue-500 rounded-full animate-bounce [animation-delay:0.4s]"></div>
              </div>
            </div>

            <!-- Improvise Suggestion UI -->
            <div v-if="improvisingIds.has(msg.id) || improvisedSuggestions[msg.id]" 
              class="mt-3 pt-3 border-t border-white/10 animate-in fade-in slide-in-from-top-2 duration-300">
              <div v-if="improvisingIds.has(msg.id)" class="flex items-center gap-2 text-[10px] text-purple-300 font-bold uppercase italic animate-pulse">
                <div class="w-1.5 h-1.5 bg-purple-400 rounded-full"></div>
                Magic in progress...
              </div>
              <div v-else-if="improvisedSuggestions[msg.id]" class="space-y-3">
                <div class="p-2.5 bg-white/10 rounded-xl border border-white/10 text-[13px] leading-relaxed italic text-purple-100/90 select-text nodrag cursor-text ring-1 ring-purple-500/30 prose prose-xs prose-p:my-1 prose-pre:bg-black/20 prose-pre:my-1 dark:prose-invert"
                  v-html="renderMarkdown(improvisedSuggestions[msg.id])">
                </div>
                <div class="flex items-center gap-2">
                  <button @click="acceptSuggestion(msg.id)" 
                    class="px-2.5 py-1 bg-white/20 hover:bg-white/30 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all flex items-center gap-1">
                    <svg class="w-2.5 h-2.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                    </svg>
                    Accept
                  </button>
                  <button @click="handleImprovise(msg.id)"
                    class="px-2.5 py-1 bg-purple-500/20 hover:bg-purple-500/30 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all flex items-center gap-1">
                    <svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Retry
                  </button>
                  <button @click="discardSuggestion(msg.id)"
                    class="px-2.5 py-1 bg-black/20 hover:bg-black/30 text-[10px] font-black uppercase tracking-wider rounded-lg transition-all text-zinc-400">
                    Ignore
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Outside Copy Action -->
          <div v-if="msg.content && !msg.isPending"
            class="mt-[5px] opacity-0 group-hover/msg:opacity-100 transition-all duration-200 flex-shrink-0"
            :class="{ 'opacity-100': copiedId === msg.id }">
            <SlimTooltip :text="copiedId === msg.id ? 'Copied!' : 'Copy message'" placement="top">
              <button @click="copyMessage(msg.id, msg.content)"
                class="p-1.5 rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/10 text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                <svg v-if="copiedId !== msg.id" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z">
                  </path>
                </svg>
                <svg v-else class="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path>
                </svg>
              </button>
            </SlimTooltip>
          </div>
        </div>
      </div>
    </div>

    <!-- Input Section -->
    <BaseMessageInput v-if="data.hasInputInitially || showInput" v-model="input" v-model:attachedImages="attachedImages"
      v-model:autoUseImages="localAutoUseImages"
      :placeholder="data.hasInputInitially ? 'Ask a follow-up...' : 'Branch from here...'" compact submitIcon="IconSend"
      class="p-2 border-t border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] nodrag interactive-in-pan" @send="submit" />

    <RetryModal v-model="isRetryModalOpen" :message-id="currentRetryMessageId" @confirm="handleRetryConfirmed" />

    <Handle type="source" :position="Position.Bottom"
      class="w-3 h-3 bg-blue-500 border-2 border-white dark:border-zinc-800" />

    <!-- Edit Modal -->
    <Modal v-model="isModalOpen" title="Edit Message" size="xl" @close="cancelEdit">
      <!-- Suppress default trigger as we use custom triggers in parents -->
      <template #trigger><span class="hidden"></span></template>

      <template #default>
        <div class="flex flex-col gap-4 overflow-hidden">
          <div class="flex-1 overflow-hidden">
            <TextArea v-model="editText" placeholder="Edit message..."
              class="h-full font-sans text-base custom-textarea-full" />
          </div>
        </div>
      </template>

      <template #footer>
        <div class="flex justify-end gap-3 mt-2 flex-shrink-0">
          <Button outline @click="cancelEdit">Cancel</Button>
          <Button color="primary" @click="saveEdit">Save Changes</Button>
        </div>
      </template>
    </Modal>

    <!-- Full Screen Modal -->
    <Teleport to="body">
      <div v-if="isFullScreen"
        class="fixed inset-0 z-[9999] bg-black/95 flex flex-col items-center justify-center p-8 backdrop-blur-2xl animate-in fade-in duration-300"
        @click="isFullScreen = false">
        <button @click="isFullScreen = false"
          class="absolute top-8 right-8 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-all active:scale-90 z-50">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        </button>
        <img :src="fullScreenImageUrl"
          class="max-w-full max-h-full rounded-2xl shadow-2xl ring-1 ring-white/20 object-contain" @click.stop />
      </div>
    </Teleport>
  </div>
</template>
<script setup lang="ts">
import { fromMediaUrl, toMediaUrl } from '@shared/media-url'
import { ref, watch } from 'vue'
import { Handle, Position, useVueFlow } from '@vue-flow/core'
import { useVideoStore } from '../../stores/videoStore'
import { Button } from 'pilotui/elements'
import SlimTooltip from '../SlimTooltip.vue'
import { Modal } from 'pilotui/complex'
import { TextArea } from 'pilotui/form'
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
  const result = await (window as any).api.showConfirmation({
    title: 'Remove Message',
    message: 'Are you sure you want to remove this message from the conversation?',
    detail: 'This will delete the message and its artifacts. Subsequent messages in this node will be preserved.',
    type: 'warning',
    buttons: ['Cancel', 'Remove'],
    defaultId: 1,
    cancelId: 0
  })

  if (result.response === 1) {
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

.custom-scrollbar::-webkit-scrollbar-thumb:hover {
  background: rgba(128, 128, 128, 0.3);
}
</style>
