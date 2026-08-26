<template>
	<Modal :model-value="modelValue" title="Import media from URL" size="md"
		@update:model-value="$emit('update:modelValue', $event)">
		<div class="space-y-4 py-2">
			<div>
				<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1.5">
					Video URL
				</label>
				<Input v-model="url" placeholder="https://youtube.com/watch?v=… or direct link"
					:disabled="importing" @keyup.enter="fetchFormats" />
			</div>

			<!-- Resolution picker (after formats fetched) -->
			<div v-if="resolutions.length > 0">
				<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1.5">
					Resolution
				</label>
				<select v-model="resolution"
					class="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-zinc-800 dark:text-zinc-200 input-focus-ring"
					:disabled="importing">
					<option v-for="res in resolutions" :key="res" :value="res">{{ res }}</option>
				</select>
			</div>

			<!-- Progress -->
			<div v-if="importing">
				<div class="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
					<div class="h-full rounded-full transition-all duration-300"
						:class="phase === 'updating-ytdlp' ? 'bg-amber-500 animate-pulse w-full' : 'bg-primary'"
						:style="phase === 'updating-ytdlp' ? undefined : { width: `${progress}%` }"></div>
				</div>
				<p class="mt-1.5 text-[10px] font-mono text-center"
					:class="phase ? 'text-amber-500' : 'text-zinc-400'">
					{{ progressLabel }}
				</p>
			</div>

			<p v-if="error" class="text-xs text-red-500 font-medium leading-snug">{{ error }}</p>
		</div>

		<template #footer>
			<div class="flex justify-end gap-2">
				<button
					class="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
					:disabled="importing" @click="close">
					Cancel
				</button>
				<button v-if="resolutions.length === 0"
					class="px-4 py-2 rounded-xl bg-primary text-white text-xs font-bold shadow-md shadow-primary/20 hover:bg-primary-dark transition disabled:opacity-50 disabled:cursor-not-allowed"
					:disabled="!url.trim() || fetching" @click="fetchFormats">
					{{ fetching ? 'Checking…' : 'Continue' }}
				</button>
				<button v-else
					class="px-4 py-2 rounded-xl bg-primary text-white text-xs font-bold shadow-md shadow-primary/20 hover:bg-primary-dark transition disabled:opacity-50 disabled:cursor-not-allowed"
					:disabled="importing" @click="startImport">
					{{ importing ? 'Importing…' : 'Import' }}
				</button>
			</div>
		</template>
	</Modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Modal } from 'pilotui/complex'
import { Input } from 'pilotui/form'
import { useEditorStore } from '../../stores/editorStore'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()

const editorStore = useEditorStore()

const url = ref('')
const resolutions = ref<string[]>([])
const resolution = ref<string>('')
const fetching = ref(false)
const importing = ref(false)
const error = ref('')
const activeImportId = ref<string | null>(null)

const activeImport = computed(() => {
	if (activeImportId.value) return editorStore.urlImports[activeImportId.value]
	// Fall back to any in-flight import for this session
	const entries = Object.values(editorStore.urlImports)
	return entries.length > 0 ? entries[0] : undefined
})

const progress = computed(() => activeImport.value?.percent ?? 0)
const phase = computed(() => activeImport.value?.phase)

const progressLabel = computed(() => {
	if (phase.value === 'updating-ytdlp') return 'Site blocked the old downloader — updating it…'
	if (phase.value === 'retrying') return 'Downloader updated — retrying download…'
	return progress.value > 0 ? `${Math.round(progress.value)}%` : 'Starting download…'
})

watch(() => props.modelValue, (open) => {
	if (open) reset()
})

const reset = () => {
	url.value = ''
	resolutions.value = []
	resolution.value = ''
	fetching.value = false
	importing.value = false
	error.value = ''
	activeImportId.value = null
}

const close = () => emit('update:modelValue', false)

const fetchFormats = async () => {
	if (!url.value.trim() || fetching.value) return
	fetching.value = true
	error.value = ''
	try {
		const formats = await (window as any).api.fetchVideoFormats(url.value.trim())
		const list: string[] = Array.isArray(formats)
			? formats
			: (formats?.resolutions || [])
		resolutions.value = list.length > 0 ? list : ['best']
		resolution.value = resolutions.value[Math.min(1, resolutions.value.length - 1)]
	} catch (err: any) {
		error.value = err?.message || 'Could not read this URL. Check the link and try again.'
	} finally {
		fetching.value = false
	}
}

const startImport = async () => {
	if (importing.value) return
	importing.value = true
	error.value = ''
	try {
		await editorStore.importUrl(url.value.trim(), resolution.value || undefined)
		close()
	} catch (err: any) {
		error.value = err?.message || 'Import failed. Check the URL and your connection.'
	} finally {
		importing.value = false
	}
}
</script>
