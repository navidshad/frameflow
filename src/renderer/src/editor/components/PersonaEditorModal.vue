<template>
	<AppDialog :model-value="modelValue" :title="isEdit ? 'Edit persona' : 'New persona'" size="md"
		@update:model-value="$emit('update:modelValue', $event)">
		<div class="space-y-3 max-h-[60vh] pr-1">
			<div class="flex gap-3">
				<div class="w-14">
					<label for="persona-icon" class="lbl block">Icon</label>
					<input id="persona-icon" v-model="form.icon" class="field text-center" placeholder="🎬" />
				</div>
				<div class="flex-1">
					<label for="persona-name" class="lbl block">Name *</label>
					<input id="persona-name" v-model="form.name" class="field" placeholder="My editor persona" />
				</div>
			</div>

			<div>
				<label for="persona-desc" class="lbl block">Description</label>
				<input id="persona-desc" v-model="form.description" class="field" placeholder="One line shown in the picker" />
			</div>

			<div class="flex gap-4">
				<div class="flex-1">
					<label for="persona-tone" class="lbl block">Tone</label>
					<input id="persona-tone" v-model="form.tone" class="field" placeholder="neutral" />
				</div>
				<div class="flex-1">
					<span class="lbl block">Pacing</span>
					<div class="flex gap-3.5" role="tablist" aria-label="Pacing">
						<button v-for="p in PACINGS" :key="p.value" type="button" role="tab" :aria-selected="form.pacing === p.value"
							class="tab-u !h-[30px]" :class="{ 'tab-u-active': form.pacing === p.value }"
							@click="form.pacing = p.value">{{ p.label }}</button>
					</div>
				</div>
			</div>

			<div>
				<label for="persona-prompt" class="lbl block">System prompt *</label>
				<textarea id="persona-prompt" v-model="form.systemPrompt" rows="6" class="field resize-y leading-relaxed"
					placeholder="You are a … editor. Keep …, remove …, prefer …"></textarea>
				<p class="mt-1 text-[10px] text-zinc-500 leading-snug">
					This text drives the AI's editing style. Phrase it positively (do-this), not negatively.
				</p>
			</div>

			<!-- Live summary -->
			<p class="text-[11px] text-zinc-500 dark:text-zinc-400 border-l-2 border-secondary/50 pl-2">
				{{ form.pacing }} pacing{{ form.tone ? `, ${form.tone} tone` : '' }}.
				Length comes from what you ask for, not from the persona.
			</p>
		</div>

		<template #footer-start>
			<button v-if="isEdit" class="btn-text btn-text-danger !px-0" @click="onDelete">Delete</button>
		</template>
		<template #footer>
			<button class="btn-text" @click="close">Cancel</button>
			<button class="btn-fill" :disabled="!canSave" @click="save">Save persona</button>
		</template>
	</AppDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import AppDialog from '../../components/AppDialog.vue'
import { dialog } from '../../composables/useDialog'
import type { EditorPersona } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'

const props = defineProps<{
	modelValue: boolean
	/** Existing persona (edit/clone-prefill) or null (blank create). */
	persona: EditorPersona | null
}>()

const emit = defineEmits<{
	(e: 'update:modelValue', value: boolean): void
	(e: 'saved', persona: EditorPersona): void
}>()

const store = useEditorStore()

const editingId = ref<string | null>(null)
const PACINGS = [
	{ value: 'tight', label: 'Tight' },
	{ value: 'balanced', label: 'Balanced' },
	{ value: 'relaxed', label: 'Relaxed' }
] as const

const form = reactive({
	icon: '🎬',
	name: '',
	description: '',
	tone: '',
	pacing: 'balanced' as 'tight' | 'balanced' | 'relaxed',
	systemPrompt: ''
})

// isEdit = editing an EXISTING user persona (has id already in the library)
const isEdit = computed(() =>
	!!editingId.value && store.personas.some((p) => p.id === editingId.value && !p.builtin)
)

const canSave = computed(() => form.name.trim().length > 0 && form.systemPrompt.trim().length > 0)

watch(() => props.modelValue, (open) => {
	if (!open) return
	const p = props.persona
	editingId.value = p?.id || null
	form.icon = p?.icon || '🎬'
	form.name = p?.name || ''
	form.description = p?.description || ''
	form.tone = p?.tone || ''
	form.pacing = p?.defaults?.pacing || 'balanced'
	form.systemPrompt = p?.systemPrompt || ''
})

const close = () => emit('update:modelValue', false)

const save = async () => {
	if (!canSave.value) return
	const persona: EditorPersona = {
		id: editingId.value || ((crypto as any).randomUUID ? crypto.randomUUID() : `persona-${Date.now()}`),
		icon: form.icon || '🎬',
		name: form.name.trim(),
		description: form.description.trim(),
		tone: form.tone.trim() || undefined,
		builtin: false,
		defaults: { pacing: form.pacing },
		systemPrompt: form.systemPrompt.trim(),
		featureSets: []
	}
	await store.savePersona(persona)
	emit('saved', persona)
	close()
}

const onDelete = async () => {
	if (!editingId.value) return
	const confirmed = await dialog.confirm({
		title: 'Delete persona',
		message: 'Delete this persona from your library?',
		confirmLabel: 'Delete',
		danger: true
	})
	if (!confirmed) return
	await store.deletePersona(editingId.value)
	close()
}
</script>
