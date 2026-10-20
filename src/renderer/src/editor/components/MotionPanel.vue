<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<!-- Panel header -->
		<div class="px-4 pt-4 pb-2 flex items-center justify-between shrink-0">
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
				Motion
				<span class="text-zinc-400 normal-case tracking-normal font-mono font-normal ml-1">{{ MOTION_TEMPLATES.length }}</span>
			</span>
			<SlimTooltip text="Collapse panel" placement="bottom">
				<button
					class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-400 hover:text-primary hover:bg-primary/10 transition active:scale-95"
					@click="$emit('update:collapsed', true)">
					<span class="iconify tabler--layout-sidebar-left-collapse w-4 h-4"></span>
				</button>
			</SlimTooltip>
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 pb-3">
			<template v-for="(group, g) in sections" :key="group.section">
				<div class="px-1 pb-1.5" :class="g === 0 ? 'pt-2' : 'pt-3'">
					<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400">{{ group.section }}</span>
				</div>
				<div class="grid grid-cols-2 gap-1.5">
					<button v-for="template in group.templates" :key="template.id"
						class="motion-tile flex flex-col items-start gap-1.5 p-2 rounded-xl border text-left transition active:scale-95 cursor-grab"
						:class="template.id === activeTemplateId
							? 'border-primary bg-primary/10'
							: 'border-zinc-200/70 dark:border-zinc-700/70 hover:border-primary/40 hover:bg-primary/5'"
						draggable="true"
						:data-motion-template="template.id"
						:title="`${template.label} — ${template.description} Drag onto the timeline, or double-click to add it at the playhead.`"
						@dragstart="onDragStart(template.id, $event)"
						@dragend="store.draggingMotionTemplate = null"
						@dblclick="store.addMotionLayer(template.id)"
						@keydown.enter.prevent="store.addMotionLayer(template.id)">
						<!-- The tile previews are drawn, not rendered: a still of
						     each page would cost an iframe per tile, and these
						     say what the template is at a glance. -->
						<div class="w-full h-11 rounded-lg bg-zinc-900 relative overflow-hidden" aria-hidden="true">
							<template v-if="template.id === 'lower-third'">
								<div class="absolute left-2 bottom-2 w-[46px] h-3.5 bg-zinc-50 border-l-[3px] border-pink-500"></div>
								<div class="absolute left-[11px] bottom-1 w-[30px] h-[3px] bg-pink-500"></div>
							</template>
							<div v-else-if="template.id === 'title-card'" class="w-full h-full flex items-center justify-center">
								<div class="font-heading font-black text-[13px] text-zinc-50">TITLE</div>
							</div>
							<div v-else-if="template.id === 'chapter-card'" class="w-full h-full flex items-center pl-2 gap-1.5">
								<div class="w-[3px] h-[26px] bg-pink-500"></div>
								<div class="flex flex-col gap-[3px]">
									<div class="w-[22px] h-[3px] bg-zinc-500"></div>
									<div class="w-[44px] h-1.5 bg-zinc-50"></div>
								</div>
							</div>
							<div v-else-if="template.id === 'pull-quote'"
								class="w-full h-full flex items-center justify-center italic text-[11px] text-zinc-300"
								style="font-family: Georgia, serif">“Quote”</div>
							<div v-else-if="template.id === 'stat-counter'" class="w-full h-full flex items-center justify-center gap-1">
								<span class="font-heading font-black text-[18px] text-zinc-50">3×</span>
								<span class="text-[7px] leading-[1.2] text-zinc-400 w-7">faster triage</span>
							</div>
							<template v-else-if="template.id === 'callout-ring'">
								<div class="absolute left-[30px] top-2.5 w-[22px] h-[22px] border-2 border-pink-500 rounded-full"></div>
								<div class="absolute left-2.5 top-7 w-[18px] h-0.5 bg-pink-500 -rotate-[35deg]"></div>
							</template>
							<div v-else-if="template.id === 'bar-reveal'" class="w-full h-full flex items-end gap-[3px] px-2.5 py-2">
								<div class="w-2 h-2.5 bg-zinc-600"></div>
								<div class="w-2 h-[18px] bg-zinc-500"></div>
								<div class="w-2 h-[26px] bg-pink-500"></div>
							</div>
						</div>
						<span class="text-[10px] font-semibold leading-tight text-zinc-700 dark:text-zinc-300">{{ template.label }}</span>
						<span class="font-mono text-[8px] text-zinc-500 -mt-1">
							{{ template.id === activeTemplateId ? motionSummary(template.definition) : `${template.definition.duration.toFixed(1)}s` }}
						</span>
					</button>

					<!-- A blank page to write into. Authoring is stage 5; for now it
					     makes a layer you (or the AI) can fill in. -->
					<button v-if="g === sections.length - 1"
						class="motion-tile flex flex-col items-start gap-1.5 p-2 rounded-xl border border-dashed text-left transition active:scale-95 cursor-grab"
						:class="activeTemplateId === 'custom'
							? 'border-primary bg-primary/10'
							: 'border-zinc-200/70 dark:border-zinc-700/70 hover:border-primary/40 hover:bg-primary/5'"
						draggable="true"
						data-motion-template="custom"
						title="Custom HTML — a page you or the AI writes. Drag onto the timeline, or double-click to add it at the playhead."
						@dragstart="onDragStart('custom', $event)"
						@dragend="store.draggingMotionTemplate = null"
						@dblclick="store.addMotionLayer(null)"
						@keydown.enter.prevent="store.addMotionLayer(null)">
						<div class="w-full h-11 rounded-lg bg-zinc-800/50 flex items-center justify-center text-zinc-400" aria-hidden="true">
							<span class="iconify tabler--code w-[18px] h-[18px]"></span>
						</div>
						<span class="text-[10px] font-semibold leading-tight text-zinc-700 dark:text-zinc-300">Custom HTML</span>
						<span class="font-mono text-[8px] text-zinc-500 -mt-1">you or the AI writes it</span>
					</button>
				</div>
			</template>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { MOTION_TEMPLATES, motionSummary } from '@shared/motion'
import { motionSections } from '@shared/motionTemplates'
import { useEditorStore } from '../../stores/editorStore'
import SlimTooltip from '../../components/SlimTooltip.vue'

/**
 * The motion library — board 1's Motion tab.
 *
 * Drag a tile onto any lane and it lands on the motion track (`M1`, made when
 * absent) at the drop time; double-click or Enter puts it at the playhead. The
 * tile of the template under the current selection is highlighted and spells
 * out its windows ("4.0s · 3 moments").
 */

defineProps<{ collapsed?: boolean }>()
defineEmits<{ (e: 'update:collapsed', value: boolean): void }>()

const store = useEditorStore()
const sections = motionSections()

/** The template the selected motion layer uses, so its tile reads as current. */
const activeTemplateId = computed(() => {
	if (store.selectedItemIds.length !== 1) return null
	const item = store.doc?.timeline.find((i) => i.id === store.selectedItemIds[0])
	if (!item?.motion) return null
	return item.motion.template ?? 'custom'
})

const onDragStart = (templateId: string, event: DragEvent) => {
	if (!event.dataTransfer) return
	event.dataTransfer.setData('application/x-frameflow-motion', templateId)
	// Readable during dragover (the payload is not), so lanes can accept it.
	event.dataTransfer.setData('application/x-frameflow-kind-motion', '1')
	event.dataTransfer.effectAllowed = 'copy'
	store.draggingMotionTemplate = templateId
}
</script>
