<template>
	<SectionHeader title="Usage and pricing" description="The prices FrameFlow uses to show what each AI turn cost." />

	<SettingsGroup title="Model pricing · USD per 1M tokens">
		<template #action>
			<button class="btn-text !h-auto !px-0 !text-[#52525b] dark:!text-[#c9cad2]" @click="reset">Reset pricing</button>
		</template>
		<div class="overflow-x-auto">
			<div class="min-w-[560px]">
				<div :class="COLS" class="gap-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
					<span>Model</span><span>Input</span><span>Output</span><span>Output image</span><span>Input audio</span>
				</div>
				<div v-for="(pricing, name) in settings.pricing" :key="name" :class="COLS" class="gap-3 py-2.5 hair-t items-center text-xs">
					<div class="min-w-0">
						<div class="font-semibold truncate" :title="String(name)">{{ labels[name]?.label || name }}</div>
					</div>
					<label class="flex items-center gap-1 font-mono"><span class="text-zinc-400">$</span>
						<input type="number" step="0.01" v-model.number="pricing.input.standard" class="field !w-full font-mono !py-1" @change="save" />
					</label>
					<label class="flex items-center gap-1 font-mono"><span class="text-zinc-400">$</span>
						<input type="number" step="0.01" v-model.number="pricing.output.standard" class="field !w-full font-mono !py-1" @change="save" />
					</label>
					<label v-if="pricing.output.image !== undefined" class="flex items-center gap-1 font-mono"><span class="text-zinc-400">$</span>
						<input type="number" step="0.0001" v-model.number="pricing.output.image" class="field !w-full font-mono !py-1" @change="save" />
					</label>
					<span v-else class="text-zinc-400 font-mono opacity-40">—</span>
					<label v-if="pricing.input.audio !== undefined" class="flex items-center gap-1 font-mono"><span class="text-zinc-400">$</span>
						<input type="number" step="0.01" v-model.number="pricing.input.audio" class="field !w-full font-mono !py-1" @change="save" />
					</label>
					<span v-else class="text-zinc-400 font-mono opacity-40">—</span>
				</div>
			</div>
		</div>
		<p class="mt-4 text-xs leading-normal text-zinc-500 dark:text-zinc-400">
			Costs in each project header are worked out from these prices. Claude Code runs on your own plan and is not priced here.
		</p>
	</SettingsGroup>
</template>

<script setup lang="ts">
import { dialog } from '../../composables/useDialog'
import SectionHeader from './SectionHeader.vue'
import SettingsGroup from './SettingsGroup.vue'
import { useModelSettings } from './useModelSettings'

const COLS = 'grid grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))]'
const { settings, labels, save, resetPricing } = useModelSettings()

const reset = async () => {
	const ok = await dialog.confirm({ title: 'Reset pricing', message: 'Reset model pricing to defaults?', confirmLabel: 'Reset' })
	if (ok) await resetPricing()
}
</script>
