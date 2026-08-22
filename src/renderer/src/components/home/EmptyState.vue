<template>
	<div class="flex flex-col items-center justify-center py-20 text-center">
		<div class="w-24 h-24 rounded-lg bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center mb-6">
			<svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-zinc-400" viewBox="0 0 24 24" fill="none"
				stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
				<polyline points="17 8 12 3 7 8" />
				<line x1="12" y1="3" x2="12" y2="15" />
			</svg>
		</div>
		<h3 class="text-xl font-bold text-zinc-900 dark:text-white mb-2">No videos yet</h3>
		<p class="text-zinc-500 dark:text-zinc-400 max-w-md mx-auto">
			Pick how you want to start below — summarize and chat with a video, build an
			image edit, or cut clips on the timeline in the video editor.
		</p>
	</div>
</template>

<script setup lang="ts">
// Intro copy only: the ways to start are the cards rendered directly below it,
// so the empty state can never offer a different set of actions than the grid.
</script>
