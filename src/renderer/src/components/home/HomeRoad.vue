<template>
	<section class="flex flex-col flex-1 min-w-0 transition-colors" :class="dropping ? 'rounded-[10px] px-6 pt-8 pb-6 -ml-6 ' + dropClass : ''"
		:aria-label="road.name" @dragenter.prevent="$emit('drag', true)" @dragover.prevent="$emit('drag', true)" @dragleave="onLeave" @drop.prevent="onDrop">
		<div class="flex items-center gap-3.5">
			<span class="w-11 h-11 rounded-[10px] flex items-center justify-center" :class="road.tile">
				<span class="iconify w-[22px] h-[22px]" :class="road.icon"></span>
			</span>
			<div>
				<h2 class="font-heading font-black text-[28px] tracking-[-0.02em] leading-none">{{ road.name }}</h2>
				<div class="mt-1 text-[11px] font-semibold" :class="road.text">{{ road.where }}</div>
			</div>
		</div>

		<!-- Drop hover state: the whole side becomes the target -->
		<div v-if="dropping" class="flex-1 flex flex-col items-center justify-center text-center gap-3 min-h-[260px]">
			<span class="iconify tabler--download w-9 h-9" :class="road.text"></span>
			<div class="font-heading font-bold text-[22px]">{{ road.dropTitle }}</div>
			<div class="text-xs text-zinc-500 dark:text-zinc-400 max-w-[380px] leading-normal">{{ road.dropNote }}</div>
		</div>

		<template v-else>
			<p class="mt-3.5 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300 min-h-[44px]">{{ road.desc }}</p>

			<div class="mt-5 flex items-center gap-[18px]">
				<button class="inline-flex items-center justify-center gap-2 h-10 px-[18px] rounded-md text-[13px] font-semibold text-white transition-colors disabled:opacity-50"
					:class="road.fill" :disabled="busy" @click="$emit('new')">
					<span class="iconify tabler--plus w-3.5 h-3.5"></span>{{ road.cta }}
				</button>
				<button class="inline-flex items-center gap-[7px] h-10 text-xs font-semibold text-zinc-700 dark:text-zinc-200 hover:text-primary transition-colors disabled:opacity-50" :disabled="busy" @click="$emit('add')">
					<span class="iconify tabler--paperclip w-3.5 h-3.5"></span>{{ road.add }}
				</button>
				<button v-if="road.kind === 'video'" class="inline-flex items-center gap-[7px] h-10 text-xs font-semibold text-zinc-700 dark:text-zinc-200 hover:text-primary transition-colors disabled:opacity-50" :disabled="busy" @click="$emit('link')">
					<span class="iconify tabler--link w-3.5 h-3.5"></span>From link
				</button>
			</div>
			<p class="mt-2 text-xs" :class="dropError ? 'text-amber-600 dark:text-amber-400' : 'text-zinc-500'">{{ dropError || road.drop }}</p>

			<!-- Recent -->
			<template v-if="threads.length">
				<div class="mt-[34px] flex items-baseline gap-2.5">
					<h3 class="lbl !text-zinc-900 dark:!text-zinc-50">Recent</h3>
					<span class="font-mono text-[11px] text-zinc-500">{{ threads.length }}</span>
					<div class="flex-1"></div>
					<button v-if="threads.length > LIMIT" class="text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:text-primary transition-colors" @click="all = !all">
						{{ all ? 'Show fewer' : 'See all' }}
					</button>
				</div>
				<div class="mt-2.5 hair-t">
					<div v-for="t in shown" :key="t.id"
						class="group flex items-center gap-3 h-14 hair-b outline-none transition-colors focus-visible:bg-primary/5"
						:class="isLegacy(t) ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-zinc-900/[0.03] dark:hover:bg-white/[0.03]'"
						:role="isLegacy(t) ? undefined : 'link'" :tabindex="isLegacy(t) ? undefined : 0"
						@click="!isLegacy(t) && $emit('open', t.id)" @keydown.enter.self="!isLegacy(t) && $emit('open', t.id)">
						<span class="w-12 h-8 rounded shrink-0 flex items-center justify-center" :class="road.tile">
							<span class="iconify w-4 h-4" :class="road.icon"></span>
						</span>
						<div class="flex-1 min-w-0">
							<div class="font-semibold truncate transition-colors" :class="isLegacy(t) ? '' : 'group-hover:text-primary'">{{ t.title }}</div>
							<div class="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">{{ lastMessage(t) }}</div>
						</div>
						<span v-if="t.missing" class="text-[11px] font-semibold text-red-500 dark:text-red-400" title="Artifacts folder not found. Some media or generated files may be unavailable.">Missing files</span>
						<span v-else-if="isLegacy(t)" class="text-[11px] font-semibold text-amber-600 dark:text-amber-400" title="Made by the retired AI video pipeline. Video editing now happens in a timeline project.">Unsupported</span>
						<span v-else-if="road.kind === 'image' && t.versionCounter" class="text-[11px] font-semibold" :class="road.text">v.{{ t.versionCounter }}</span>
						<span class="w-[92px] text-right text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">{{ formatDate(t.updatedAt) }}</span>
						<button class="btn-icon shrink-0 hover:!text-red-500 hover:!bg-red-500/10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
							title="Delete project" aria-label="Delete project" @click.stop="$emit('delete', t.id)">
							<span class="iconify tabler--trash w-4 h-4"></span>
						</button>
					</div>
				</div>
			</template>
			<p v-else class="mt-[34px] hair-t pt-4 text-sm leading-normal text-zinc-500 dark:text-zinc-400">{{ road.empty }}</p>
		</template>
	</section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { isLegacyVideoThread } from '@shared/legacy'
import type { DroppedFile, Road } from '@shared/homeRoads'

const LIMIT = 4

const props = defineProps<{
	kind: Road
	threads: any[]
	dropping: boolean
	dropError?: string
	busy?: boolean
}>()

const emit = defineEmits<{
	(e: 'new'): void
	(e: 'add'): void
	(e: 'link'): void
	(e: 'open', id: string): void
	(e: 'delete', id: string): void
	(e: 'drag', over: boolean): void
	(e: 'drop', files: DroppedFile[]): void
}>()

/** Images are violet, as the AI is everywhere else; Video is the primary blue. */
const ROADS = {
	image: {
		kind: 'image', name: 'Images', where: 'Opens the image graph', icon: 'tabler--photo',
		tile: 'bg-secondary/15 text-secondary-dark dark:text-secondary-light', text: 'text-secondary-dark dark:text-secondary-light',
		fill: 'bg-secondary-dark hover:bg-secondary',
		desc: 'Generate and edit images on a graph. Every version is a node you can branch from.',
		cta: 'New image project', add: 'Add images', drop: 'or drop images, or a reference video, on this side',
		dropTitle: 'Drop to start an image project', dropNote: 'The graph opens with your images attached and the chat focused.',
		empty: 'No image projects yet. Start with a prompt, or drop a few images to edit.'
	},
	video: {
		kind: 'video', name: 'Video', where: 'Opens the timeline editor', icon: 'tabler--timeline',
		tile: 'bg-primary/15 text-primary', text: 'text-primary', fill: 'bg-primary hover:bg-primary-dark',
		desc: 'Cut, caption, add sound and motion on a timeline. Chat with the editor while you watch.',
		cta: 'New video project', add: 'Add video', drop: 'or drop footage on this side · blank timeline if you add nothing',
		dropTitle: 'Drop to start a video project', dropNote: 'The editor opens with the video on the timeline and the chat focused. Preparing the footage runs in the background.',
		empty: 'No video projects yet. Start a blank timeline, or add the footage you have.'
	}
} as const

const road = computed(() => ROADS[props.kind])
const dropClass = computed(() => props.kind === 'video'
	? 'bg-primary/[0.07] shadow-[inset_0_0_0_1px_rgb(96_165_250/0.55)]'
	: 'bg-secondary/[0.07] shadow-[inset_0_0_0_1px_rgb(167_139_250/0.55)]')

const all = ref(false)
const shown = computed(() => all.value ? props.threads : props.threads.slice(0, LIMIT))
const isLegacy = (t: any) => isLegacyVideoThread(t)

const lastMessage = (t: any) => t.messages?.length ? t.messages[t.messages.length - 1].content : 'No messages yet'
const formatDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

// dragleave also fires when the pointer moves onto a child; only a true exit ends the hover.
const onLeave = (e: DragEvent) => {
	if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) emit('drag', false)
}

const onDrop = (e: DragEvent) => {
	const api = (window as any).api
	const files: DroppedFile[] = Array.from(e.dataTransfer?.files ?? []).map((f) => ({ name: f.name, path: api.pathForFile(f) }))
	emit('drag', false)
	emit('drop', files.filter((f) => f.path))
}
</script>
