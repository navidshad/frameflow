<template>
  <div class="h-full group" :class="isLegacy ? 'cursor-default' : 'cursor-pointer'"
    @click="!isLegacy && $emit('open', thread.id)">
    <Card
      class="h-full dark:!bg-zinc-900 dark:!border-zinc-800/50 !shadow-sm hover:!shadow-md"
    >
      <div class="p-6 flex flex-col h-full relative z-10">
        <div class="flex items-start justify-between mb-6">
          <div class="w-12 h-12 rounded-lg bg-primary/10 text-primary p-3 flex items-center justify-center">
            <span class="iconify w-full h-full" :class="kind.icon"></span>
          </div>

          <div class="flex items-center gap-2">
            <!-- Without this the only way to tell a timeline project from a
                 video project in a mixed list is to click it. -->
            <div
              v-if="isLegacy"
              class="text-[10px] font-bold uppercase tracking-widest text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-1 rounded-lg"
              title="Made by the retired AI video pipeline. Video editing now happens in a timeline project."
            >
              Unsupported
            </div>
            <div
              v-else
              class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded-lg"
            >
              {{ kind.label }}
            </div>
            <div
              class="text-[10px] font-bold uppercase tracking-widest text-zinc-400/80 bg-zinc-50 dark:bg-zinc-800/50 px-2 py-1 rounded-lg"
            >
              {{ formatDate(thread.updatedAt) }}
            </div>
          </div>
        </div>

        <h3
          class="font-heading font-bold text-xl text-zinc-900 dark:text-white mb-3 line-clamp-2 group-hover:text-primary transition-colors leading-tight"
        >
          {{ thread.title }}
        </h3>

        <p
          class="text-sm text-zinc-500 dark:text-zinc-400 line-clamp-2 flex-grow leading-relaxed"
        >
          {{ getLastMessage(thread) }}
        </p>

        <div
          class="mt-6 pt-5 border-t border-zinc-50 dark:border-zinc-800/50 flex items-center flex-wrap gap-2 text-[10px] text-zinc-500 dark:text-zinc-400"
        >
          <div
            class="flex items-center bg-zinc-50 dark:bg-zinc-800/30 px-2.5 py-1.5 rounded-lg border border-zinc-100 dark:border-zinc-800/50 transition-colors group-hover:border-zinc-200 dark:group-hover:border-zinc-700"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="w-3.5 h-3.5 mr-1.5 opacity-70"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
              />
            </svg>
            <span class="font-bold">{{ thread.messages.length }}</span>
          </div>

          <div
            v-if="thread.versionCounter && thread.type !== 'editor'"
            class="flex items-center bg-blue-50/50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2.5 py-1.5 rounded-lg border border-blue-100/50 dark:border-blue-500/20"
          >
            <span class="font-bold uppercase tracking-wider text-[9px]"
              >v.{{ thread.versionCounter }}</span
            >
          </div>

		  <div
            class="flex items-center bg-zinc-100/50 dark:bg-zinc-800/50 text-zinc-900 dark:text-zinc-100 px-2.5 py-1.5 rounded-lg border border-blue-100/50 dark:border-blue-500/20"
          >
            <span class="font-bold uppercase tracking-wider text-[9px]"
              >${{ getThreadTotals(thread).cost.toFixed(4) }}</span
            >
          </div>

          <!-- Missing Artifacts Badge -->
          <div
            v-if="thread.missing"
            class="flex items-center bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 px-2.5 py-1.5 rounded-lg border border-red-100 dark:border-red-500/20"
            title="Artifacts folder not found. Some media or generated files may be unavailable."
          >
            <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span class="font-bold uppercase tracking-wider text-[9px]">Missing Files</span>
          </div>

          <div class="flex-grow"></div>

          <button
            @click.stop="$emit('delete', thread.id)"
            class="p-2.5 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-fade opacity-0 group-hover:opacity-100 duration-500"
            title="Delete Thread"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              class="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
    </Card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Card } from 'pilotui/elements'
import { isLegacyVideoThread } from '@shared/legacy'

const props = defineProps<{
  thread: any
}>()

defineEmits(['open', 'delete'])

/** Threads written before `type` existed read back undefined — those are video. */
const KINDS = {
  video: { label: 'Video', icon: 'tabler--movie' },
  image: { label: 'Images', icon: 'tabler--photo' },
  editor: { label: 'Timeline', icon: 'tabler--timeline' }
} as const

const kind = computed(() => KINDS[props.thread.type as keyof typeof KINDS] || KINDS.video)

/** Retired AI-video threads: listed and deletable, but not openable. */
const isLegacy = computed(() => isLegacyVideoThread(props.thread))

const formatDate = (timestamp: number) => {
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const getLastMessage = (thread: any) => {
  if (thread.messages.length === 0) return 'No messages yet'
  const lastMsg = thread.messages[thread.messages.length - 1]
  return lastMsg.content
}

const getThreadTotals = (thread: any) => {
  return thread.messages.reduce(
    (acc: { tokens: number; cost: number }, msg: any) => {
      acc.tokens += msg.usage?.totalTokens || 0
      acc.cost += msg.cost || 0
      return acc
    },
    { tokens: 0, cost: 0 }
  )
}
</script>
