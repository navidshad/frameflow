<template>
	<!-- One settings section: title and description on the left, the controls on
	     the right, a hairline between sections. -->
	<section class="flex gap-12 py-7 hair-t first:border-t-0 max-md:flex-col max-md:gap-4">
		<div class="w-[230px] shrink-0 max-md:w-auto">
			<h2 class="font-heading font-semibold text-base tracking-tight flex items-center gap-2">
				{{ title }}
				<span v-if="badge" class="text-[9px] font-bold uppercase tracking-wide text-accent">{{ badge }}</span>
			</h2>
			<p v-if="description" class="mt-1.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{{ description }}</p>
			<slot name="aside" />
		</div>
		<div class="flex-1 min-w-0 text-xs">
			<slot />
		</div>
	</section>
</template>

<script setup lang="ts">
defineProps<{
	title: string
	description?: string
	badge?: string
}>()
</script>
