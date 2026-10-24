import { ref, toRaw } from 'vue'
import type { ModelSettings } from '@shared/types'

/**
 * One copy of the saved model choices and prices, shared by the Video editing,
 * Image editing and Usage sections. Main owns the file; changes save at once.
 */
const settings = ref<ModelSettings>({ pricing: {}, selection: {} })
const labels = ref<Record<string, { label: string; description?: string }>>({})
const loaded = ref(false)
const api = () => (window as any).api

export function useModelSettings() {
	const load = async () => {
		const [meta, saved] = await Promise.all([api().getModelMetadata(), api().getModelSettings()])
		if (meta) labels.value = meta
		if (saved) settings.value = saved
		loaded.value = true
	}
	const save = () => api().setModelSettings(JSON.parse(JSON.stringify(toRaw(settings.value))))
	const setOps = async (ops: string[], model: string) => {
		for (const op of ops) settings.value.selection[op] = model
		await save()
	}
	const resetModels = async () => {
		const fresh = await api().resetModelSettings()
		settings.value.selection = fresh.selection
	}
	const resetPricing = async () => {
		const fresh = await api().resetModelSettings()
		settings.value.pricing = fresh.pricing
	}
	return { settings, labels, loaded, load, save, setOps, resetModels, resetPricing }
}
