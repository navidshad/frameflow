<template>
	<div class="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">
		Used by {{ count }} steps ·
		<button type="button" class="font-semibold text-primary hover:text-primary-dark dark:hover:text-primary-light"
			:aria-expanded="open" @click="$emit('toggle')">{{ open ? 'Use one model' : 'Choose per step' }}</button>
	</div>
</template>

<script setup lang="ts">
defineProps<{ count: number; open: boolean }>()
defineEmits<{ toggle: [] }>()
</script>
