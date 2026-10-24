<template>
	<!-- One setting: what it is on the left, the control on the right. -->
	<div class="grid grid-cols-[minmax(0,1fr)_300px] gap-8 py-4 hair-b max-md:grid-cols-1 max-md:gap-3"
		:class="top ? 'items-start' : 'items-center'">
		<div class="min-w-0">
			<div class="font-semibold text-[13px] flex items-center gap-2">{{ title }}<slot name="badge" /></div>
			<div v-if="description" class="text-xs leading-normal text-zinc-500 dark:text-zinc-400 mt-[3px]">{{ description }}</div>
			<slot name="aside" />
		</div>
		<div class="min-w-0"><slot /></div>
	</div>
</template>

<script setup lang="ts">
defineProps<{ title: string; description?: string; top?: boolean }>()
</script>
