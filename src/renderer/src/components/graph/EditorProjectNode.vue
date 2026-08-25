<template>
  <div class="glass-card glass-card-hover p-0 rounded-3xl min-w-[280px] max-w-[320px] overflow-hidden flex flex-col group cursor-move">
    <Handle type="target" :position="Position.Top" class="w-3 h-3 bg-zinc-500 border-2 border-white dark:border-zinc-800" />

    <!-- Poster / placeholder -->
    <div class="relative aspect-video bg-zinc-900 overflow-hidden group/player">
      <div class="absolute top-2 right-2 flex flex-col gap-2 z-20 opacity-0 group-hover/player:opacity-100 transition-opacity">
        <SlimTooltip key="delete" text="Delete node" placement="left">
          <button @click="data.onDelete" class="p-1.5 bg-black/50 backdrop-blur-md rounded-lg hover:bg-red-500/80 text-white transition-all shadow-lg">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
          </button>
        </SlimTooltip>
      </div>

      <img v-if="posterUrl" :src="posterUrl" class="w-full h-full object-cover opacity-80" />
      <div v-else class="w-full h-full flex items-center justify-center">
        <span class="iconify tabler--timeline w-10 h-10 text-zinc-600"></span>
      </div>

      <!-- Missing project -->
      <div v-if="missing" class="absolute inset-0 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center gap-2 text-center px-4">
        <span class="iconify tabler--alert-triangle w-6 h-6 text-amber-400"></span>
        <p class="text-[11px] font-bold text-white">This editor project was deleted</p>
      </div>
    </div>

    <!-- Info strip -->
    <div class="px-4 py-2.5 bg-zinc-50/50 dark:bg-white/[0.02] border-b border-black/5 dark:border-white/5 flex items-center gap-3 cursor-move">
      <div v-if="data.version" class="text-[10px] font-bold text-primary dark:text-primary-light font-mono leading-none">
        {{ data.version }}
      </div>
      <div v-if="data.version" class="w-px h-3 bg-black/10 dark:bg-white/10"></div>
      <div class="text-[9px] font-black uppercase tracking-[0.15em] text-zinc-500 dark:text-zinc-400 leading-none">
        Manual Edit
      </div>
      <div v-if="summary" class="w-px h-3 bg-black/10 dark:bg-white/10"></div>
      <div v-if="summary" class="text-[9px] font-black uppercase tracking-widest text-accent dark:text-accent-light leading-none">
        {{ summary.label }}
      </div>
    </div>

    <!-- Body -->
    <div class="px-4 py-3 space-y-3">
      <div class="min-w-0">
        <p class="text-[13px] font-bold text-zinc-800 dark:text-zinc-100 truncate">
          {{ summary?.title || 'Timeline project' }}
        </p>
        <p class="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
          {{ missing ? 'No longer available' : (summary?.mediaName || 'Loading…') }}
          <template v-if="summary?.duration"> · {{ formatDuration(summary.duration) }}</template>
        </p>
      </div>

      <button
        v-if="!missing"
        @click="open"
        class="w-full py-2 rounded-xl bg-primary text-white text-xs font-bold shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-[0.98] flex items-center justify-center gap-1.5 nodrag">
        <span class="iconify tabler--timeline w-3.5 h-3.5"></span>
        Open Editor
      </button>
      <button
        v-else
        @click="refork"
        :disabled="busy"
        class="w-full py-2 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 text-xs font-bold hover:bg-zinc-200 dark:hover:bg-zinc-700 transition active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-1.5 nodrag">
        <span class="iconify tabler--refresh w-3.5 h-3.5"></span>
        {{ busy ? 'Re-creating…' : 'Re-create project' }}
      </button>
    </div>

    <BaseMessageInput
      v-model="input"
      v-model:attachedImages="attachedImages"
      placeholder="Adjust or follow up..."
      compact
      class="p-2 border-t border-black/5 dark:border-white/5 bg-black/[0.02] dark:bg-white/[0.02] nodrag interactive-in-pan"
      @send="submit"
    />

    <Handle type="source" :position="Position.Bottom" class="w-3 h-3 bg-blue-500 border-2 border-white dark:border-zinc-800" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useRouter } from 'vue-router'
import SlimTooltip from '../SlimTooltip.vue'
import BaseMessageInput from '../chat/BaseMessageInput.vue'
import { useOpenInEditor } from '../../composables/useOpenInEditor'

const props = defineProps<{ data: any }>()
const router = useRouter()
const { openInEditor, busy } = useOpenInEditor()

const input = ref('')
const attachedImages = ref<string[]>([])
const missing = ref(false)
const posterUrl = ref<string | undefined>(undefined)
const summary = ref<{
  title: string; mediaName?: string; label: string; duration: number
} | null>(null)

/**
 * The node owns its own freshness rather than having useGraphLayout fetch it —
 * syncGraph must stay a pure function of thread.messages + nodePositions.
 */
const loadSummary = async () => {
  const id = props.data.editorThreadId
  if (!id) { missing.value = true; return }

  const thread = await (window as any).api.getThread(id)
  if (!thread?.editor) { missing.value = true; summary.value = null; return }

  missing.value = false
  const doc = thread.editor
  const asset = doc.media?.[0]
  const items = doc.timeline?.length || 0
  const pieces = asset?.clips?.length || 0
  summary.value = {
    title: thread.title,
    mediaName: asset?.name,
    // A root-media fork has an empty timeline on purpose; reporting "0 clips"
    // next to a tray of 266 pieces reads as broken. Say what's actually there.
    label: items
      ? `${items} ${items === 1 ? 'clip' : 'clips'}`
      : (pieces ? `${pieces} pieces ready` : 'Empty timeline'),
    duration: doc.timelineMeta?.duration || 0
  }

  // Poster: the thumbnail of whatever clip the first timeline item points at.
  const first = doc.timeline?.[0]
  const clip = first?.sourceClipId
    ? asset?.clips?.find((c: any) => c.id === first.sourceClipId)
    : asset?.clips?.[0]
  posterUrl.value = clip?.thumbnailPath ? `media://${clip.thumbnailPath}` : undefined
}

// Unlike the singleton editor store, a per-node component must clean up after
// itself — the graph mounts and unmounts these freely.
let unsubscribe: (() => void) | null = null

onMounted(async () => {
  await loadSummary()
  unsubscribe = (window as any).api.onThreadUpdated((thread: any) => {
    if (thread?.id === props.data.editorThreadId) loadSummary()
  })
})

onUnmounted(() => unsubscribe?.())

watch(() => props.data.editorThreadId, loadSummary)

const open = () => {
  if (props.data.editorThreadId) router.push(`/editor/${props.data.editorThreadId}`)
}

/** The project was deleted — fork it again from the same source node. */
const refork = async () => {
  const sourceNodeId = props.data.editRefId || 'root-media'
  await openInEditor(sourceNodeId)
}

const submit = (text: string, images: string[], count: number, isThinkingMode: boolean, autoUseImages: boolean) => {
  if ((text.trim() || images.length > 0) && props.data.onSubmit) {
    props.data.onSubmit(text, images, count, isThinkingMode, autoUseImages)
    input.value = ''
    attachedImages.value = []
  }
}

const formatDuration = (seconds: number) => {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
</script>
