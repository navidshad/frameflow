<template>
	<header>
		<h1 class="m-0 font-heading font-bold text-[26px] tracking-tight">{{ title }}</h1>
		<p class="mt-2 text-sm leading-normal text-zinc-500 dark:text-zinc-400 max-w-[640px]">{{ description }}</p>
	</header>
</template>

<script setup lang="ts">
defineProps<{ title: string; description: string }>()
</script>
