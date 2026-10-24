<template>
	<SectionHeader title="Video editing"
		description="Which model does each job in the timeline editor. Every job lists only the models that can do it. The chat model is picked in the chat box." />

	<SettingsGroup title="Models by job">
		<SettingsRow title="Transcripts" top
			description="Speech to text with word timings, in two passes: a fast first pass, then a clean-up.">
			<template #aside>
				<div class="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
					<span class="iconify tabler--wave-square w-3.5 h-3.5"></span>Needs audio, so only Gemini models are listed
				</div>
			</template>
			<div class="grid grid-cols-2 gap-4">
				<ModelPicker v-bind="common" :models="withCurrent(hearing, 'raw-transcript')" label="Transcript first pass model" hint="first pass"
					:model-value="settings.selection['raw-transcript'] ?? null" @update:model-value="setOps(['raw-transcript'], $event)" />
				<ModelPicker v-bind="common" :models="withCurrent(hearing, 'corrected-transcript')" align-right label="Transcript clean-up model" hint="clean-up"
					:model-value="settings.selection['corrected-transcript'] ?? null" @update:model-value="setOps(['corrected-transcript'], $event)" />
			</div>
		</SettingsRow>

		<SettingsRow title="Scene descriptions" top
			description="A short line for each scene, read from its frames. Search and the editor agent use them.">
			<ModelPicker v-bind="common" :models="everything" label="Scene description model"
				:hint="priceHint(settings.pricing, settings.selection['scene-description'])"
				:model-value="settings.selection['scene-description'] ?? null" @update:model-value="setOps(['scene-description'], $event)" />
		</SettingsRow>
	</SettingsGroup>

	<div class="mt-6">
		<button class="btn-text !px-0 !text-[#52525b] dark:!text-[#c9cad2]" @click="reset">Reset models to defaults</button>
	</div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { allModels, audioModels, priceHint } from '@shared/modelPickers'
import { dialog } from '../../composables/useDialog'
import ModelPicker from './ModelPicker.vue'
import SectionHeader from './SectionHeader.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingsRow from './SettingsRow.vue'
import { useModelSettings } from './useModelSettings'

const { settings, labels, setOps, resetModels } = useModelSettings()
const hearing = computed(() => audioModels(settings.value.pricing))
/** A saved choice that is not in the list stays in it, so nothing silently changes. */
const withCurrent = (list: string[], op: string) => {
	const cur = settings.value.selection[op]
	return cur && !list.includes(cur) ? [...list, cur] : list
}
const everything = computed(() => allModels(settings.value.pricing))
const common = computed(() => ({
	pricing: settings.value.pricing,
	labels: labels.value,
	footnote: 'Price per 1M input tokens.'
}))

const reset = async () => {
	const ok = await dialog.confirm({ title: 'Reset models', message: 'Reset model selection to defaults?', confirmLabel: 'Reset' })
	if (ok) await resetModels()
}
</script>
