<template>
	<AppDialog :model-value="modelValue" :title="title" size="md"
		@update:model-value="onToggle">
		<!-- ===== Idle: options ===== -->
		<template v-if="!state">
			<span class="lbl block">Resolution</span>
			<div role="radiogroup" aria-label="Resolution">
				<OptionRow v-for="option in qualityOptions" :key="option.value" kind="radio" :checked="choice === option.value"
					:label="option.label" :description="option.description" @toggle="choice = option.value" />
			</div>

			<span class="lbl block mt-3">Format</span>
			<OptionRow v-for="f in FORMATS" :key="f.value" :checked="formats.includes(f.value)" :label="f.label"
				:description="f.description" @toggle="toggleFormat(f.value)" />
			<p v-if="formats.length > 1" class="mt-1 text-[10px] text-zinc-500 leading-snug">
				Rendered one after another — two at once finishes later than two in a row.
			</p>

			<p v-if="motionNote" class="mt-3 text-[10px] text-zinc-500 leading-snug">{{ motionNote }}</p>

			<div v-if="store.exportWarnings.length" class="mt-3 strip strip-warn !block !py-2 space-y-1">
				<p v-for="warning in store.exportWarnings" :key="warning.id"
					class="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
					{{ warning.text }}
					<button v-if="warning.action" class="ml-1 font-semibold text-primary hover:text-primary-dark transition-colors"
						@click="store.toggleTrackFlag(warning.action.trackId, warning.action.flag)">{{ warning.action.label }}</button>
				</p>
			</div>
		</template>

		<!-- ===== Rendering / stitching ===== -->
		<template v-else-if="store.isRendering">
			<div class="flex items-baseline justify-between gap-3">
				<span class="text-xs font-mono tabular-nums text-zinc-500 dark:text-zinc-400">{{ state.percent }}%</span>
				<span class="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
					<template v-if="!store.cancelling">{{ etaText }}</template>
					<template v-if="!store.cancelling && elapsedText"> · {{ elapsedText }} so far</template>
				</span>
			</div>
			<div class="h-[3px] mt-2 bg-zinc-200 dark:bg-white/10 overflow-hidden">
				<div class="h-full bg-primary transition-all duration-300" :style="{ width: `${state.percent}%` }"></div>
			</div>

			<!-- What was asked for: an export runs long, and nobody remembers the choices an hour in. -->
			<dl v-if="summaryRows.length" class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[11px] leading-snug" aria-label="This export">
				<template v-for="row in summaryRows" :key="row.label">
					<dt class="text-zinc-400 dark:text-zinc-500">{{ row.label }}</dt>
					<dd class="text-zinc-700 dark:text-zinc-200 min-w-0 break-words">{{ row.value }}</dd>
				</template>
			</dl>

			<!-- What it is doing, step by step. -->
			<ol v-if="state.steps?.length" class="mt-3 space-y-1.5" aria-label="Export steps">
				<li v-for="step in state.steps" :key="step.id" class="flex items-start gap-2 text-[11px] leading-snug">
					<span class="mt-[3px] w-3 h-3 shrink-0 flex items-center justify-center">
						<span v-if="step.state === 'done'" class="iconify tabler--check w-3 h-3 text-accent"></span>
						<span v-else-if="step.state === 'active'"
							class="w-2.5 h-2.5 rounded-full border-2 border-primary border-t-transparent animate-spin"></span>
						<span v-else class="w-1.5 h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-600"></span>
					</span>
					<span class="flex-1 min-w-0"
						:class="step.state === 'pending' ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-700 dark:text-zinc-200'">
						{{ step.label }}
						<span v-if="step.detail && step.state !== 'pending'" class="text-zinc-400 dark:text-zinc-500"> · {{ step.detail }}</span>
					</span>
				</li>
			</ol>

			<p v-if="etaNote && !store.cancelling" class="mt-2 text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500">{{ etaNote }}</p>

			<p v-if="store.cancelling" class="mt-3 flex items-center gap-2 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
				<span class="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin shrink-0"></span>
				Stopping the export… this can take a few seconds while the work in progress is stopped.
			</p>
			<p v-else class="mt-3 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
				Rendering from a snapshot of your timeline — you can keep editing or open another project meanwhile.
				It continues in the background if you close this.
			</p>
		</template>

		<!-- ===== Done ===== -->
		<template v-else-if="state.phase === 'done'">
			<div class="flex items-center gap-2.5">
				<span class="w-[22px] h-[22px] rounded-full bg-accent/20 text-accent flex items-center justify-center shrink-0">
					<span class="iconify tabler--check w-3.5 h-3.5"></span>
				</span>
				<span class="font-mono text-xs break-all">{{ fileName }}</span>
			</div>
			<p class="mt-3 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
				It stays in this project's
				<button class="font-semibold text-primary hover:text-primary-dark transition-colors"
					@click="showExports">Exports tab</button>
				— you can find it there any time.
			</p>
		</template>

		<!-- ===== Error / canceled ===== -->
		<template v-else>
			<p v-if="!isCanceled" class="text-xs text-red-500 leading-relaxed">{{ state.error }}</p>
			<p v-else class="text-xs text-zinc-500 dark:text-zinc-400">The render was stopped before it finished.</p>
		</template>

		<template #footer>
			<!-- Idle -->
			<template v-if="!state">
				<button class="btn-text" @click="close">Cancel</button>
				<button class="btn-fill" :disabled="!store.canExport || !formats.length"
					@click="store.startExportBatch(request.quality, formats, request.height)">Export</button>
			</template>
			<!-- Rendering -->
			<template v-else-if="store.isRendering">
				<button class="btn-text btn-text-danger" :disabled="store.cancelling" @click="store.abortExport()">
					{{ store.cancelling ? 'Stopping…' : 'Cancel render' }}
				</button>
				<button class="btn-text btn-text-primary" title="The export keeps running — you can keep editing or open another project"
					@click="close">Continue in background</button>
			</template>
			<!-- Done -->
			<template v-else-if="state.phase === 'done'">
				<button class="btn-text btn-text-primary" @click="openFolder">Open folder</button>
				<button class="btn-text btn-text-primary" @click="saveAs">Save As…</button>
				<button class="btn-fill" @click="finish">Done</button>
			</template>
			<!-- Error -->
			<template v-else>
				<button class="btn-text" @click="close">Close</button>
				<button class="btn-fill" @click="store.clearRenderState()">Retry</button>
			</template>
		</template>
	</AppDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { DeliveryFormat } from '@shared/types'
import AppDialog from '../../components/AppDialog.vue'
import OptionRow from '../../components/OptionRow.vue'
import { useEditorStore } from '../../stores/editorStore'
import { fitFrameToHeight } from '@shared/framing'
import { PREVIEW_LINES, exportChoices, linesForChoice, sizeText, type ExportChoiceId } from '@shared/resolution'
import { formatEta } from '@shared/renderEta'
import { FORMAT_LABELS } from '@shared/exportSummary'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void; (e: 'show-exports'): void }>()

const store = useEditorStore()
type Choice = ExportChoiceId
const CHOICE_KEY = 'frameflow.export.resolution'
const savedChoice = (): Choice => {
	try {
		const v = localStorage.getItem(CHOICE_KEY)
		return v === '4k' || v === '2k' || v === '1080' || v === '720' || v === 'preview' ? v : 'original'
	} catch { return 'original' }
}
const choice = ref<Choice>(savedChoice())
watch(choice, (v) => { try { localStorage.setItem(CHOICE_KEY, v) } catch { /* private window: not remembered */ } })
/** What the main process is asked for: sources or proxies, and how many lines. */
const request = computed(() => ({
	quality: (choice.value === 'preview' ? 'preview' : 'original') as 'original' | 'preview',
	height: linesForChoice(choice.value)
}))
// Kept for the notes below that only concern a render from the sources at full size.
const quality = computed(() => (choice.value === 'original' ? 'original' : 'other'))
const formats = ref<DeliveryFormat[]>(['h264'])

const toggleFormat = (value: DeliveryFormat) => {
	formats.value = formats.value.includes(value)
		? formats.value.filter((f) => f !== value)
		: [...formats.value, value]
}

const FORMATS: { value: DeliveryFormat; label: string; description: string }[] = [
	{
		value: 'h264',
		label: 'MP4 (H.264)',
		description: 'What you post. Plays everywhere, small file.'
	},
	{
		value: 'h265',
		label: 'MP4 (H.265 / HEVC)',
		description: 'Much smaller than H.264 at the same look (measured: about a third). Plays on Apple devices and current browsers; some older players and sites cannot.'
	},
	{
		value: 'prores',
		label: 'ProRes 422 HQ (.mov)',
		description: 'What you hand to another editor. Very large file, no generation loss.'
	}
]

const state = computed(() => store.renderState)
const etaText = computed(() => formatEta(state.value?.etaSec, state.value?.etaSpread))
// The settings of the export in flight, plus the other file types still waiting their turn.
const summaryRows = computed(() => {
	const rows = [...(state.value?.summary ?? [])]
	const queued = store.exportQueue.map((q) => FORMAT_LABELS[q.format])
	if (rows.length && queued.length) rows.push({ label: 'Then', value: queued.join(', ') })
	return rows
})
// The time left is a guess; say so while it is a wide one, and say why it will improve.
const etaNote = computed(() => {
	const spread = state.value?.etaSpread ?? 0
	return spread >= 0.5 ? 'A first estimate. It gets closer as the steps finish, and after an export it learns how fast this Mac really is.' : ''
})
const elapsedText = computed(() => {
	const sec = state.value?.elapsedSec ?? 0
	if (sec < 5) return ''
	if (sec < 90) return `${sec} s`
	return `${Math.round(sec / 60)} min`
})
// What the background pre-render has done, so a long first export is not a surprise.
const motionNote = computed(() => {
	const p = store.motionPrerender
	if (!p || p.threadId !== store.threadId || p.total === 0 || quality.value !== 'original') return ''
	if (p.done >= p.total) return `All ${p.total} motion layers are drawn and ready.`
	return p.running
		? `${p.done} of ${p.total} motion layers are drawn so far, in the background. An export started now draws the rest itself, so it takes longer.`
		: `${p.done} of ${p.total} motion layers are drawn. The export draws the rest.`
})
const isCanceled = computed(() => state.value?.error === 'aborted')
const title = computed(() => {
	if (!state.value) return 'Export video'
	if (store.isRendering) {
		if (store.cancelling) return 'Stopping export…'
		// Named for what it is doing now, not for one of its stages.
		const active = state.value.steps?.find((s) => s.state === 'active')
		return active ? `${active.label}…` : 'Exporting video…'
	}
	if (state.value.phase === 'done') return 'Export complete'
	return isCanceled.value ? 'Export canceled' : 'Export failed'
})
const fileName = computed(() => state.value?.outputPath?.split('/').pop() || '')

// The sizes come from the project's own frame and stop at it: an export is never larger
// than the project, so a 720p project is offered 720p and the fast preview, nothing above.
const qualityOptions = computed<{ value: Choice; label: string; description: string }[]>(() => {
	const list = exportChoices(store.sequenceFrame).map((c) => ({
		value: c.id as Choice,
		label: c.id === 'original' ? `Project size · ${c.label}` : c.label,
		description: c.id === 'original'
			? 'Renders from the source files at the full size of the project. The slowest.'
			: 'From the source files, scaled down. Faster, and a smaller file.'
	}))
	list.push({
		value: 'preview', label: `Fast preview · ${sizeText(fitFrameToHeight(store.sequenceFrame, PREVIEW_LINES))}`,
		description: 'Renders from the 480p proxies at up to 30 fps. The fastest, and the lowest quality.'
	})
	return list
})
// A remembered choice the project can no longer offer falls back to the full size.
watch(qualityOptions, (list) => { if (!list.some((o) => o.value === choice.value)) choice.value = 'original' }, { immediate: true })

// Closing the dialog does NOT abort — the render continues and the header
// button keeps showing progress (reopen anytime).
/**
 * A render that ended without a file (cancelled or failed) has nothing left to
 * show, so leaving it must not leave its message behind: the next open would
 * show "Export canceled" again, with no way back to the quality and format
 * choices except pressing Retry. A finished one stays until Done.
 */
const endedWithoutFile = () => !!state.value && !store.isRendering && state.value.phase !== 'done'
const close = () => {
	if (endedWithoutFile()) store.clearRenderState()
	emit('update:modelValue', false)
}
// The backdrop and the corner × reach this too, not just the Close button.
const onToggle = (open: boolean) => (open ? emit('update:modelValue', true) : close())
// A stale cancelled/failed screen from before is never what opening is for.
watch(() => props.modelValue, (open) => { if (open && endedWithoutFile()) store.clearRenderState() })

const finish = () => {
	store.clearRenderState()
	close()
}

// Done, and on to the file: clear the result (it is in the list now) and hand
// the page the cue to open the Exports tab.
const showExports = () => {
	emit('show-exports')
	finish()
}

const saveAs = async () => {
	const outputPath = state.value?.outputPath
	if (!outputPath) return
	await (window as any).api.saveVideo(outputPath)
}

const openFolder = () => {
	if (store.threadId) (window as any).api.openThreadDir(store.threadId)
}
</script>
