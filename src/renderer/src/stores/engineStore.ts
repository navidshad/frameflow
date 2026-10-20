import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
	asSetIn, CLI_MODELS, DEFAULT_ENGINE_SETTINGS, ENGINES, isCliEngine,
	type EngineDetection, type EngineId, type EngineSettings, type ModelOption
} from '@shared/engines'

/**
 * The AI engine, renderer side: what the engine chip and the Settings card
 * draw. Main owns the settings and detection; this mirrors them.
 */

const api = (window as any).api

export const useEngineStore = defineStore('engine', () => {
	const settings = ref<EngineSettings>({ ...DEFAULT_ENGINE_SETTINGS })
	const detections = ref<EngineDetection[]>([])
	const detecting = ref(false)
	const loaded = ref(false)

	const apply = (state: { settings: EngineSettings; detections: EngineDetection[]; detecting: boolean } | null) => {
		if (!state) return
		settings.value = state.settings
		detections.value = state.detections
		detecting.value = state.detecting
		loaded.value = true
	}

	const detectionFor = (id: EngineId) => detections.value.find((d) => d.id === id)
	const current = computed(() => ENGINES[settings.value.engine])
	const isCli = computed(() => isCliEngine(settings.value.engine))

	/** Engines for the chip menu: the CLIs found here, then Gemini API. */
	const available = computed(() =>
		(['claude-code', 'codex', 'gemini-cli', 'gemini-api'] as EngineId[]).filter((id) => {
			const d = detectionFor(id)
			return id === settings.value.engine || (d && d.status !== 'missing')
		})
	)

	/** The Model select's options for the selected CLI. */
	const modelOptions = computed<ModelOption[]>(() => {
		const id = settings.value.engine
		if (!isCliEngine(id)) return []
		const reported = detectionFor(id)?.models || []
		const options = [{ value: '', label: asSetIn(id) }, ...(reported.length ? reported : CLI_MODELS[id])]
		const chosen = settings.value.models[id]
		if (chosen && !options.some((o) => o.value === chosen)) options.push({ value: chosen, label: chosen })
		return options
	})

	const load = async () => apply(await api.getEngines())
	const detect = async () => {
		detecting.value = true
		apply(await api.detectEngines())
	}
	const update = async (patch: Partial<EngineSettings>) => apply(await api.setEngineSettings(JSON.parse(JSON.stringify(patch))))
	const select = (engine: EngineId) => update({ engine })

	if (api?.onEngineState) api.onEngineState(apply)

	return { settings, detections, detecting, loaded, current, isCli, available, modelOptions, detectionFor, load, detect, update, select }
})
