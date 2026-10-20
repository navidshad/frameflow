<template>
	<AppDialog :model-value="store.shortcutsOpen" title="Keyboard shortcuts" size="xl"
		@update:model-value="store.shortcutsOpen = $event">
		<div class="grid grid-cols-1 sm:grid-cols-3 gap-x-9 gap-y-5">
			<div v-for="group in SHORTCUT_GROUPS" :key="group">
				<h3 class="lbl mb-1.5">{{ group }}</h3>
				<div v-for="s in shortcutsIn(group)" :key="s.id" class="flex items-baseline justify-between gap-3 py-[3px]">
					<span class="text-xs text-zinc-700 dark:text-zinc-300 min-w-0">{{ s.label }}</span>
					<span class="shrink-0 flex items-center gap-1.5 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
						<span v-for="part in parts(s.keys)" :key="part">{{ part }}</span>
					</span>
				</div>
			</div>
		</div>
		<p class="mt-4 text-[11px] text-zinc-500 leading-snug">
			Shortcuts are off while you are typing. Press <span class="font-mono">?</span> any time to bring this back.
		</p>

		<template #footer>
			<button class="btn-text" @click="store.shortcutsOpen = false">Close <span class="font-mono font-normal ml-1">Esc</span></button>
		</template>
	</AppDialog>
</template>

<script setup lang="ts">
import { useEditorStore } from '../../stores/editorStore'
import AppDialog from '../../components/AppDialog.vue'
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
