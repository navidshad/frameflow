<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<div class="px-4 pt-4 pb-2 shrink-0">
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Inspector</span>
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pb-4">
			<!-- Timeline-item mode (priority when items are selected) -->
			<template v-if="timelineItem">
				<h3 class="text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading truncate">
					{{ timelineItem.label || 'Timeline clip' }}
				</h3>

				<dl class="mt-3 space-y-2">
					<MetaRow label="Track" :value="trackName" />
					<MetaRow label="Start" :value="formatTime(timelineItem.timelineStart)" mono />
					<MetaRow label="Source in" :value="formatTime(timelineItem.in)" mono />
					<MetaRow label="Source out" :value="formatTime(timelineItem.out)" mono />
				</dl>

				<!-- Retime: speed OR exact duration (PRD §5.6 numeric path) -->
				<div class="mt-4 space-y-3">
					<div>
						<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1">
							Speed <span class="normal-case tracking-normal font-mono text-secondary ml-1">{{ timelineItem.speed.toFixed(2) }}×</span>
						</label>
						<input type="number" min="0.25" max="4" step="0.05" :value="timelineItem.speed"
							class="w-full px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-mono text-zinc-800 dark:text-zinc-200 input-focus-ring"
							@change="onSpeedInput" />
					</div>
					<div>
						<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1">
							Duration (s)
						</label>
						<input type="number" min="0.05" step="0.1" :value="timelineItem.duration.toFixed(2)"
							class="w-full px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-mono text-zinc-800 dark:text-zinc-200 input-focus-ring"
							@change="onDurationInput" />
						<p class="mt-1 text-[9px] text-zinc-400 leading-snug">
							Changing duration retimes the clip (same content, new speed) and ripples the track.
						</p>
					</div>
					<label class="flex items-center gap-2 cursor-pointer">
						<input type="checkbox" class="accent-primary" :checked="timelineItem.preservePitch"
							@change="editorStore.setItemPreservePitch(timelineItem!.id, ($event.target as HTMLInputElement).checked)" />
						<span class="text-[11px] text-zinc-600 dark:text-zinc-300">Preserve audio pitch when retimed</span>
					</label>
				</div>

				<!-- Actions -->
				<div class="mt-4 flex flex-col gap-2">
					<button
						class="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:border-primary/40 hover:text-primary transition active:scale-95"
						@click="editorStore.toggleItemMuted(timelineItem!.id)">
						<span :class="timelineItem.muted ? 'iconify tabler--volume' : 'iconify tabler--volume-off'" class="w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
						{{ timelineItem.muted ? 'Unmute clip audio' : 'Mute clip audio' }}
					</button>
					<button
						class="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:border-primary/40 hover:text-primary transition active:scale-95"
						@click="editorStore.splitAtPlayhead()">
						<span class="iconify tabler--blade-filled w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
						Split at playhead
					</button>
					<button
						class="w-full px-3 py-2 rounded-xl border border-red-200 dark:border-red-900/40 text-xs font-bold text-red-500 hover:bg-red-500/10 transition active:scale-95"
						@click="editorStore.deleteItems([timelineItem!.id])">
						<span class="iconify tabler--trash w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
						Ripple delete
					</button>
				</div>

				<!-- Keep scanned silence results in view while inspecting items -->
				<SilenceFinder v-if="editorStore.silenceScan?.assetId === timelineItem.sourceAssetId"
					:asset-id="timelineItem.sourceAssetId" compact />
			</template>

			<!-- Multi-select mode -->
			<template v-else-if="editorStore.selectedItemIds.length > 1">
				<h3 class="text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading">
					{{ editorStore.selectedItemIds.length }} clips selected
				</h3>
				<button
					class="mt-4 w-full px-3 py-2 rounded-xl border border-red-200 dark:border-red-900/40 text-xs font-bold text-red-500 hover:bg-red-500/10 transition active:scale-95"
					@click="editorStore.deleteItems(editorStore.selectedItemIds)">
					<span class="iconify tabler--trash w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
					Ripple delete all
				</button>
			</template>

			<!-- Clip mode -->
			<template v-else-if="clip">
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

				<!-- Keep scanned silence results in view while previewing pieces -->
				<SilenceFinder v-if="editorStore.silenceScan?.assetId === clip.sourceAssetId"
					:asset-id="clip.sourceAssetId" compact />
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
					<div v-else class="flex items-center justify-between gap-2">
						<p class="text-[11px] text-accent font-medium">
							<span class="iconify tabler--check w-3 h-3 inline-block align-[-1px]"></span>
							Scene descriptions ready
						</p>
						<button class="text-[10px] font-bold uppercase tracking-widest text-zinc-400 hover:text-red-500 transition"
							@click="editorStore.clearAssetData(asset.id, 'descriptions')">
							Remove
						</button>
					</div>

					<!-- Opt-in Gemini transcript -->
					<div class="mt-3">
						<button v-if="!hasTranscript"
							class="w-full px-3 py-2 rounded-xl border border-secondary/40 text-secondary text-xs font-bold hover:bg-secondary/10 transition active:scale-95 disabled:opacity-50"
							:disabled="transcribing" @click="transcribe">
							<span class="iconify tabler--file-text w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
							{{ transcribing ? 'Transcribing…' : 'Transcribe (uses Gemini)' }}
						</button>
						<p v-if="!hasTranscript" class="mt-1.5 text-[10px] text-zinc-400 leading-snug">
							Adds spoken text to each piece and enriches AI editing context. Costs tokens.
						</p>
						<div v-else class="flex items-center justify-between gap-2">
							<p class="text-[11px] text-accent font-medium">
								<span class="iconify tabler--check w-3 h-3 inline-block align-[-1px]"></span>
								Transcript ready
							</p>
							<button class="text-[10px] font-bold uppercase tracking-widest text-zinc-400 hover:text-red-500 transition"
								@click="editorStore.clearAssetData(asset.id, 'transcript')">
								Remove
							</button>
						</div>
					</div>
				</div>

				<!-- Silence / dead-air finder (§5.6) — assistive, review-only -->
				<SilenceFinder v-if="asset.metadata?.hasAudio !== false" :asset-id="asset.id" />
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
import SilenceFinder from './SilenceFinder.vue'

const editorStore = useEditorStore()

const clip = computed(() => editorStore.selectedClip)
const asset = computed(() => editorStore.selectedAsset)
const describing = ref(false)
const transcribing = ref(false)

// Timeline-item mode: single selected item takes priority over clip/asset
const timelineItem = computed(() =>
	editorStore.selectedItemIds.length === 1
		? editorStore.doc?.timeline.find((i) => i.id === editorStore.selectedItemIds[0]) || null
		: null
)

const trackName = computed(() =>
	editorStore.doc?.tracks.find((t) => t.id === timelineItem.value?.trackId)?.name || '—'
)

const onSpeedInput = (event: Event) => {
	const value = parseFloat((event.target as HTMLInputElement).value)
	if (timelineItem.value && Number.isFinite(value) && value > 0) {
		editorStore.setItemSpeed(timelineItem.value.id, value)
	}
}

const onDurationInput = (event: Event) => {
	const value = parseFloat((event.target as HTMLInputElement).value)
	if (timelineItem.value && Number.isFinite(value) && value > 0) {
		editorStore.setItemTargetDuration(timelineItem.value.id, value)
	}
}

const hasDescriptions = computed(() =>
	(asset.value?.clips || []).some((c) => !!c.visual)
)

const hasTranscript = computed(() =>
	(asset.value?.clips || []).some((c) => !!c.text)
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

const transcribe = async () => {
	if (!asset.value) return
	transcribing.value = true
	try {
		await editorStore.transcribeAsset(asset.value.id)
	} finally {
		transcribing.value = false
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
