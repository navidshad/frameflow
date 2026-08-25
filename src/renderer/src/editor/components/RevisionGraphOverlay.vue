<template>
	<!-- size="lg" is max-w-5xl (1024px). NOT "xl", which is max-w-xl (576px) —
	     pilotui's scale is inverted at the top end, and that inversion is why
	     this graph used to feel cramped. -->
	<Modal :model-value="modelValue" title="Revision graph" size="lg"
		:custom-class="{ panel: '!h-[82vh] flex flex-col' }"
		content-class="!p-0 flex-1 min-h-0"
		@update:model-value="$emit('update:modelValue', $event)">
		<div class="w-full h-full rounded-b-xl overflow-hidden border-t border-zinc-200 dark:border-zinc-800">
			<RevisionGraph />
		</div>
	</Modal>
</template>

<script setup lang="ts">
import { Modal } from 'pilotui/complex'
import RevisionGraph from './RevisionGraph.vue'

defineProps<{ modelValue: boolean }>()
defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()
</script>
