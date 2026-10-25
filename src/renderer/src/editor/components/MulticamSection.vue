<template>
	<div v-if="group" class="mt-4 space-y-4" data-testid="multicam-section">
		<!-- Which group, by name (rename in place) -->
		<div class="flex items-center gap-2">
			<span class="iconify tabler--video w-3.5 h-3.5 text-primary shrink-0"></span>
			<input :value="group.name" aria-label="Camera group name"
				class="flex-1 min-w-0 bg-transparent text-xs font-bold text-zinc-800 dark:text-zinc-200 outline-none focus:shadow-[inset_0_-1px_0_rgb(var(--primary))]"
				@change="store.renameMulticam(group!.id, ($event.target as HTMLInputElement).value)" />
			<span class="lbl shrink-0">{{ item.multicam!.role === 'shot' ? 'Shot' : 'Main sound' }}</span>
		</div>

		<!-- A shot: every angle of this moment; click one and the whole shot shows it -->
		<div v-if="item.multicam!.role === 'shot'">
			<p class="lbl mb-1.5">Angle</p>
			<div class="grid grid-cols-2 gap-1.5">
				<button v-for="(a, i) in angleTiles" :key="a.camera.key"
					class="relative rounded-md overflow-hidden bg-stage aspect-video transition disabled:opacity-40 disabled:cursor-not-allowed"
					:class="a.active ? 'ring-2 ring-primary' : 'ring-1 ring-black/10 dark:ring-white/10 hover:ring-primary/50'"
					:disabled="!a.recording"
					:aria-pressed="a.active"
					:title="a.recording ? `Show ${a.camera.name} for this whole shot (Alt+${i + 1})` : `${a.camera.name} was not recording during this shot`"
					@click="!a.active && store.setShotAngle(item.id, i + 1)">
					<img v-if="a.thumb" :src="a.thumb" class="w-full h-full object-cover" />
					<span class="absolute top-1 left-1 min-w-[16px] h-4 px-1 rounded text-[10px] font-bold leading-4"
						:class="a.active ? 'bg-primary text-white' : 'bg-black/60 text-white'">{{ i + 1 }}</span>
					<span class="absolute bottom-0 inset-x-0 px-1.5 py-0.5 text-[10px] font-semibold text-white truncate text-left bg-gradient-to-t from-black/70 to-transparent">{{ a.camera.name }}</span>
				</button>
			</div>
			<p class="mt-1.5 text-[10px] text-zinc-500 leading-snug">Number keys cut at the playhead; Alt + number changes the whole shot.</p>
		</div>

		<!-- The sound under every shot. The user picks; the cleanest is suggested. -->
		<div>
			<p class="lbl mb-1.5">Main sound</p>
			<div class="space-y-1">
				<button v-for="c in soundChoices" :key="c.key"
					class="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left transition"
					:class="isMainSound(c) ? 'bg-primary/10 ring-1 ring-primary/30' : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'"
					:aria-pressed="isMainSound(c)"
					@click="!isMainSound(c) && store.setMulticamSound(group!.id, c.members[0].assetId)">
					<span class="w-3 h-3 rounded-full shrink-0 ring-1"
						:class="isMainSound(c) ? 'bg-primary ring-primary' : 'ring-zinc-400'"></span>
					<span class="flex-1 min-w-0">
						<span class="flex items-center gap-1.5 min-w-0">
							<span class="text-xs font-semibold text-zinc-800 dark:text-zinc-200 truncate">{{ c.name }}</span>
							<span v-if="c.key === suggested" class="shrink-0 text-[9px] font-bold uppercase tracking-wider text-accent">Clearest</span>
						</span>
						<span class="block text-[10px] tabular-nums text-zinc-500 truncate" :title="qualityTitle(c)">{{ qualityLabel(c) }}</span>
					</span>
				</button>
			</div>
		</div>

		<!-- How each camera sits on the group's clock, and nudges when it is a little off -->
		<div>
			<div class="flex items-center mb-1.5">
				<p class="lbl">Sync</p>
				<div class="flex-1"></div>
				<button class="text-[11px] font-semibold text-zinc-500 hover:text-primary transition disabled:opacity-40"
					:disabled="!!store.multicamBusy" @click="store.resyncMulticam(group!.id)">
					{{ store.multicamBusy ? store.multicamBusy.label : 'Re-sync' }}
				</button>
			</div>
			<div v-for="c in cameras" :key="c.key" class="flex items-center gap-2.5 py-1">
				<span class="w-1.5 h-1.5 rounded-full shrink-0" :class="CONFIDENCE[worst(c)].dot"
					:title="CONFIDENCE[worst(c)].title"></span>
				<span class="flex-1 min-w-0">
					<span class="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 truncate">{{ c.name }}</span>
					<span class="block text-[10px] tabular-nums text-zinc-500 truncate" :title="isReference(c) ? '' : driftTitle(drift(c))">
						<template v-if="isReference(c)">reference</template>
						<template v-else>{{ signed(c.members[0].offset, 3) }} s<template v-if="drift(c)"> · drift {{ signed(drift(c), 0) }} ppm</template></template>
						<template v-if="c.members.length > 1"> · {{ c.members.length }} files</template>
					</span>
				</span>
				<template v-if="!isReference(c)">
					<button class="w-6 h-6 flex items-center justify-center rounded text-zinc-500 hover:text-primary hover:bg-primary/10"
						:title="`${c.name} one frame earlier`" :aria-label="`${c.name} one frame earlier`"
						@click="store.nudgeMulticamMember(group!.id, c.members[0].assetId, -frame)">
						<span class="iconify tabler--chevron-left w-3.5 h-3.5"></span>
					</button>
					<button class="w-6 h-6 flex items-center justify-center rounded text-zinc-500 hover:text-primary hover:bg-primary/10"
						:title="`${c.name} one frame later`" :aria-label="`${c.name} one frame later`"
						@click="store.nudgeMulticamMember(group!.id, c.members[0].assetId, frame)">
						<span class="iconify tabler--chevron-right w-3.5 h-3.5"></span>
					</button>
				</template>
			</div>
			<p v-if="unsure" class="mt-1 text-[10px] leading-snug text-amber-500">
				{{ unsure }}
			</p>
		</div>

		<button class="text-[11px] font-semibold text-zinc-500 hover:text-red-500 transition"
			title="Every clip stays where it is, as an ordinary clip"
			@click="store.ungroupMulticam(group!.id)">
			Ungroup cameras
		</button>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MulticamSync, TimelineItem } from '@shared/types'
import {
	anglesOf, camerasOf, cameraSound, groupOfItem, groupTimeAt, memberAt, recordedPieces, referenceOf,
	soundChoicesOf, soundScore, toSourceTime, type Camera
} from '@shared/multicam'
import { toMediaUrl } from '@shared/media-url'
import { useEditorStore } from '../../stores/editorStore'

const props = defineProps<{ item: TimelineItem }>()
const store = useEditorStore()

const group = computed(() => store.doc ? groupOfItem(props.item, store.doc.multicams) : undefined)
const media = computed(() => store.doc?.media ?? [])
const frame = computed(() => 1 / (store.doc?.timelineMeta.fps || 30))
const cameras = computed(() => (group.value ? camerasOf(group.value, media.value) : []))

const CONFIDENCE = {
	strong: { dot: 'bg-accent', title: 'Matched strongly by sound along the whole recording' },
	weak: { dot: 'bg-amber-500', title: 'Matched by sound in only a few places, or placed after its camera’s previous file: check it on a moment with clear lip movement' },
	failed: { dot: 'bg-red-500', title: 'The sound could not decide; this offset is from recording times or a guess' }
} as const

/** Each angle at the start of this shot: a still near that moment, and whether it recorded any of the shot. */
const angleTiles = computed(() => {
	const g = group.value
	if (!g) return []
	const start = groupTimeAt(props.item, g, props.item.timelineStart)
	return anglesOf(g, media.value).map((camera) => {
		const member = start === null ? undefined : memberAt(camera, start, media.value) ?? camera.members[0]
		const asset = media.value.find((a) => a.id === member?.assetId)
		const s0 = member && start !== null ? toSourceTime(member, start) : 0
		const near = asset?.filmstrip?.length
			? asset.filmstrip.reduce((best, f) => (Math.abs(f.time - s0) < Math.abs(best.time - s0) ? f : best))
			: undefined
		const still = near?.thumbnailPath ?? asset?.clips.find((c) => c.thumbnailPath)?.thumbnailPath
		return {
			camera,
			active: camera.members.some((m) => m.assetId === props.item.sourceAssetId),
			recording: recordedPieces(props.item, g, camera, media.value).length > 0,
			thumb: still ? toMediaUrl(still) : undefined
		}
	})
})

const soundChoices = computed(() => (group.value ? soundChoicesOf(group.value, media.value) : []))
const isMainSound = (c: Camera) => c.members.some((m) => m.assetId === group.value?.soundAssetId)
const suggested = computed(() =>
	[...soundChoices.value].sort((a, b) => soundScore(cameraSound(b, media.value)) - soundScore(cameraSound(a, media.value)))[0]?.key)

const qualityLabel = (c: Camera) => {
	const q = cameraSound(c, media.value)
	if (!q) return ''
	const level = `voices ${Math.round(q.snrDb)} dB over the room`
	return q.clipped > 0.0005 ? `clips · ${level}` : level
}
const qualityTitle = (c: Camera) => {
	const q = cameraSound(c, media.value)
	return q
		? `Voices stand ${q.snrDb.toFixed(1)} dB above the room; ${(q.clipped * 100).toFixed(2)} % of samples clip${c.members.length > 1 ? ' (its worst file)' : ''}`
		: 'Not measured'
}

const isReference = (c: Camera) => {
	const ref = group.value ? referenceOf(group.value) : undefined
	return !!ref && c.members.some((m) => m.assetId === ref.assetId)
}
/** The camera's drift: the length-weighted mean of its files' measurements. */
const drift = (c: Camera) => {
	const len = (id: string) => Math.max(1, media.value.find((a) => a.id === id)?.metadata?.duration ?? 1)
	const total = c.members.reduce((s, m) => s + len(m.assetId), 0)
	return Math.round(c.members.reduce((s, m) => s + m.sync.driftPpm * len(m.assetId), 0) / total)
}
const ORDER: MulticamSync['confidence'][] = ['strong', 'weak', 'failed']
const worst = (c: Camera) => c.members.map((m) => m.sync.confidence)
	.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), 'strong' as MulticamSync['confidence'])

const signed = (n: number, digits: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}`
const driftTitle = (ppm: number) => ppm
	? `Its clock runs ${Math.abs(ppm)} parts per million ${ppm > 0 ? 'fast' : 'slow'}: ${(Math.abs(ppm) * 3.6).toFixed(0)} ms an hour, corrected on every shot.`
	: 'No clock drift measured.'

const unsure = computed(() => {
	const off = cameras.value.filter((c) => worst(c) !== 'strong')
	if (!off.length) return ''
	return `${off.map((c) => c.name).join(', ')}: check on a moment with clear lip movement, and nudge a frame at a time if it is off.`
})
</script>
