<template>
	<span>
		<template v-for="(seg, i) in segments" :key="i">
			<button v-if="seg.kind === 'ref'" type="button"
				class="inline-flex items-center gap-0.5 px-1 rounded bg-white/20 hover:bg-white/30 font-mono text-[11px] align-baseline transition"
				:title="`Move the playhead to ${seg.text.slice(1)}`" @click="store.seekTo(seg.sec)">
				<span class="iconify tabler--clock w-2.5 h-2.5"></span>{{ seg.text.slice(1) }}
			</button>
			<template v-else>{{ seg.text }}</template>
		</template>
	</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { splitTimeRefs } from '@shared/promptRefs'
import { useEditorStore } from '../../stores/editorStore'

/** A sent message with its @times as chips; a chip moves the playhead there. */
const props = defineProps<{ text: string }>()
const store = useEditorStore()
const segments = computed(() => splitTimeRefs(props.text))
</script>
