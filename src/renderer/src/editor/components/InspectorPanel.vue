<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<div class="px-4 pt-4 pb-2 shrink-0">
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Inspector</span>
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pb-4">
			<!-- Seam mode. FIRST: selecting a seam usually leaves an adjacent clip
			     selected too, and the item branch below would otherwise win. -->
			<template v-if="seam">
				<h3 class="text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading truncate">
					{{ seam.window ? transitionLabel(seam.window.kind) : transitionLabel(seam.requested!.kind) }}
				</h3>
				<p class="mt-0.5 text-[10px] text-zinc-400">
					Between “{{ seam.junction.outgoing.label || 'clip' }}” and “{{ seam.junction.incoming.label || 'clip' }}”
				</p>

				<div v-if="seam.window" class="mt-4 space-y-4">
					<div>
						<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1">
							Duration
							<span class="normal-case tracking-normal font-mono text-secondary ml-1">
								{{ seam.window.duration.toFixed(2) }}s
							</span>
						</label>
						<input type="range" :min="MIN_TRANSITION_SEC" :max="MAX_TRANSITION_SEC" step="0.05"
							:value="requestedDuration" class="w-full accent-secondary"
							@change="onTransitionDuration" />
						<p class="mt-1 text-[9px] text-zinc-400 leading-snug">
							The window straddles the cut. Nothing moves — the extra frames come from
							footage you trimmed away.
						</p>
					</div>

					<dl class="space-y-1.5">
						<MetaRow label="Asked for" :value="`${requestedDuration.toFixed(2)}s`" mono />
						<MetaRow label="Effective" :value="`${seam.window.duration.toFixed(2)}s`" mono />
						<MetaRow label="Alignment" :value="alignment" />
						<MetaRow label="Repeated" :value="repeated" mono />
					</dl>

					<p v-if="clamped" class="text-[10px] leading-snug text-amber-600 dark:text-amber-500">
						Shortened to fit: these clips can only give
						{{ seam.limits.maxDuration.toFixed(2) }}s between them.
					</p>
					<p v-else-if="repeatsFrames" class="text-[10px] leading-snug text-amber-600 dark:text-amber-500">
						Part of this transition holds a still frame — there is no spare footage
						at this cut. Trim either clip to remove it.
					</p>
				</div>

				<p v-else class="mt-4 text-[10px] leading-snug text-red-500">
					These clips are now too short for a transition, so this cut renders hard.
					Lengthen either clip, or remove it below.
				</p>

				<button
					class="mt-4 w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:border-red-500/40 hover:text-red-500 transition active:scale-95"
					@click="removeTransition">
					Remove transition
				</button>
			</template>

			<!-- Timeline-item mode (priority when items are selected) -->
			<template v-else-if="timelineItem">
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
							@change="onTargetDurationInput" />
						<p class="mt-1 text-[9px] text-zinc-400 leading-snug">
							Changing duration retimes the clip (same content, new speed) and ripples the track.
						</p>
					</div>
					<label class="flex items-center gap-2 cursor-pointer">
						<input type="checkbox" class="accent-primary" :checked="timelineItem.preservePitch"
							@change="editorStore.setItemPreservePitch(timelineItem!.id, ($event.target as HTMLInputElement).checked)" />
						<span class="text-[11px] text-zinc-600 dark:text-zinc-300">Preserve audio pitch when retimed</span>
					</label>

					<!-- Framing: only meaningful when the clip and the sequence disagree -->
					<div v-if="framingMatters">
						<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1">
							Framing
						</label>
						<div class="flex bg-zinc-100 dark:bg-zinc-800/60 rounded-lg p-0.5">
							<button v-for="m in (['fit', 'fill'] as const)" :key="m"
								class="flex-1 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest transition"
								:class="framingMode === m
									? 'bg-white dark:bg-zinc-700 shadow-sm text-zinc-800 dark:text-white'
									: 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'"
								@click="editorStore.setItemFraming(timelineItem!.id, m, framingPan)">
								{{ m }}
							</button>
						</div>
						<template v-if="framingMode === 'fill'">
							<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mt-2 mb-1">
								Pan
								<span class="normal-case tracking-normal font-mono text-primary ml-1">
									{{ framingPan === 0 ? 'centre' : `${framingPan > 0 ? '+' : ''}${framingPan.toFixed(2)}` }}
								</span>
							</label>
							<input type="range" min="-1" max="1" step="0.05" :value="framingPan"
								class="w-full accent-primary" @change="onPanInput" />
						</template>
						<p class="mt-1 text-[9px] text-zinc-400 leading-snug">
							{{ framingMode === 'fill'
								? 'Crops this clip to the frame. Pan chooses which part survives.'
								: 'Letterboxes this clip inside the frame. Nothing is lost.' }}
						</p>
					</div>

					<!-- Audio gain (mix level applied at export) -->
					<div>
						<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1">
							Gain <span class="normal-case tracking-normal font-mono text-accent ml-1">{{ gainValue.toFixed(2) }}×</span>
						</label>
						<input type="range" min="0" max="2" step="0.05" :value="gainValue"
							class="w-full accent-accent"
							@change="editorStore.setItemGain(timelineItem!.id, parseFloat(($event.target as HTMLInputElement).value))" />
						<p class="mt-1 text-[9px] text-zinc-400 leading-snug">
							Level for this clip in the exported audio mix. 1.0× is unchanged.
						</p>
					</div>

					<!-- Audio fades (applied in preview + export) -->
					<div class="grid grid-cols-2 gap-2">
						<div>
							<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1">
								Fade in (s)
							</label>
							<input type="number" min="0" step="0.1" :value="fadeInValue"
								class="w-full px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-mono text-zinc-800 dark:text-zinc-200 input-focus-ring"
								@change="editorStore.setItemFade(timelineItem!.id, 'in', parseFloat(($event.target as HTMLInputElement).value))" />
						</div>
						<div>
							<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1">
								Fade out (s)
							</label>
							<input type="number" min="0" step="0.1" :value="fadeOutValue"
								class="w-full px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs font-mono text-zinc-800 dark:text-zinc-200 input-focus-ring"
								@change="editorStore.setItemFade(timelineItem!.id, 'out', parseFloat(($event.target as HTMLInputElement).value))" />
						</div>
						<p class="col-span-2 -mt-1 text-[9px] text-zinc-400 leading-snug">
							Audio ramps at the clip's edges — heard in preview and applied at export.
						</p>
					</div>
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
					<img v-if="clip.thumbnailPath" :src="toMediaUrl(clip.thumbnailPath)" class="w-full object-cover" />
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
					<MetaRow label="Kind" :value="asset.kind === 'audio' ? 'Audio' : 'Video'" />
					<MetaRow label="Duration" :value="formatTime(asset.metadata.duration)" mono />
					<template v-if="asset.kind !== 'audio'">
						<MetaRow label="Resolution" :value="`${asset.metadata.width}×${asset.metadata.height}`" mono />
						<MetaRow label="FPS" :value="String(asset.metadata.fps)" mono />
					</template>
					<MetaRow label="Codec" :value="asset.metadata.codec" />
					<MetaRow label="Size" :value="formatSize(asset.metadata.size)" mono />
					<MetaRow v-if="asset.kind !== 'audio'" label="Audio" :value="asset.metadata.hasAudio ? 'Yes' : 'No'" />
					<MetaRow label="Pieces" :value="String(asset.clips.length)" mono />
				</dl>
				<p v-else class="mt-3 text-xs text-zinc-400">Metadata unavailable for this file.</p>

				<!-- Opt-in Gemini extras. Shown on 'error' too: these are optional,
				     and an unrelated step failure must not take away the only way to
				     run them (leaving Retry, which re-runs the default steps). -->
				<div v-if="(asset.preprocessState === 'completed' || asset.preprocessState === 'error') && asset.clips.length > 0" class="mt-5">
					<!-- Scene descriptions are visual (thumbnail-derived) — video only -->
					<template v-if="asset.kind !== 'audio'">
						<button v-if="!hasDescriptions"
							class="w-full px-3 py-2 rounded-xl border border-secondary/40 text-secondary text-xs font-bold hover:bg-secondary/10 transition active:scale-95 disabled:opacity-50"
							:disabled="describing" @click="describe">
							<span class="iconify tabler--sparkles w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
							{{ describing ? 'Describing scenes…' : `Describe scenes (${descriptionModel})` }}
						</button>
						<p v-if="!hasDescriptions" class="mt-1.5 text-[10px] text-zinc-400 leading-snug">
							Generates a one-line description per piece for the context view. Costs tokens.
						</p>
						<div v-else class="flex items-center justify-between gap-2">
							<p v-if="missingDescriptions" class="text-[11px] text-amber-500 font-medium">
								<span class="iconify tabler--alert-triangle w-3 h-3 inline-block align-[-1px]"></span>
								Scene descriptions incomplete
							</p>
							<p v-else class="text-[11px] text-accent font-medium">
								<span class="iconify tabler--check w-3 h-3 inline-block align-[-1px]"></span>
								Scene descriptions ready
							</p>
							<button class="text-[10px] font-bold uppercase tracking-widest text-zinc-400 hover:text-red-500 transition"
								@click="editorStore.clearAssetData(asset.id, 'descriptions')">
								Remove
							</button>
						</div>
						<div v-if="hasDescriptions && missingDescriptions"
							class="mt-2 px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
							<p class="text-[10px] font-medium text-amber-600 dark:text-amber-400 leading-snug">
								<span class="font-mono">{{ missingDescriptions }}</span> of
								<span class="font-mono">{{ descriptionHealth?.describable }}</span> scenes came back with no
								description. The AI editor has no visual context for those spans.
							</p>
							<button
								class="mt-2 w-full px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-widest hover:bg-amber-500/25 transition active:scale-95 disabled:opacity-50"
								:disabled="describing" @click="describe">
								{{ describing ? 'Describing scenes…' : `Describe remaining (${descriptionModel})` }}
							</button>
						</div>
					</template>

					<!-- Opt-in Gemini transcript -->
					<div :class="asset.kind !== 'audio' ? 'mt-3' : ''">
						<button v-if="!hasTranscript"
							class="w-full px-3 py-2 rounded-xl border border-secondary/40 text-secondary text-xs font-bold hover:bg-secondary/10 transition active:scale-95 disabled:opacity-50"
							:disabled="transcribing" @click="transcribe">
							<span class="iconify tabler--file-text w-3.5 h-3.5 inline-block align-[-2px] mr-1"></span>
							{{ transcribing ? 'Transcribing…' : `Transcribe (${transcriptModel})` }}
						</button>
						<p v-if="!hasTranscript" class="mt-1.5 text-[10px] text-zinc-400 leading-snug">
							Adds spoken text to each piece and enriches AI editing context. Costs tokens.
						</p>
						<div v-else class="flex items-center justify-between gap-2">
							<p v-if="badTranscript" class="text-[11px] text-amber-500 font-medium">
								<span class="iconify tabler--alert-triangle w-3 h-3 inline-block align-[-1px]"></span>
								{{ badTranscript.looped ? 'Transcript unreliable' : 'Transcript incomplete' }}
							</p>
							<p v-else class="text-[11px] text-accent font-medium">
								<span class="iconify tabler--check w-3 h-3 inline-block align-[-1px]"></span>
								Transcript ready
							</p>
							<button class="text-[10px] font-bold uppercase tracking-widest text-zinc-400 hover:text-red-500 transition"
								@click="editorStore.clearAssetData(asset.id, 'transcript')">
								Remove
							</button>
						</div>
						<div v-if="badTranscript"
							class="mt-2 px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
							<p v-if="badTranscript.looped"
								class="text-[10px] font-medium text-amber-600 dark:text-amber-400 leading-snug">
								Speech-to-text looped here: one line repeats
								<span class="font-mono">{{ badTranscript.maxRepeatRun }}</span> times across
								<span class="font-mono">{{ formatSpan(badTranscript.loopedSeconds) }}</span> of audio.
								The footage is fine, but the AI editor cannot tell what is said in that span.
							</p>
							<p v-else-if="badTranscript.truncated"
								class="text-[10px] font-medium text-amber-600 dark:text-amber-400 leading-snug">
								Transcription stopped early: speech ends at
								<span class="font-mono">{{ formatSpan(badTranscript.lastSpeechEndSec || 0) }}</span> of
								<span class="font-mono">{{ formatSpan(badTranscript.durationSec || 0) }}</span>.
								The AI editor sees the rest of this file as silence.
							</p>
							<p v-else class="text-[10px] font-medium text-amber-600 dark:text-amber-400 leading-snug">
								A stretch in the middle has no transcript:
								<span class="font-mono">{{ formatSpan(badTranscript.largestGapSec || 0) }}</span> with no
								speech starting at
								<span class="font-mono">{{ formatSpan(badTranscript.gapAtSec || 0) }}</span>.
								The AI editor reads that span as dead air and will cut it.
							</p>
							<p v-if="badTranscript.looped && badTranscript.repeatedText"
								class="mt-1 text-[10px] text-zinc-500 italic truncate" :title="badTranscript.repeatedText">
								“{{ badTranscript.repeatedText }}”
							</p>
							<button
								class="mt-2 w-full px-3 py-1.5 rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-widest hover:bg-amber-500/25 transition active:scale-95 disabled:opacity-50"
								:disabled="retranscribing" @click="editorStore.repairTranscript(asset.id)">
								{{ retranscribing ? 'Re-transcribing…' : `Re-transcribe (${correctionModel})` }}
							</button>
						</div>
					</div>
				</div>

				<!-- Silence / dead-air finder (§5.6) — assistive, review-only -->
				<SilenceFinder v-if="asset.metadata?.hasAudio !== false" :asset-id="asset.id" />
			</template>

			<!-- Nothing selected: the sequence itself is the thing to inspect -->
			<template v-else>
				<h3 class="text-sm font-bold text-zinc-800 dark:text-zinc-200 font-heading">Sequence</h3>
				<p class="mt-0.5 text-[10px] text-zinc-400">The shape everything is exported in.</p>

				<div class="mt-4">
					<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1">
						Frame
						<span class="normal-case tracking-normal font-mono text-primary ml-1">
							{{ frameW }}×{{ frameH }}
						</span>
					</label>
					<div class="grid grid-cols-2 gap-1.5">
						<button v-for="preset in FRAME_PRESETS" :key="preset.label"
							class="px-2 py-1.5 rounded-lg border text-[10px] font-semibold transition active:scale-95"
							:class="frameChosen && isFrame(preset)
								? 'border-primary bg-primary/10 text-primary'
								: 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-primary/40'"
							@click="editorStore.setSequenceFrame(preset.w, preset.h)">
							{{ preset.label }}
							<span class="block font-mono text-[9px] text-zinc-400">{{ preset.w }}×{{ preset.h }}</span>
						</button>
					</div>
					<p class="mt-2 text-[9px] text-zinc-400 leading-snug">
						<span v-if="!frameChosen">Following the footage until you pick one. </span>
						Clips of a different shape are letterboxed unless you set them to fill,
						which you do per clip.
					</p>
				</div>

				<p class="mt-6 text-[10px] text-zinc-400 text-center">
					Select a clip, a media file or a piece to inspect it.
				</p>
			</template>
		</div>
	</div>
</template>

<script setup lang="ts">
import { toMediaUrl } from '@shared/media-url'
import {
	DEFAULT_TRANSITION_SEC, MAX_TRANSITION_SEC, MIN_TRANSITION_SEC
} from '@shared/transitionPlan'
import { transitionLabel } from '@shared/transitionPresets'
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

const gainValue = computed(() => timelineItem.value?.gain ?? 1)
const fadeInValue = computed(() => timelineItem.value?.fadeInSec ?? 0)
const fadeOutValue = computed(() => timelineItem.value?.fadeOutSec ?? 0)

const onSpeedInput = (event: Event) => {
	const value = parseFloat((event.target as HTMLInputElement).value)
	if (timelineItem.value && Number.isFinite(value) && value > 0) {
		editorStore.setItemSpeed(timelineItem.value.id, value)
	}
}

/** Retime: a target on-timeline LENGTH, reached by changing speed. Named for the
 *  store action it calls — a transition slider once bound to this by mistake and
 *  silently did nothing, because it acts on the selected item, not a seam. */
const onTargetDurationInput = (event: Event) => {
	const value = parseFloat((event.target as HTMLInputElement).value)
	if (timelineItem.value && Number.isFinite(value) && value > 0) {
		editorStore.setItemTargetDuration(timelineItem.value.id, value)
	}
}

/** Set by the descriptions step: how many scenes actually got described. */
const descriptionHealth = computed(() => asset.value?.descriptionHealth || null)

// `some` on its own reported "ready" when one batch out of seven survived, and
// hid the Describe button so the run could not be finished. Fall back to it
// only for assets described before coverage was recorded.
const hasDescriptions = computed(() =>
	descriptionHealth.value
		? descriptionHealth.value.described > 0
		: (asset.value?.clips || []).some((c) => !!c.visual)
)

const missingDescriptions = computed(() => {
	const health = descriptionHealth.value
	return health ? Math.max(0, health.describable - health.described) : 0
})

const hasTranscript = computed(() =>
	(asset.value?.clips || []).some((c) => !!c.text)
)

/** Set by the transcript step when speech-to-text looped or stopped early. */
const badTranscript = computed(() => {
	const health = asset.value?.transcriptHealth
	return health && (health.looped || health.truncated || health.hasHole) ? health : null
})

// Each of these buttons spends tokens, and which model it spends them on is
// configurable in Settings — so name it rather than just saying "Gemini".
const transcriptModel = computed(() => editorStore.modelLabelFor('raw-transcript'))
const correctionModel = computed(() => editorStore.modelLabelFor('corrected-transcript'))
const descriptionModel = computed(() => editorStore.modelLabelFor('scene-description'))

const retranscribing = computed(() =>
	!!asset.value && editorStore.assetTasks(asset.value.id)
		.some((t) => t.id.endsWith(':retranscribe') && t.state === 'running')
)

const formatSpan = (seconds: number) => {
	const total = Math.round(seconds)
	const m = Math.floor(total / 60)
	return m >= 1 ? `${m}m ${total % 60}s` : `${total}s`
}

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

// ===== Sequence frame =====

const FRAME_PRESETS = [
	{ label: 'Landscape 16:9', w: 1920, h: 1080 },
	{ label: 'Vertical 9:16', w: 1080, h: 1920 },
	{ label: 'Square 1:1', w: 1080, h: 1080 },
	{ label: 'Portrait 4:5', w: 1080, h: 1350 }
]

const frameW = computed(() => editorStore.sequenceFrame.width)
const frameH = computed(() => editorStore.sequenceFrame.height)
/** Until a frame is picked the shape follows the footage, which is worth saying. */
const frameChosen = computed(() => editorStore.doc?.timelineMeta?.frameChosen === true)
const isFrame = (p: { w: number; h: number }) => p.w === frameW.value && p.h === frameH.value

// ===== Per-clip framing =====

const framingMode = computed(() => timelineItem.value?.framing?.mode ?? 'fit')
const framingPan = computed(() => timelineItem.value?.framing?.pan ?? 0)

/** Only worth showing when the clip's source and the sequence disagree in shape —
 *  otherwise fit and fill are the same picture and the control is noise. */
const framingMatters = computed(() => {
	const item = timelineItem.value
	if (!item) return false
	const asset = editorStore.doc?.media.find((a) => a.id === item.sourceAssetId)
	const w = asset?.metadata?.width
	const h = asset?.metadata?.height
	if (!w || !h) return true // unknown source shape: let the user decide
	return Math.abs(w / h - frameW.value / frameH.value) > 0.01
})

const onPanInput = (event: Event) => {
	const value = parseFloat((event.target as HTMLInputElement).value)
	if (timelineItem.value && Number.isFinite(value)) {
		editorStore.setItemFraming(timelineItem.value.id, 'fill', value)
	}
}

// ===== Seam (transition) mode =====

const seam = computed(() => editorStore.selectedSeam)
const requestedDuration = computed(() =>
	seam.value?.requested?.duration ?? seam.value?.window?.duration ?? DEFAULT_TRANSITION_SEC
)
const clamped = computed(() =>
	!!seam.value?.window && seam.value.window.duration < requestedDuration.value - 1e-6
)
const repeatsFrames = computed(() => {
	const w = seam.value?.window
	return !!w && (w.outgoing.freeze > 0 || w.incoming.freeze > 0)
})
const repeated = computed(() => {
	const w = seam.value?.window
	if (!w) return '—'
	const total = w.outgoing.freeze + w.incoming.freeze
	return total > 0 ? `${total.toFixed(2)}s` : 'none'
})
const alignment = computed(() => {
	const w = seam.value?.window
	if (!w) return '—'
	return Math.abs(w.front - w.back) > 0.01 ? 'slid off centre' : 'centred on the cut'
})

const onTransitionDuration = (event: Event) => {
	const value = parseFloat((event.target as HTMLInputElement).value)
	const current = seam.value
	if (current && Number.isFinite(value)) {
		const kind = current.window?.kind ?? current.requested?.kind
		if (kind) editorStore.setTransition(current.junction.outgoing.id, kind, value)
	}
}

const removeTransition = () => {
	const current = seam.value
	if (!current) return
	editorStore.selectSeam(null)
	editorStore.clearTransition(current.junction.outgoing.id)
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
