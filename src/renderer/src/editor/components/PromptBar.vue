<template>
	<div
		class="shrink-0 rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-950/20 backdrop-blur-xl shadow-lg px-4 py-3 flex items-center gap-3 opacity-70">
		<!-- Persona chip (placeholder) -->
		<div
			class="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
			<span class="iconify tabler--user-star w-3.5 h-3.5 text-zinc-400"></span>
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Persona</span>
		</div>

		<p class="flex-1 text-xs text-zinc-400 select-none">
			Ask an editor persona to build or refine your cut — AI editing arrives in M3.
		</p>

		<button disabled
			class="shrink-0 w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-800 text-zinc-400 flex items-center justify-center cursor-not-allowed">
			<span class="iconify tabler--send w-3.5 h-3.5"></span>
		</button>
	</div>
</template>
