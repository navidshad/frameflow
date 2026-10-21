<template>
	<div class="flex flex-col min-h-0 overflow-hidden">
		<div class="px-3 pt-3 pb-1 flex items-center shrink-0">
			<span class="lbl">Transitions <span class="font-mono normal-case tracking-normal font-normal text-zinc-400 ml-1">{{ TRANSITION_PRESETS.length }}</span></span>
		</div>

		<!-- No cuts to drop onto: say so rather than offering a dead drag -->
		<div v-if="seamCount === 0" class="px-4 pb-3 shrink-0">
			<p class="text-[10px] leading-snug text-zinc-400">
				Put two clips next to each other on a video track, then drag a transition onto the cut between them.
			</p>
		</div>

		<!-- Preset groups -->
		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 pb-3">
			<template v-for="group in groups" :key="group.group">
				<div class="px-1 pt-2 pb-1.5">
					<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400">{{ group.label }}</span>
				</div>
				<div class="grid grid-cols-2 gap-1.5">
					<button v-for="preset in group.presets" :key="preset.kind"
						class="group flex flex-col items-start gap-1 p-2 rounded-xl border text-left transition active:scale-95"
						:class="preset.kind === store.draggingTransitionKind
							? 'border-primary bg-primary/10'
							: 'border-zinc-200/70 dark:border-zinc-700/70 hover:border-primary/40 hover:bg-primary/5'"
						draggable="true"
						:title="`${preset.label} — drag onto a cut, or press Enter to apply at the playhead`"
						@dragstart="onDragStart(preset, $event)"
						@dragend="store.draggingTransitionKind = null"
						@keydown.enter.prevent="applyAtPlayhead(preset)">
						<span class="w-6 h-6 rounded-lg bg-secondary/10 text-secondary flex items-center justify-center shrink-0">
							<span class="iconify w-3.5 h-3.5" :class="`tabler--${preset.icon}`"></span>
						</span>
						<span class="text-[10px] font-semibold leading-tight text-zinc-700 dark:text-zinc-300">
							{{ preset.label }}
						</span>
					</button>
				</div>
			</template>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import { DEFAULT_TRANSITION_SEC } from '@shared/transitionPlan'
import { TRANSITION_PRESETS, transitionGroups, type TransitionPreset } from '@shared/transitionPresets'
import SlimTooltip from '../../components/SlimTooltip.vue'

defineProps<{ collapsed?: boolean }>()
defineEmits<{ (e: 'update:collapsed', value: boolean): void }>()

const store = useEditorStore()
const groups = computed(() => transitionGroups())
const seamCount = computed(() => store.seams.length)

/** How far from the playhead the keyboard path will reach for a cut. */
const KEYBOARD_REACH_SEC = 2

const onDragStart = (preset: TransitionPreset, event: DragEvent) => {
	if (!event.dataTransfer) return
	event.dataTransfer.setData('application/x-frameflow-transition', preset.kind)
	// Kind hint (readable during dragover, unlike the payload) so a seam can light
	// up before the drop — the same trick ClipTile uses for clips.
	event.dataTransfer.setData('application/x-frameflow-kind-transition', '1')
	event.dataTransfer.effectAllowed = 'copy'
	store.draggingTransitionKind = preset.kind
}

/** Keyboard-only path, mirroring ClipTile's Enter-to-place. */
const applyAtPlayhead = (preset: TransitionPreset) => {
	const seam = store.seamNear(store.playheadSec, KEYBOARD_REACH_SEC)
	if (seam) store.setTransition(seam.junction.outgoing.id, preset.kind, DEFAULT_TRANSITION_SEC)
}
</script>
