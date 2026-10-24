<template>
	<!-- A titled block of rows inside a section: label, hairline, optional action on the right. -->
	<section class="mt-9 first:mt-7">
		<div class="flex items-baseline gap-3 pb-2.5 hair-y-strong !border-t-0">
			<h2 class="lbl !text-zinc-900 dark:!text-zinc-50 m-0">{{ title }}</h2>
			<div class="flex-1"></div>
			<slot name="action" />
		</div>
		<slot />
	</section>
</template>

<script setup lang="ts">
defineProps<{ title: string }>()
</script>
