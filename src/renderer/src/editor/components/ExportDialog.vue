<template>
	<Modal :model-value="modelValue" title="Export video" size="md"
		@update:model-value="$emit('update:modelValue', $event)">
		<div class="py-2 space-y-4">
			<!-- ===== Idle: options ===== -->
			<template v-if="!state">
				<div>
					<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-2">Quality</span>
					<label v-for="option in qualityOptions" :key="option.value"
						class="flex items-start gap-2.5 p-2.5 rounded-xl border cursor-pointer transition mb-2"
						:class="quality === option.value
							? 'border-primary/50 bg-primary/5 ring-1 ring-primary/20'
							: 'border-zinc-200 dark:border-zinc-800 hover:border-primary/30'">
						<input type="radio" class="accent-primary mt-0.5" :value="option.value" v-model="quality" />
						<div>
							<p class="text-xs font-bold text-zinc-800 dark:text-zinc-200">{{ option.label }}</p>
							<p class="text-[10px] text-zinc-500 leading-snug">{{ option.description }}</p>
						</div>
					</label>
				</div>

				<p v-if="store.exportNotice"
					class="px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[10px] font-medium text-amber-600 dark:text-amber-400 leading-snug">
					<span class="iconify tabler--alert-triangle w-3 h-3 inline-block align-[-1px] mr-1"></span>
					{{ store.exportNotice }}
				</p>
			</template>

			<!-- ===== Rendering / stitching ===== -->
			<template v-else-if="store.isRendering">
				<div class="py-3 text-center">
					<p class="text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading mb-1">
						{{ state.phase === 'stitching' ? 'Finalizing…' : 'Rendering regions…' }}
					</p>
					<p class="text-[10px] text-zinc-400">Your timeline is being rendered with FFmpeg.</p>
				</div>
				<div class="h-2 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
					<div class="h-full bg-primary rounded-full transition-all duration-300"
						:style="{ width: `${state.percent}%` }"></div>
				</div>
				<p class="text-center text-[11px] font-mono text-zinc-500">{{ state.percent }}%</p>
			</template>

			<!-- ===== Done ===== -->
			<template v-else-if="state.phase === 'done'">
				<div class="py-3 text-center">
					<div class="w-12 h-12 mx-auto rounded-2xl bg-accent/10 flex items-center justify-center text-accent mb-3">
						<span class="iconify tabler--check w-6 h-6"></span>
					</div>
					<p class="text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading">Export complete</p>
					<p class="mt-1 text-[10px] font-mono text-zinc-400 break-all px-4">{{ fileName }}</p>
				</div>
			</template>

			<!-- ===== Error / canceled ===== -->
			<template v-else>
				<div class="py-3 text-center">
					<div class="w-12 h-12 mx-auto rounded-2xl flex items-center justify-center mb-3"
						:class="isCanceled ? 'bg-zinc-500/10 text-zinc-400' : 'bg-red-500/10 text-red-500'">
						<span :class="isCanceled ? 'iconify tabler--player-stop' : 'iconify tabler--alert-triangle'" class="w-6 h-6"></span>
					</div>
					<p class="text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading">
						{{ isCanceled ? 'Export canceled' : 'Export failed' }}
					</p>
					<p v-if="!isCanceled" class="mt-1 text-[11px] text-red-500 leading-snug px-4">{{ state.error }}</p>
				</div>
			</template>
		</div>

		<template #footer>
			<div class="flex justify-end gap-2 w-full">
				<!-- Idle -->
				<template v-if="!state">
					<button class="btn-ghost" @click="close">Cancel</button>
					<button class="btn-primary" :disabled="!store.canExport" @click="store.startExport(quality)">
						<span class="iconify tabler--file-export w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
						Export
					</button>
				</template>
				<!-- Rendering -->
				<template v-else-if="store.isRendering">
					<button class="btn-ghost !text-red-500 hover:!bg-red-500/10" @click="store.abortExport()">
						Cancel render
					</button>
				</template>
				<!-- Done -->
				<template v-else-if="state.phase === 'done'">
					<button class="btn-ghost" @click="openFolder">Open folder</button>
					<button class="btn-ghost" @click="finish">Done</button>
					<button class="btn-primary" @click="saveAs">
						<span class="iconify tabler--download w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
						Save As…
					</button>
				</template>
				<!-- Error -->
				<template v-else>
					<button class="btn-ghost" @click="close">Close</button>
					<button class="btn-primary" @click="store.clearRenderState()">Retry</button>
				</template>
			</div>
		</template>
	</Modal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Modal } from 'pilotui/complex'
import { useEditorStore } from '../../stores/editorStore'

defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

const store = useEditorStore()
const quality = ref<'original' | 'preview'>('original')

const state = computed(() => store.renderState)
const isCanceled = computed(() => state.value?.error === 'aborted')
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

<style scoped>
.btn-ghost {
	@apply px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition active:scale-95;
}
.btn-primary {
	@apply px-4 py-2 rounded-xl bg-primary text-white text-xs font-bold shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed;
}
</style>
