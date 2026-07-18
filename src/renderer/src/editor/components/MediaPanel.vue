<template>
	<div class="glass-card rounded-2xl flex flex-col min-h-0 overflow-hidden">
		<!-- Panel header -->
		<div class="px-4 pt-4 pb-2 flex items-center justify-between shrink-0">
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Media</span>
			<div class="flex items-center gap-1">
				<SlimTooltip text="Add local video" placement="bottom">
					<button
						class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-500 hover:text-primary hover:bg-primary/10 transition active:scale-95"
						@click="editorStore.addLocalMedia()">
						<span class="iconify tabler--plus w-4 h-4"></span>
					</button>
				</SlimTooltip>
				<SlimTooltip text="Import from URL" placement="bottom">
					<button
						class="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-500 hover:text-primary hover:bg-primary/10 transition active:scale-95"
						@click="showImportModal = true">
						<span class="iconify tabler--link w-4 h-4"></span>
					</button>
				</SlimTooltip>
			</div>
		</div>

		<!-- Dependency banner -->
		<div v-if="!editorStore.deps.scenedetect"
			class="mx-3 mb-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 shrink-0">
			<p class="text-[11px] font-medium text-amber-600 dark:text-amber-400 leading-snug">
				<span class="iconify tabler--alert-triangle w-3 h-3 inline-block align-[-1px] mr-1"></span>
				Scene detection needs PySceneDetect. Media can still be imported and previewed.
			</p>
		</div>

		<!-- Asset list -->
		<div class="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-3 pb-2">
			<!-- Empty state -->
			<div v-if="editorStore.isEmpty && !hasActiveImports"
				class="h-full flex flex-col items-center justify-center text-center gap-4 py-8">
				<div
					class="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
					<span class="iconify tabler--movie w-7 h-7"></span>
				</div>
				<div>
					<p class="text-sm font-bold text-zinc-800 dark:text-zinc-200">No media yet</p>
					<p class="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed px-2">
						Add a video and it will be broken into selectable scene pieces.
					</p>
				</div>
				<div class="flex flex-col gap-2 w-full px-2">
					<button
						class="w-full px-3 py-2 rounded-xl bg-primary text-white text-xs font-bold shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-95"
						@click="editorStore.addLocalMedia()">
						Add local video
					</button>
					<button
						class="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:border-primary/40 hover:text-primary transition active:scale-95"
						@click="showImportModal = true">
						Import from URL
					</button>
				</div>
			</div>

			<template v-else>
				<!-- In-flight URL imports (no asset row yet) -->
				<div v-for="(imp, assetId) in editorStore.urlImports" :key="'imp-' + assetId"
					class="mb-2 p-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white/50 dark:bg-zinc-900/50">
					<p class="text-xs font-medium text-zinc-600 dark:text-zinc-300 truncate">{{ imp.url || 'Downloading…' }}</p>
					<div class="mt-2 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
						<div class="h-full bg-primary rounded-full transition-all duration-300"
							:style="{ width: `${imp.percent}%` }"></div>
					</div>
					<p class="mt-1 text-[10px] font-mono text-zinc-400">{{ Math.round(imp.percent) }}%</p>
				</div>

				<AssetRow v-for="asset in editorStore.assets" :key="asset.id" :asset="asset"
					:active="asset.id === editorStore.selectedAssetId"
					@select="editorStore.selectAsset(asset.id)" />
			</template>
		</div>

		<!-- Clip tray for the selected asset -->
		<ClipTray v-if="editorStore.selectedAsset" class="shrink-0" />

		<ImportMediaModal v-model="showImportModal" />
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import SlimTooltip from '../../components/SlimTooltip.vue'
import { useEditorStore } from '../../stores/editorStore'
import AssetRow from './AssetRow.vue'
import ClipTray from './ClipTray.vue'
import ImportMediaModal from './ImportMediaModal.vue'

const editorStore = useEditorStore()
const showImportModal = ref(false)

const hasActiveImports = computed(() => Object.keys(editorStore.urlImports).length > 0)
</script>
