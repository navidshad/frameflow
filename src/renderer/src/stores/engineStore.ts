import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
	asSetIn, CLI_MODELS, DEFAULT_ENGINE_SETTINGS, ENGINES, engineChipLabel, geminiTextModels, isCliEngine,
	type GeminiTextModel,
	type EngineDetection, type EngineId, type EngineSettings, type ModelOption
} from '@shared/engines'

/**
 * The AI engine, renderer side: what the engine chip and the Settings card
 * draw. Main owns the settings and detection; this mirrors them.
 */

const api = (window as any).api

/** Chip menu order for Gemini models; anything else follows by price. */
const GEMINI_MENU_ORDER = ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-2.5-pro']
const EDITOR_OP = 'editor-edit'
const EDITOR_FALLBACK = 'gemini-2.5-flash'

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

	/** Engines for the chip menu: a CLI found here, then Gemini API. */
	const available = computed(() =>
		(['claude-code', 'gemini-api'] as EngineId[]).filter((id) => {
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

	// ---- Gemini API: the model the editor chat uses (the 'editor-edit' selection) ----
	const modelSettings = ref<{ pricing: Record<string, any>; selection: Record<string, string> } | null>(null)
	const modelMetadata = ref<Record<string, { label: string }>>({})

	const geminiModels = computed<GeminiTextModel[]>(() =>
		geminiTextModels(modelSettings.value?.pricing, modelMetadata.value, GEMINI_MENU_ORDER))
	const editorModel = computed(() => modelSettings.value?.selection?.[EDITOR_OP] || EDITOR_FALLBACK)
	const editorModelLabel = computed(() => modelMetadata.value[editorModel.value]?.label || editorModel.value)
	const chipLabel = computed(() => engineChipLabel(settings.value, editorModelLabel.value))

	const loadModels = async () => {
		try {
			const [ms, md] = await Promise.all([api.getModelSettings(), api.getModelMetadata()])
			modelSettings.value = ms
			modelMetadata.value = md || {}
		} catch (error) {
			console.error('[engineStore] Failed to load model settings:', error)
		}
	}
	const setEditorModel = async (model: string) => {
		if (!modelSettings.value) await loadModels()
		const next = JSON.parse(JSON.stringify(modelSettings.value))
		next.selection = { ...next.selection, [EDITOR_OP]: model }
		await api.setModelSettings(next)
		modelSettings.value = next
	}

	const load = async () => {
		await Promise.all([api.getEngines().then(apply), loadModels()])
	}
	const detect = async () => {
		detecting.value = true
		apply(await api.detectEngines())
	}
	const update = async (patch: Partial<EngineSettings>) => apply(await api.setEngineSettings(JSON.parse(JSON.stringify(patch))))
	const select = (engine: EngineId) => update({ engine })

	if (api?.onEngineState) api.onEngineState(apply)

	return { settings, detections, geminiModels, editorModel, editorModelLabel, chipLabel, setEditorModel, detecting, loaded, current, isCli, available, modelOptions, detectionFor, load, detect, update, select }
})
