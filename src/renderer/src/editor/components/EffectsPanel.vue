<template>
	<div class="flex flex-col min-h-0 overflow-hidden">
		<div class="px-3 pt-3 pb-1 flex items-center shrink-0">
			<span class="lbl">Effects <span class="font-mono normal-case tracking-normal font-normal text-zinc-400 ml-1">{{ total }}</span></span>
		</div>

		<!-- Nothing to drop onto: say so rather than offering a dead drag -->
		<div v-if="!clipCount" class="px-4 pb-3 shrink-0">
			<p class="text-[10px] leading-snug text-zinc-400">
				Put a clip on a track, then drag an effect onto it.
			</p>
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 pb-3">
			<template v-for="group in groups" :key="group.group">
				<div class="px-1 pt-2 pb-1.5 flex items-baseline gap-1.5">
					<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400">{{ group.group }}</span>
					<span v-if="group.effects[0]?.stream === 'audio'"
						class="text-[8px] font-mono uppercase tracking-widest text-emerald-500/70">sound</span>
				</div>
				<div class="grid grid-cols-2 gap-1.5">
					<button v-for="def in group.effects" :key="def.kind"
						:data-effect="def.kind"
						class="group flex flex-col items-start gap-1 p-2 rounded-xl border text-left transition active:scale-95"
						:class="def.kind === store.draggingEffectKind
							? 'border-primary bg-primary/10'
							: 'border-zinc-200/70 dark:border-zinc-700/70 hover:border-primary/40 hover:bg-primary/5'"
						draggable="true"
						:title="`${def.label} — ${def.description} Drag onto a clip, or press Enter to add to the selection.`"
						@dragstart="onDragStart(def, $event)"
						@dragend="store.draggingEffectKind = null"
						@keydown.enter.prevent="addToSelection(def)">
						<span class="w-4 h-4 rounded-md flex items-center justify-center"
							:class="SWATCH[def.group] || 'bg-primary/20'">
							<span class="iconify w-2.5 h-2.5 text-white/80" :class="ICON[def.group] || 'tabler--wand'"></span>
						</span>
						<span class="text-[10px] font-semibold text-zinc-700 dark:text-zinc-200 leading-tight">
							{{ def.label }}
						</span>
					</button>
				</div>
			</template>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useEditorStore } from '../../stores/editorStore'
import { allEffects, effectGroups, type EffectDef } from '@shared/effects'
import SlimTooltip from '../../components/SlimTooltip.vue'

/**
 * The effect library, deliberately a near-copy of LibraryPanel: the two are
 * the same gesture aimed at different targets — a transition lands on a cut,
 * an effect lands on a clip — and making them look and behave alike is worth
 * more than sharing the markup.
 */

defineProps<{ collapsed?: boolean }>()
defineEmits<{ (e: 'update:collapsed', value: boolean): void }>()

const store = useEditorStore()

onMounted(() => { void store.loadEffectPacks() })

// Both streams in one list: a clip carries picture and sound together, so
// splitting the library by stream would only make the user think about which
// tab a control lives in. The group heading says which is which.
// `effectsVersion` is the dependency, not the value: the catalogue lives in a
// module-level registry Vue cannot see into, so this is what re-renders the
// list once packs have registered.
const groups = computed(() => (store.effectsVersion, effectGroups()))
const total = computed(() => (store.effectsVersion, allEffects().length))
const clipCount = computed(() => store.doc?.timeline.length ?? 0)

const SWATCH: Record<string, string> = {
	Adjust: 'bg-primary/70',
	Looks: 'bg-secondary/70',
	Detail: 'bg-accent/70',
	Repair: 'bg-emerald-500/70'
}
const ICON: Record<string, string> = {
	Adjust: 'tabler--adjustments',
	Looks: 'tabler--palette',
	Detail: 'tabler--focus-2',
	Repair: 'tabler--wave-sine'
}

const onDragStart = (def: EffectDef, event: DragEvent) => {
	if (!event.dataTransfer) return
	event.dataTransfer.setData('application/x-frameflow-effect', def.kind)
	// Kind hint, readable during dragover unlike the payload, so a clip can
	// light up before the drop — the same trick transitions and clips use.
	event.dataTransfer.setData('application/x-frameflow-kind-effect', '1')
	event.dataTransfer.effectAllowed = 'copy'
	store.draggingEffectKind = def.kind
}

/** Keyboard path, mirroring the transition library's Enter-to-place. */
const addToSelection = (def: EffectDef) => {
	for (const id of store.selectedItemIds) store.addEffect(id, def.kind)
}
</script>
