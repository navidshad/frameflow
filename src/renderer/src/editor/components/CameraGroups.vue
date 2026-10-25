<template>
	<div v-if="visible" class="mb-2 space-y-1.5 min-w-0" data-testid="camera-groups">
		<!-- A sync running: what it is doing -->
		<div v-if="store.multicamBusy" class="p-3 rounded-xl bg-primary/5 dark:bg-primary/10 ring-1 ring-primary/25">
			<p class="text-xs font-bold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
				<span class="iconify tabler--wave-sine w-3.5 h-3.5 text-primary"></span>
				Syncing cameras by sound
			</p>
			<div class="mt-2 h-1 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
				<div class="h-full rounded-full bg-primary transition-all duration-300"
					:style="{ width: `${Math.max(4, store.multicamBusy.fraction * 100)}%` }"></div>
			</div>
			<p class="mt-1 text-[10px] font-mono text-zinc-500">{{ store.multicamBusy.label }}</p>
		</div>

		<p v-if="store.multicamError" class="px-1 text-[11px] text-red-500 leading-snug">
			{{ store.multicamError }}
		</p>

		<!-- Suggestions: files that look like one moment from several cameras -->
		<div v-for="s in store.cameraGroupSuggestions" :key="s.assetIds.join('|')"
			class="p-3 rounded-xl ring-1"
			:class="s.strength === 'strong' ? 'bg-primary/5 dark:bg-primary/10 ring-primary/25' : 'bg-zinc-100/70 dark:bg-zinc-900/60 ring-zinc-200 dark:ring-zinc-800'"
			data-testid="camera-suggestion">
			<p class="text-xs font-bold text-zinc-800 dark:text-zinc-200 flex items-center gap-1.5">
				<span class="iconify tabler--video w-3.5 h-3.5" :class="s.strength === 'strong' ? 'text-primary' : 'text-zinc-400'"></span>
				{{ s.assetIds.length }} files look like one recording
			</p>
			<ul class="mt-1 text-[11px] text-zinc-600 dark:text-zinc-300 font-mono">
				<li v-for="id in s.assetIds" :key="id" class="truncate" :title="nameOf(id)">{{ nameOf(id) }}</li>
			</ul>
			<p class="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">{{ capitalize(s.reasons[0]) }}.</p>
			<div class="mt-2 flex items-center gap-2">
				<button class="px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-bold whitespace-nowrap hover:bg-primary-dark transition active:scale-95 disabled:opacity-40"
					:disabled="!!store.multicamBusy"
					@click="store.buildMulticam(s.assetIds)">
					Sync as multicam
				</button>
				<button class="px-2 py-1 rounded-lg text-[11px] font-semibold whitespace-nowrap text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition"
					@click="store.dismissCameraGroupSuggestion(s)">
					Not now
				</button>
			</div>
		</div>

		<!-- Groups this project has -->
		<div v-for="g in groups" :key="g.id"
			class="p-3 rounded-xl hover:bg-zinc-100/70 dark:hover:bg-zinc-900/50 transition"
			data-testid="camera-group">
			<div class="flex items-start gap-3">
				<div class="w-16 h-10 rounded-lg overflow-hidden shrink-0 grid gap-px bg-zinc-300 dark:bg-zinc-700"
					:style="{ gridTemplateColumns: `repeat(${Math.min(2, angleCount(g))}, 1fr)` }">
					<div v-for="c in angles(g).slice(0, 4)" :key="c.key" class="bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
						<img v-if="thumb(c.members[0].assetId)" :src="thumb(c.members[0].assetId)" class="w-full h-full object-cover" loading="lazy" />
					</div>
				</div>
				<div class="flex-1 min-w-0">
					<p class="text-xs font-bold text-zinc-800 dark:text-zinc-200 truncate">{{ g.name }}</p>
					<p class="text-[10px] text-zinc-500 truncate mt-0.5">
						{{ cameras(g).map((c) => c.members.length > 1 ? `${c.name} (${c.members.length} files)` : c.name).join(' · ') }}
					</p>
					<p class="text-[10px] text-zinc-500 truncate">
						<span class="iconify tabler--microphone w-3 h-3 align-[-2px]"></span>
						{{ soundCameraOf(g, media)?.name }}
						<span v-if="unsure(g)" class="ml-1 text-amber-500 font-semibold">· check sync</span>
					</p>
				</div>
			</div>
			<div class="mt-2 flex items-center gap-1.5">
				<button v-if="!placed(g.id)"
					class="px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-bold whitespace-nowrap hover:bg-primary-dark transition active:scale-95"
					@click="store.placeMulticam(g.id)">
					Add to timeline
				</button>
				<button class="px-2 py-1 rounded-lg text-[11px] font-semibold text-zinc-500 hover:text-primary transition disabled:opacity-40"
					:disabled="!!store.multicamBusy"
					@click="store.resyncMulticam(g.id)">
					Re-sync
				</button>
				<button class="px-2 py-1 rounded-lg text-[11px] font-semibold text-zinc-500 hover:text-red-500 transition"
					title="The clips stay where they are, as ordinary clips"
					@click="store.ungroupMulticam(g.id)">
					Ungroup
				</button>
			</div>
		</div>

		<!-- Group by hand -->
		<div class="relative">
			<button v-if="candidates.length >= 2"
				class="w-full px-3 py-1.5 rounded-lg text-[11px] font-semibold text-zinc-500 hover:text-primary hover:bg-primary/5 transition flex items-center gap-1.5"
				:disabled="!!store.multicamBusy"
				@click="picking = !picking">
				<span class="iconify tabler--video-plus w-3.5 h-3.5"></span>
				Group cameras…
			</button>
			<div v-if="picking" class="pop absolute left-0 right-0 z-30 mt-1 p-3" @keydown.esc="picking = false">
				<p class="lbl mb-2">Recorded at the same time</p>
				<label v-for="a in candidates" :key="a.id" class="flex items-center gap-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 cursor-pointer">
					<input v-model="chosen" type="checkbox" :value="a.id" class="accent-primary" />
					<span class="iconify w-3.5 h-3.5 text-zinc-400" :class="a.kind === 'audio' ? 'tabler--microphone' : 'tabler--video'"></span>
					<span class="truncate">{{ a.name }}</span>
				</label>
				<p class="mt-2 text-[10px] text-zinc-500 leading-snug">
					They are synced by their sound. The first camera is the one the others are measured against.
				</p>
				<div class="mt-2 flex justify-end gap-2">
					<button class="px-2 py-1 text-[11px] font-semibold text-zinc-500" @click="picking = false">Cancel</button>
					<button class="px-2.5 py-1 rounded-lg bg-primary text-white text-[11px] font-bold disabled:opacity-40"
						:disabled="chosen.length < 2 || !chosenHasCamera"
						@click="makeChosen">
						Sync {{ chosen.length || '' }} files
					</button>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MulticamGroup } from '@shared/types'
import { anglesOf, camerasOf, soundCameraOf } from '@shared/multicam'
import { toMediaUrl } from '@shared/media-url'
import { useEditorStore } from '../../stores/editorStore'

const store = useEditorStore()
const picking = ref(false)
const chosen = ref<string[]>([])

const groups = computed(() => store.doc?.multicams ?? [])
const media = computed(() => store.doc?.media ?? [])

/** Recordings not already in a group: what a new group can be made of. */
const candidates = computed(() => {
	const taken = new Set(groups.value.flatMap((g) => g.members.map((m) => m.assetId)))
	return media.value.filter((a) => (a.kind === 'video' || a.kind === 'audio') && !a.synth && !a.generated && !taken.has(a.id) && a.metadata?.duration)
})
const chosenHasCamera = computed(() => chosen.value.some((id) => media.value.find((a) => a.id === id)?.kind === 'video'))

const visible = computed(() =>
	!!store.multicamBusy || !!store.multicamError || store.cameraGroupSuggestions.length > 0 ||
	groups.value.length > 0 || candidates.value.filter((a) => a.kind === 'video').length >= 2)

const nameOf = (id: string) => media.value.find((a) => a.id === id)?.name ?? id
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
const angles = (g: MulticamGroup) => anglesOf(g, media.value)
const cameras = (g: MulticamGroup) => camerasOf(g, media.value)
const angleCount = (g: MulticamGroup) => Math.max(1, angles(g).length)
const unsure = (g: MulticamGroup) => g.members.some((m) => m.sync.confidence !== 'strong')
const placed = (groupId: string) => (store.doc?.timeline ?? []).some((i) => i.multicam?.groupId === groupId)

const thumb = (assetId: string) => {
	const asset = media.value.find((a) => a.id === assetId)
	const path = asset?.clips.find((c) => c.thumbnailPath)?.thumbnailPath ?? asset?.filmstrip?.[0]?.thumbnailPath
	return path ? toMediaUrl(path) : undefined
}

const makeChosen = () => {
	const ids = [...chosen.value]
	picking.value = false
	chosen.value = []
	store.buildMulticam(ids)
}
</script>
