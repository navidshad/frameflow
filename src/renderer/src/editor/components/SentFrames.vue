<template>
	<div class="max-w-[85%] flex flex-col items-end gap-1.5" data-testid="sent-frames">
		<div v-for="a in attachments" :key="a.id" class="flex items-start gap-2 justify-end">
			<p v-if="a.note" class="max-w-[12rem] text-[11px] text-zinc-600 dark:text-zinc-300 leading-snug text-right pt-0.5">
				{{ a.note }}
			</p>
			<button class="relative shrink-0 w-20 rounded-lg overflow-hidden hair" :title="`Move the playhead to ${formatTimecode(a.timeSec)}`"
				@click="store.seekTo(a.timeSec)">
				<img v-if="a.thumbnail" :src="a.thumbnail" alt="" class="block w-full" />
				<span class="absolute left-1 bottom-1 px-1 rounded bg-black/60 text-white font-mono text-[9px]">
					{{ formatTimecode(a.timeSec) }}
				</span>
				<span v-if="a.marked" class="absolute top-1 right-1 w-3 h-3 rounded-full bg-red-500 flex items-center justify-center" title="Marked up">
					<span class="iconify tabler--pencil w-2 h-2 text-white"></span>
				</span>
			</button>
		</div>
	</div>
</template>

<script setup lang="ts">
import { formatTimecode } from '@shared/promptRefs'
import type { PromptAttachment } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'

/** The frames a sent message carried, each with the note it was sent with. */
defineProps<{ attachments: PromptAttachment[] }>()
const store = useEditorStore()
</script>
