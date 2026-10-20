<template>
	<Transition name="fade">
		<div v-if="store.shortcutsOpen"
			class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6"
			@click.self="store.shortcutsOpen = false">
			<div class="pop w-full max-w-3xl max-h-full overflow-hidden flex flex-col
			            border border-zinc-200 dark:border-zinc-800 shadow-2xl">
				<div class="px-5 pt-4 pb-3 flex items-center justify-between shrink-0">
					<h2 class="text-sm font-bold text-zinc-800 dark:text-zinc-100 font-heading">
						Keyboard shortcuts
					</h2>
					<button
						class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400
						       hover:text-primary hover:bg-primary/10 transition active:scale-95"
						title="Close (Esc)"
						@click="store.shortcutsOpen = false">
						<span class="iconify tabler--x w-4 h-4"></span>
					</button>
				</div>

				<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 pb-5">
					<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
						<div v-for="group in SHORTCUT_GROUPS" :key="group">
							<h3 class="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1.5">
								{{ group }}
							</h3>
							<div v-for="s in shortcutsIn(group)" :key="s.id"
								class="flex items-baseline justify-between gap-3 py-1 border-b
								       border-zinc-100 dark:border-zinc-800/60 last:border-0">
								<span class="text-[11px] text-zinc-600 dark:text-zinc-300 min-w-0">{{ s.label }}</span>
								<span class="shrink-0 flex items-center gap-1">
									<kbd v-for="part in parts(s.keys)" :key="part"
										class="px-1.5 py-0.5 rounded-md text-[10px] font-mono
										       bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300
										       border border-zinc-200 dark:border-zinc-700">{{ part }}</kbd>
								</span>
							</div>
						</div>
					</div>
					<p class="mt-5 text-[10px] text-zinc-400 leading-snug">
						Shortcuts are off while you are typing. Press
						<kbd class="px-1 py-0.5 rounded font-mono bg-zinc-100 dark:bg-zinc-800">?</kbd>
						any time to bring this back.
					</p>
				</div>
			</div>
		</div>
	</Transition>
</template>

<script setup lang="ts">
import { useEditorStore } from '../../stores/editorStore'
import { SHORTCUT_GROUPS, shortcutsIn } from '../shortcuts'

/**
 * The shortcut list, generated from the same table the handler reads.
 *
 * Not hand-written on purpose: a shortcuts dialog that is maintained separately
 * from the keys it describes is wrong within a month, and a wrong one is worse
 * than none.
 */

const store = useEditorStore()

/**
 * Split "Shift + ← / →" into the chips a reader expects.
 *
 * A lone `+` IS a key — the zoom one — so a naive split leaves two empty chips
 * where the plus should be.
 */
const parts = (keys: string) => {
	const split = keys.split('+').map((p) => p.trim()).filter(Boolean)
	return split.length ? split : [keys]
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active { transition: opacity 0.12s ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }
</style>
