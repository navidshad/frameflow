<template>
	<SectionHeader title="Image editing"
		description="Which model does each job in the image graph. Every job lists only the models that can do it." />

	<SettingsGroup title="Models by job">
		<!-- Understand images and requests: three steps, one picker -->
		<SettingsRow title="Understand images and requests" top
			description="Reads your images, works out what you asked for, and powers Improve prompt.">
			<template #aside>
				<StepsNote :count="UNDERSTAND.length" :open="understandOpen" @toggle="understandOpen = !understandOpen" />
			</template>
			<ModelPicker v-bind="common" :models="everything" label="Understand images and requests model"
				:placeholder="understandOpen ? 'Mixed' : 'Mixed: choose per step'"
				:hint="understandValue ? priceHint(settings.pricing, understandValue) : ''"
				:model-value="understandValue" @update:model-value="setOps(UNDERSTAND, $event)" />
			<template v-if="understandOpen">
				<div v-for="s in UNDERSTAND_STEPS" :key="s.op" class="mt-3">
					<div class="lbl mb-0.5">{{ s.label }}</div>
					<ModelPicker v-bind="common" :models="everything" :label="`${s.label} model`"
						:hint="priceHint(settings.pricing, settings.selection[s.op])"
						:model-value="settings.selection[s.op] ?? null" @update:model-value="setOps([s.op], $event)" />
				</div>
			</template>
		</SettingsRow>

		<!-- Generate images: two steps, one picker -->
		<SettingsRow title="Generate images" description="New images, edits and thumbnails." top>
			<template #aside>
				<StepsNote :count="GENERATE.length" :open="generateOpen" @toggle="generateOpen = !generateOpen" />
			</template>
			<ModelPicker v-bind="common" :models="makers" label="Generate images model"
				:placeholder="generateOpen ? 'Mixed' : 'Mixed: choose per step'"
				:hint="generateValue ? priceHint(settings.pricing, generateValue) : ''"
				:model-value="generateValue" @update:model-value="setOps(GENERATE, $event)" />
			<template v-if="generateOpen">
				<div v-for="s in GENERATE_STEPS" :key="s.op" class="mt-3">
					<div class="lbl mb-0.5">{{ s.label }}</div>
					<ModelPicker v-bind="common" :models="makers" :label="`${s.label} model`"
						:hint="priceHint(settings.pricing, settings.selection[s.op])"
						:model-value="settings.selection[s.op] ?? null" @update:model-value="setOps([s.op], $event)" />
				</div>
			</template>
		</SettingsRow>

		<SettingsRow title="Upscale" description="High-resolution copies of a result." top>
			<ModelPicker v-bind="common" :models="makers" label="Upscale model"
				:hint="priceHint(settings.pricing, settings.selection['image-upscale'])"
				:model-value="settings.selection['image-upscale'] ?? null" @update:model-value="setOps(['image-upscale'], $event)" />
		</SettingsRow>
	</SettingsGroup>

	<div class="mt-6">
		<button class="btn-text !px-0 !text-[#52525b] dark:!text-[#c9cad2]" @click="reset">Reset models to defaults</button>
	</div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { allModels, groupValue, imageOutputModels, priceHint } from '@shared/modelPickers'
import { dialog } from '../../composables/useDialog'
import ModelPicker from './ModelPicker.vue'
import SectionHeader from './SectionHeader.vue'
import SettingsGroup from './SettingsGroup.vue'
import SettingsRow from './SettingsRow.vue'
import StepsNote from './StepsNote.vue'
import { useModelSettings } from './useModelSettings'

const UNDERSTAND_STEPS = [
	{ op: 'image-extraction', label: 'Read images' },
	{ op: 'image-intent', label: 'Work out the request' },
	{ op: 'intent', label: 'Improve prompt' }
]
const GENERATE_STEPS = [
	{ op: 'image-generation', label: 'Images and edits' },
	{ op: 'thumbnail', label: 'Thumbnails' }
]
const UNDERSTAND = UNDERSTAND_STEPS.map((s) => s.op)
const GENERATE = GENERATE_STEPS.map((s) => s.op)

const { settings, labels, loaded, setOps, resetModels } = useModelSettings()
const everything = computed(() => allModels(settings.value.pricing))
const makers = computed(() => imageOutputModels(settings.value.pricing))
const common = computed(() => ({
	pricing: settings.value.pricing,
	labels: labels.value,
	footnote: 'Price per 1M input tokens, or per image.'
}))

const understandValue = computed(() => groupValue(settings.value.selection, UNDERSTAND))
const generateValue = computed(() => groupValue(settings.value.selection, GENERATE))
// Steps that already differ open on their own, so a mixed choice is never hidden.
const understandChosen = ref(false)
const generateChosen = ref(false)
const understandOpen = computed({
	get: () => understandChosen.value || (loaded.value && understandValue.value === null),
	set: (v) => { understandChosen.value = v }
})
const generateOpen = computed({
	get: () => generateChosen.value || (loaded.value && generateValue.value === null),
	set: (v) => { generateChosen.value = v }
})

const reset = async () => {
	const ok = await dialog.confirm({ title: 'Reset models', message: 'Reset model selection to defaults?', confirmLabel: 'Reset' })
	if (ok) await resetModels()
}
</script>
