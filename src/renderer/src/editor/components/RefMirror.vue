<template>
	<!-- Same text as the field above it, invisible, with the references given a
	     chip's background: the field's own text then reads as sitting in chips. -->
	<div aria-hidden="true" class="absolute inset-0 overflow-hidden pointer-events-none">
		<div class="text-transparent" :class="single ? 'whitespace-pre' : 'whitespace-pre-wrap break-words'"
			:style="{ transform: `translate(${-(scrollLeft ?? 0)}px, ${-(scrollTop ?? 0)}px)` }">
			<template v-for="(seg, i) in segments" :key="i">
				<span v-if="seg.kind === 'ref'" class="rounded-[3px] bg-secondary/20 shadow-[0_0_0_2px] shadow-secondary/20">{{ seg.text }}</span>
				<template v-else>{{ seg.text }}</template>
			</template>
			<!-- A trailing newline needs something after it to take up its line. -->
			&#8203;
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { splitTimeRefs } from '@shared/promptRefs'

/**
 * Chips for @times in a plain text field. A textarea cannot hold elements, and
 * a contenteditable would bring its own caret, paste and undo bugs; drawing the
 * chip backgrounds behind a transparent field keeps typing exactly as it was.
 * The parent gives this the field's font, padding and scroll position.
 */
const props = defineProps<{ text: string; scrollTop?: number; scrollLeft?: number; single?: boolean }>()
const segments = computed(() => splitTimeRefs(props.text))
</script>
