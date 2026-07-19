<template>
	<div class="mt-5 pt-4 border-t border-zinc-200/60 dark:border-zinc-700/50">
		<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Silence finder</span>

		<!-- Detection thresholds -->
		<div v-if="!compact" class="mt-2 grid grid-cols-2 gap-2">
			<div>
				<label class="text-[9px] font-bold uppercase tracking-widest text-zinc-400 block mb-1">
					Noise floor (dB)
				</label>
				<input type="number" min="-60" max="0" step="1" v-model.number="editorStore.silenceNoiseDb"
					class="w-full px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-mono text-zinc-800 dark:text-zinc-200 input-focus-ring" />
			</div>
			<div>
				<label class="text-[9px] font-bold uppercase tracking-widest text-zinc-400 block mb-1">
					Min duration (s)
				</label>
				<input type="number" min="0.1" max="10" step="0.1" v-model.number="editorStore.silenceMinDurationSec"
					class="w-full px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-mono text-zinc-800 dark:text-zinc-200 input-focus-ring" />
			</div>
		</div>

		<button v-if="!compact || !results"
			class="mt-2 w-full px-3 py-2 rounded-xl border border-primary/40 text-primary text-xs font-bold hover:bg-primary/10 transition active:scale-95 disabled:opacity-50"
			:disabled="editorStore.silenceScanning" @click="editorStore.scanSilence(assetId)">
			<span class="iconify tabler--wave-saw-tool w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
			{{ scanLabel }}
		</button>

		<template v-if="results !== null">
			<p v-if="results.length === 0" class="mt-2 text-[11px] text-zinc-400">
				No silent regions found.
			</p>
			<template v-else>
				<div class="mt-2 max-h-40 overflow-y-auto custom-scrollbar rounded-lg border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
					<button v-for="(r, i) in results" :key="i"
						class="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-primary/5 transition"
						@click="seekToRegion(r)">
						<span class="font-mono text-[11px] text-zinc-600 dark:text-zinc-300">{{ formatTime(r.start) }} – {{ formatTime(r.end) }}</span>
						<span class="font-mono text-[10px] text-zinc-400">{{ (r.end - r.start).toFixed(1) }}s</span>
					</button>
				</div>
				<button
					class="mt-2 w-full px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold shadow-md shadow-primary/20 hover:bg-primary/90 transition active:scale-95"
					@click="editorStore.applySilenceRegions(assetId, results)">
					<span class="iconify tabler--scissors w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
					Ripple-delete {{ results.length }} region{{ results.length === 1 ? '' : 's' }}
				</button>
				<p class="mt-1 text-[9px] text-zinc-400 leading-snug">
					Removes these ranges from this asset's placed clips and closes the gaps. Undoable.
				</p>
			</template>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '../../stores/editorStore'

const props = withDefaults(defineProps<{
	assetId: string
	/** Compact mode (clip/item inspector): results + apply only, no threshold inputs. */
	compact?: boolean
}>(), { compact: false })

const editorStore = useEditorStore()

// Results are shown only when the store's scan belongs to THIS asset, so the
// panel follows the asset across inspector modes without leaking across assets.
const results = computed(() =>
	editorStore.silenceScan?.assetId === props.assetId ? editorStore.silenceScan.regions : null
)

const scanLabel = computed(() => {
	if (editorStore.silenceScanning) {
		const p = editorStore.silenceScanPercent
		return p !== null && p > 0 ? `Scanning… ${p}%` : 'Scanning…'
	}
	return results.value ? 'Rescan' : 'Find silence & dead air'
})

const seekToRegion = (r: { start: number; end: number }) => {
	const t = editorStore.sourceTimeToTimeline(props.assetId, r.start)
	if (t !== null) editorStore.seekTo(t)
}

const formatTime = (seconds: number) => {
	const m = Math.floor(seconds / 60)
	const s = Math.floor(seconds % 60)
	const ms = Math.floor((seconds % 1) * 100)
	return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`
}
</script>
