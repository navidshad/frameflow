<template>
	<div class="relative">
		<button
			class="flex items-center gap-1 text-[10px] font-semibold transition"
			:class="spec ? 'text-accent-light hover:text-accent' : 'text-zinc-400 hover:text-zinc-300'"
			:title="spec ? `${spec.label}: ${spec.description} Click to change.` : 'Say what this track is for: voice, music or sound effects'"
			:aria-expanded="open"
			@click.stop="open = !open">
			{{ spec?.label ?? 'Role' }}
			<span v-if="spec?.ducks" class="text-[8px] font-bold tracking-wider text-accent-light/70">DUCKS</span>
		</button>
		<template v-if="open">
			<div class="fixed inset-0 z-40" @click="open = false"></div>
			<div class="absolute left-0 top-5 z-50 w-56 pop py-1 animate-menu origin-top-left">
				<button v-for="r in TRACK_ROLES" :key="r.id"
					class="w-full px-3 py-1.5 text-left hover:bg-primary/5 transition flex items-start gap-2"
					@click="choose(r.id)">
					<span class="iconify tabler--check w-3 h-3 mt-0.5 shrink-0" :class="track.role === r.id ? 'text-primary' : 'opacity-0'"></span>
					<span>
						<span class="block text-[11px] font-semibold text-zinc-800 dark:text-zinc-100">{{ r.label }}</span>
						<span class="block text-[10px] leading-snug text-zinc-500">{{ r.description }}</span>
					</span>
				</button>
				<button v-if="track.role" class="w-full px-3 py-1.5 text-left text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-primary/5 transition border-t hair-t mt-1"
					@click="choose(undefined)">
					No role
				</button>
			</div>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Track } from '@shared/types'
import { roleSpec, TRACK_ROLES, type TrackRole } from '@shared/audio'
import { useEditorStore } from '../../../stores/editorStore'

/** What an audio track is for. The label sits beside the track's name; this is its menu. */
const props = defineProps<{ track: Track }>()
const store = useEditorStore()
const open = ref(false)
const spec = computed(() => roleSpec(props.track.role))

const choose = (role: TrackRole | undefined) => {
	store.setTrackRole(props.track.id, role)
	open.value = false
}
</script>
