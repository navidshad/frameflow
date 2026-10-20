<template>
	<div class="flex flex-col min-h-0 overflow-hidden">
		<div class="px-3 pt-3 pb-1 flex items-center shrink-0">
			<span class="lbl">Motion <span class="font-mono normal-case tracking-normal font-normal text-zinc-400 ml-1">{{ tileCount }}</span></span>
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
				</div>
			</template>

			<!-- Templates people saved: here in every project -->
			<template v-if="saved.length">
				<div class="px-1 pb-1.5 pt-3">
					<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400">Saved</span>
				</div>
				<div class="grid grid-cols-2 gap-1.5" data-motion-saved>
					<div v-for="template in saved" :key="template.id" class="relative group/tile">
						<button class="motion-tile w-full flex flex-col items-start gap-1.5 p-2 rounded-xl border text-left transition active:scale-95 cursor-grab
						               border-zinc-200/70 dark:border-zinc-700/70 hover:border-primary/40 hover:bg-primary/5"
							draggable="true" :data-motion-template="template.id"
							:title="`${template.label} — ${template.description} Drag onto the timeline, or double-click to add it at the playhead.`"
							@dragstart="onDragStart(template.id, $event)" @dragend="store.draggingMotionTemplate = null"
							@dblclick="store.addMotionLayer(template.id)" @keydown.enter.prevent="store.addMotionLayer(template.id)">
							<MotionThumb :html="template.html" :definition="template.definition" />
							<span class="text-[10px] font-semibold leading-tight text-zinc-700 dark:text-zinc-300 truncate max-w-full">{{ template.label }}</span>
							<span class="font-mono text-[8px] text-zinc-500 -mt-1">saved · {{ template.definition.duration.toFixed(1) }}s</span>
						</button>
						<button class="absolute top-1 right-1 w-4 h-4 rounded-full bg-zinc-900/80 text-zinc-300 hover:text-red-400 hidden group-hover/tile:flex items-center justify-center"
							:aria-label="`Remove template ${template.label}`" title="Remove from the library"
							@click.stop="store.deleteMotionTemplate(template.id)">
							<span class="iconify tabler--x w-2.5 h-2.5"></span>
						</button>
					</div>
				</div>
			</template>

			<!-- This project: custom layers live here until one is saved as a template -->
			<div class="px-1 pb-1.5 pt-3">
				<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400">This project</span>
			</div>
			<div class="grid grid-cols-2 gap-1.5" data-motion-project>
				<button v-for="layer in projectLayers" :key="layer.itemId"
					class="motion-tile flex flex-col items-start gap-1.5 p-2 rounded-xl border text-left transition active:scale-95 cursor-grab"
					:class="layer.itemId === activeItemId
						? 'border-primary bg-primary/10'
						: 'border-zinc-200/70 dark:border-zinc-700/70 hover:border-primary/40 hover:bg-primary/5'"
					draggable="true" :data-motion-template="`project:${layer.itemId}`"
					:title="`${layer.name} — click to select it on the timeline, drag or double-click to add another copy.`"
					@click="store.selectItems([layer.itemId])"
					@dragstart="onDragStart(`project:${layer.itemId}`, $event)" @dragend="store.draggingMotionTemplate = null"
					@dblclick="store.addMotionLayer(`project:${layer.itemId}`)"
					@keydown.enter.prevent="store.selectItems([layer.itemId])">
					<MotionThumb :html="layer.html" :definition="layer.definition" />
					<span class="text-[10px] font-semibold leading-tight text-zinc-700 dark:text-zinc-300 truncate max-w-full">{{ layer.name }}</span>
					<span class="font-mono text-[8px] text-zinc-500 -mt-1 truncate max-w-full">{{ layer.by }}</span>
				</button>

				<button class="motion-tile flex flex-col items-start gap-1.5 p-2 rounded-xl border border-dashed text-left transition active:scale-95"
					:class="creating ? 'border-primary bg-primary/5' : 'border-zinc-300/90 dark:border-zinc-700/90 hover:border-primary/40 hover:bg-primary/5'"
					data-motion-template="custom" :aria-expanded="creating"
					title="New custom layer — a blank page, or describe it and the AI writes it."
					@click="creating = !creating">
					<div class="w-full h-11 rounded-lg bg-zinc-200/60 dark:bg-zinc-800/50 flex items-center justify-center text-zinc-400" aria-hidden="true">
						<span class="iconify tabler--plus w-[18px] h-[18px]"></span>
					</div>
					<span class="text-[10px] font-semibold leading-tight text-zinc-700 dark:text-zinc-300">New custom layer</span>
					<span class="font-mono text-[8px] text-zinc-500 -mt-1">blank, or describe it</span>
				</button>
			</div>

			<form v-if="creating" class="mt-2 p-2 rounded-xl border border-zinc-200/70 dark:border-zinc-700/70 flex flex-col gap-1.5"
				data-motion-new @submit.prevent="describe">
				<label class="text-[9px] font-bold uppercase tracking-widest text-zinc-400" for="motion-describe">Describe it</label>
				<textarea id="motion-describe" v-model="description" rows="3" class="motion-inp resize-none"
					placeholder="A big number that counts up to 3×, with “faster triage” beneath it"></textarea>
				<div class="flex gap-1.5 justify-end">
					<button type="button" class="px-2.5 py-1 rounded-lg border border-zinc-300 dark:border-zinc-700 text-[10px] font-bold
					        text-zinc-500 dark:text-zinc-300 hover:border-primary/40 hover:text-primary transition"
						@click="blank">Blank page</button>
					<button type="submit" class="px-2.5 py-1 rounded-lg bg-secondary text-white text-[10px] font-bold transition disabled:opacity-50"
						:disabled="!description.trim() || store.promptRunning">Write it with AI</button>
				</div>
			</form>

			<p class="mt-2.5 px-1 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
				Custom layers stay in this project until you save one as a template. Then it joins the library above for every project.
			</p>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { MOTION_TEMPLATES, motionSummary } from '@shared/motion'
import { motionSections } from '@shared/motionTemplates'
import { projectCustomLayers } from '@shared/motionCode'
import { useEditorStore } from '../../stores/editorStore'
import SlimTooltip from '../../components/SlimTooltip.vue'
import MotionThumb from './MotionThumb.vue'

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

onMounted(() => { void store.loadMotionTemplates() })

const saved = computed(() => store.motionUserTemplates)
const projectLayers = computed(() => projectCustomLayers(store.doc?.timeline ?? []))
const tileCount = computed(() => MOTION_TEMPLATES.length + saved.value.length + projectLayers.value.length)

// ===== New custom layer: blank, or described =====

const creating = ref(false)
const description = ref('')

const blank = () => {
	store.addMotionLayer(null)
	creating.value = false
}

const describe = () => {
	if (!description.value.trim()) return
	store.describeMotionLayer(description.value)
	description.value = ''
	creating.value = false
}

/** The template the selected motion layer uses, so its tile reads as current. */
const activeTemplateId = computed(() => {
	if (store.selectedItemIds.length !== 1) return null
	const item = store.doc?.timeline.find((i) => i.id === store.selectedItemIds[0])
	if (!item?.motion) return null
	return item.motion.template ?? 'custom'
})

/** The selected custom layer, so its tile in This project reads as current. */
const activeItemId = computed(() => {
	if (store.selectedItemIds.length !== 1) return null
	const item = store.doc?.timeline.find((i) => i.id === store.selectedItemIds[0])
	if (!item?.motion || item.motion.template) return null
	// Several placements of one page share a tile: match by the page they draw.
	const page = item.motion.passed?.html ?? item.motion.html
	return projectLayers.value.find((l) => {
		const placed = store.doc?.timeline.find((i) => i.id === l.itemId)?.motion
		return (placed?.passed?.html ?? placed?.html) === page
	})?.itemId ?? null
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
