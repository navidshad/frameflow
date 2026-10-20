<template>
	<AppDialog :model-value="modelValue" title="Import media from URL" size="md"
		@update:model-value="$emit('update:modelValue', $event)">
		<div class="space-y-3">
			<div>
				<label for="import-url" class="lbl block">Video URL</label>
				<input id="import-url" v-model="url" class="field !text-[13px]" placeholder="https://youtube.com/watch?v=… or direct link"
					:disabled="importing" @keyup.enter="fetchFormats" />
			</div>

			<!-- Resolution picker (after formats fetched) -->
			<div v-if="resolutions.length > 0" class="flex items-center gap-3">
				<label for="import-res" class="lbl shrink-0">Resolution</label>
				<select id="import-res" v-model="resolution" class="field flex-1" :disabled="importing">
					<option v-for="res in resolutions" :key="res" :value="res">{{ res }}</option>
				</select>
			</div>

			<!-- Progress -->
			<div v-if="importing">
				<div class="h-[3px] bg-zinc-200 dark:bg-white/10 overflow-hidden">
					<div class="h-full transition-all duration-300"
						:class="phase === 'updating-ytdlp' ? 'bg-amber-500 animate-pulse w-full' : 'bg-primary'"
						:style="phase === 'updating-ytdlp' ? undefined : { width: `${progress}%` }"></div>
				</div>
				<p class="mt-1.5 text-[11px] font-mono" :class="phase ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500'">
					{{ progressLabel }}
				</p>
			</div>

			<p v-if="error" class="text-xs text-red-500 leading-snug">{{ error }}</p>
		</div>

		<template #footer>
			<button class="btn-text" :disabled="importing" @click="close">Cancel</button>
			<button v-if="resolutions.length === 0" class="btn-fill" :disabled="!url.trim() || fetching" @click="fetchFormats">
				{{ fetching ? 'Checking…' : 'Continue' }}
			</button>
			<button v-else class="btn-fill" :disabled="importing" @click="startImport">
				{{ importing ? 'Importing…' : 'Import' }}
			</button>
		</template>
	</AppDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppDialog from '../../components/AppDialog.vue'
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
