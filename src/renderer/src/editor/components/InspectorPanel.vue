<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<div class="px-4 pt-4 pb-2 shrink-0">
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Inspector</span>
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pb-4">
			<!-- Clip mode -->
			<template v-if="clip">
				<div class="rounded-xl overflow-hidden mb-3 bg-zinc-200 dark:bg-zinc-800">
					<img v-if="clip.thumbnailPath" :src="`media://${clip.thumbnailPath}`" class="w-full object-cover" />
				</div>
				<h3 class="text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading">Piece #{{ clip.index }}</h3>

				<dl class="mt-3 space-y-2">
					<MetaRow label="In" :value="formatTime(clip.in)" mono />
					<MetaRow label="Out" :value="formatTime(clip.out)" mono />
					<MetaRow label="Duration" :value="`${clip.duration.toFixed(2)}s`" mono />
					<MetaRow label="Selected" :value="clip.selected ? 'Yes' : 'No'" />
				</dl>

				<!-- Context (visual description) -->
				<div v-if="clip.visual" class="mt-4">
					<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Scene context</span>
					<p class="mt-1.5 text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">{{ clip.visual }}</p>
				</div>
				<div v-if="clip.text" class="mt-3">
					<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Transcript</span>
					<p class="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed italic">{{ clip.text }}</p>
				</div>
			</template>

			<!-- Asset mode -->
			<template v-else-if="asset">
				<h3 class="text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading break-words">{{ asset.name }}</h3>

				<dl v-if="asset.metadata" class="mt-3 space-y-2">
					<MetaRow label="Duration" :value="formatTime(asset.metadata.duration)" mono />
					<MetaRow label="Resolution" :value="`${asset.metadata.width}×${asset.metadata.height}`" mono />
					<MetaRow label="FPS" :value="String(asset.metadata.fps)" mono />
					<MetaRow label="Codec" :value="asset.metadata.codec" />
					<MetaRow label="Size" :value="formatSize(asset.metadata.size)" mono />
					<MetaRow label="Audio" :value="asset.metadata.hasAudio ? 'Yes' : 'No'" />
					<MetaRow label="Pieces" :value="String(asset.clips.length)" mono />
				</dl>
				<p v-else class="mt-3 text-xs text-zinc-400">Metadata unavailable for this file.</p>

				<!-- Opt-in Gemini descriptions -->
				<div v-if="asset.preprocessState === 'completed' && asset.clips.length > 0" class="mt-5">
					<button v-if="!hasDescriptions"
						class="w-full px-3 py-2 rounded-xl border border-secondary/40 text-secondary text-xs font-bold hover:bg-secondary/10 transition active:scale-95 disabled:opacity-50"
						:disabled="describing" @click="describe">
						<span class="iconify tabler--sparkles w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
						{{ describing ? 'Describing scenes…' : 'Describe scenes (uses Gemini)' }}
					</button>
					<p v-if="!hasDescriptions" class="mt-1.5 text-[10px] text-zinc-400 leading-snug">
						Generates a one-line description per piece for the context view. Costs tokens.
					</p>
					<p v-else class="text-[11px] text-accent font-medium">
						<span class="iconify tabler--check w-3 h-3 inline-block align-[-1px]"></span>
						Scene descriptions ready
					</p>
				</div>
			</template>

			<!-- Empty -->
			<div v-else class="h-full flex flex-col items-center justify-center gap-2 text-center py-8">
				<span class="iconify tabler--click w-6 h-6 text-zinc-300 dark:text-zinc-600"></span>
				<p class="text-xs text-zinc-400">Select a media file or piece to inspect it.</p>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, h, ref } from 'vue'
import type { FunctionalComponent } from 'vue'
import { useEditorStore } from '../../stores/editorStore'

const editorStore = useEditorStore()

const clip = computed(() => editorStore.selectedClip)
const asset = computed(() => editorStore.selectedAsset)
const describing = ref(false)

const hasDescriptions = computed(() =>
	(asset.value?.clips || []).some((c) => !!c.visual)
)

const formatTime = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	const ms = Math.floor((seconds % 1) * 100)
	return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`
}

const formatSize = (bytes: number) => {
	if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const describe = async () => {
	if (!asset.value) return
	describing.value = true
	try {
		await editorStore.describeAsset(asset.value.id)
	} finally {
		describing.value = false
	}
}

// Small label/value row
const MetaRow: FunctionalComponent<{ label: string; value: string; mono?: boolean }> = (props) =>
	h('div', { class: 'flex items-center justify-between gap-3' }, [
		h('dt', { class: 'text-[10px] font-bold uppercase tracking-widest text-zinc-400 shrink-0' }, props.label),
		h('dd', {
			class: ['text-xs text-zinc-700 dark:text-zinc-200 truncate', props.mono ? 'font-mono' : 'font-medium']
		}, props.value)
	])
</script>
