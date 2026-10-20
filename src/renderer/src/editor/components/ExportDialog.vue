<template>
	<AppDialog :model-value="modelValue" :title="title" size="md"
		@update:model-value="$emit('update:modelValue', $event)">
		<!-- ===== Idle: options ===== -->
		<template v-if="!state">
			<span class="lbl block">Quality</span>
			<div role="radiogroup" aria-label="Quality">
				<OptionRow v-for="option in qualityOptions" :key="option.value" kind="radio" :checked="quality === option.value"
					:label="option.label" :description="option.description" @toggle="quality = option.value" />
			</div>

			<span class="lbl block mt-3">Format</span>
			<OptionRow v-for="f in FORMATS" :key="f.value" :checked="formats.includes(f.value)" :label="f.label"
				:description="f.description" @toggle="toggleFormat(f.value)" />
			<p v-if="formats.length > 1" class="mt-1 text-[10px] text-zinc-500 leading-snug">
				Rendered one after another — two at once finishes later than two in a row.
			</p>

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
			<div class="text-xs font-mono tabular-nums text-zinc-500 dark:text-zinc-400">{{ state.percent }}%</div>
			<div class="h-[3px] mt-2 bg-zinc-200 dark:bg-white/10 overflow-hidden">
				<div class="h-full bg-primary transition-all duration-300" :style="{ width: `${state.percent}%` }"></div>
			</div>
			<p class="mt-3 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
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
					@click="store.startExportBatch(quality, formats)">Export</button>
			</template>
			<!-- Rendering -->
			<template v-else-if="store.isRendering">
				<button class="btn-text btn-text-danger" @click="store.abortExport()">Cancel render</button>
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
import { computed, ref } from 'vue'
import type { DeliveryFormat } from '@shared/types'
import AppDialog from '../../components/AppDialog.vue'
import OptionRow from '../../components/OptionRow.vue'
import { useEditorStore } from '../../stores/editorStore'

defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

const store = useEditorStore()
const quality = ref<'original' | 'preview'>('original')
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
		value: 'prores',
		label: 'ProRes 422 HQ',
		description: 'What you hand to another editor. Large file, no generation loss.'
	}
]

const state = computed(() => store.renderState)
const isCanceled = computed(() => state.value?.error === 'aborted')
const title = computed(() => {
	if (!state.value) return 'Export video'
	if (store.isRendering) return state.value.phase === 'stitching' ? 'Finalizing…' : 'Rendering regions…'
	if (state.value.phase === 'done') return 'Export complete'
	return isCanceled.value ? 'Export canceled' : 'Export failed'
})
const fileName = computed(() => state.value?.outputPath?.split('/').pop() || '')

const qualityOptions = [
	{
		value: 'original' as const,
		label: 'Original quality',
		description: 'Renders from the source files at full resolution.'
	},
	{
		value: 'preview' as const,
		label: 'Fast preview (480p)',
		description: 'Renders from the 480p proxies — much faster, lower quality.'
	}
]

// Closing the dialog does NOT abort — the render continues and the header
// button keeps showing progress (reopen anytime).
const close = () => emit('update:modelValue', false)

const finish = () => {
	store.clearRenderState()
	close()
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
