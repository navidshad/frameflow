<template>
	<div v-if="store.promptAttachments.length || store.capturingFrame" class="mb-1.5 space-y-1.5" data-testid="attachment-tray">
		<!-- An engine that cannot see pictures says so; the frames are never sent without a word. -->
		<p v-if="!engine.current.images && store.promptAttachments.length"
			class="px-2 py-1 rounded-lg bg-amber-500/10 text-[10px] text-amber-600 dark:text-amber-400 leading-snug">
			{{ engine.current.label }} cannot be sent pictures. Remove the frames to send, or pick another engine.
		</p>
		<div v-for="a in store.promptAttachments" :key="a.id" class="flex items-start gap-2">
			<button class="relative shrink-0 w-16 rounded overflow-hidden hair group" :style="{ aspectRatio: `${a.width} / ${a.height}` }"
				title="Draw on this frame" data-testid="attachment-thumb" @click="editing = a.id">
				<img :src="a.thumbnail" alt="" class="w-full h-full object-cover" />
				<span class="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition">
					<span class="iconify tabler--pencil w-3.5 h-3.5 text-white"></span>
				</span>
				<span v-if="a.marks.length" class="absolute bottom-0.5 right-0.5 w-3 h-3 rounded-full bg-red-500 flex items-center justify-center"
					title="Marked up">
					<span class="iconify tabler--pencil w-2 h-2 text-white"></span>
				</span>
			</button>
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-1.5">
					<button class="font-mono text-[10px] font-bold text-secondary hover:underline" :title="'Move the playhead to this frame'"
						@click="store.seekTo(a.timeSec)">
						{{ formatTimecode(a.timeSec) }}
					</button>
					<span class="text-[9px] uppercase tracking-widest text-zinc-400 font-bold">Frame</span>
					<div class="flex-1"></div>
					<button class="w-4 h-4 flex items-center justify-center text-zinc-400 hover:text-red-500 transition"
						:aria-label="`Remove the frame at ${formatTimecode(a.timeSec)}`" data-testid="attachment-remove"
						@click="store.removePromptAttachment(a.id)">
						<span class="iconify tabler--x w-3 h-3"></span>
					</button>
				</div>
				<input :value="a.note" type="text" maxlength="500" placeholder="Note on this frame (optional)"
					class="w-full h-5 bg-transparent border-0 border-b border-b-[color:var(--ff-hairline)] focus:border-b-primary outline-none text-[11px] text-zinc-700 dark:text-zinc-300 placeholder-zinc-400"
					data-testid="attachment-note"
					@input="store.updatePromptAttachment(a.id, { note: ($event.target as HTMLInputElement).value })"
					@keydown.enter.prevent="$emit('submit')" />
			</div>
		</div>
		<div v-if="store.capturingFrame" class="flex items-center gap-2 px-1 text-[10px] text-zinc-500">
			<span class="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin"></span>
			Capturing the frame at {{ formatTimecode(store.playheadSec) }}…
		</div>
		<FrameMarkup v-if="editingAttachment" :attachment="editingAttachment" @close="editing = null" />
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatTimecode } from '@shared/promptRefs'
import { useEditorStore } from '../../stores/editorStore'
import { useEngineStore } from '../../stores/engineStore'
import FrameMarkup from './FrameMarkup.vue'

/**
 * The frames attached to the draft: each with its time, a note the person
 * types, and a way to draw on it. Enter in a note sends, as in the prompt.
 */
defineEmits<{ (e: 'submit'): void }>()
const store = useEditorStore()
const engine = useEngineStore()
const editing = ref<string | null>(null)
const editingAttachment = computed(() => store.promptAttachments.find((a) => a.id === editing.value) ?? null)
</script>
