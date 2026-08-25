<template>
	<Modal :model-value="modelValue" :title="isEdit ? 'Edit persona' : 'New persona'" size="lg"
		@update:model-value="$emit('update:modelValue', $event)">
		<div class="space-y-4 py-2 max-h-[60vh] overflow-y-auto custom-scrollbar pr-1">
			<div class="grid grid-cols-[64px_1fr] gap-3">
				<div>
					<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1.5">Icon</label>
					<Input v-model="form.icon" placeholder="🎬" />
				</div>
				<div>
					<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1.5">Name *</label>
					<Input v-model="form.name" placeholder="My editor persona" />
				</div>
			</div>

			<div>
				<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1.5">Description</label>
				<Input v-model="form.description" placeholder="One line shown in the picker" />
			</div>

			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1.5">Tone</label>
					<Input v-model="form.tone" placeholder="neutral" />
				</div>
				<div>
					<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1.5">Pacing</label>
					<select v-model="form.pacing" class="w-full px-3 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm input-focus-ring">
						<option value="tight">Tight</option>
						<option value="balanced">Balanced</option>
						<option value="relaxed">Relaxed</option>
					</select>
				</div>
			</div>

			<div>
				<label class="text-[10px] font-bold uppercase tracking-widest text-zinc-500 block mb-1.5">System prompt *</label>
				<TextArea v-model="form.systemPrompt" :rows="7"
					placeholder="You are a … editor. Keep …, remove …, prefer …" />
				<p class="mt-1 text-[10px] text-zinc-400 leading-snug">
					This text drives the AI's editing style. Phrase it positively (do-this), not negatively.
				</p>
			</div>

			<!-- Live summary -->
			<p class="text-[11px] text-zinc-500 dark:text-zinc-400 italic border-l-2 border-primary/40 pl-2">
				{{ form.pacing }} pacing{{ form.tone ? `, ${form.tone} tone` : '' }}.
				Length comes from what you ask for, not from the persona.
			</p>
		</div>

		<template #footer>
			<div class="flex items-center justify-between w-full">
				<button v-if="isEdit"
					class="px-3 py-2 rounded-xl text-xs font-bold text-red-500 hover:bg-red-500/10 transition"
					@click="onDelete">
					Delete
				</button>
				<div v-else></div>
				<div class="flex gap-2">
					<button
						class="px-4 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
						@click="close">
						Cancel
					</button>
					<button
						class="px-4 py-2 rounded-xl bg-primary text-white text-xs font-bold shadow-md shadow-primary/20 hover:bg-primary-dark transition disabled:opacity-50 disabled:cursor-not-allowed"
						:disabled="!canSave" @click="save">
						Save persona
					</button>
				</div>
			</div>
		</template>
	</Modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { Modal } from 'pilotui/complex'
import { Input, TextArea } from 'pilotui/form'
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
	const confirmed = await (window as any).api.showConfirmation({
		title: 'Delete persona',
		message: 'Delete this persona from your library?',
		buttons: ['Cancel', 'Delete']
	})
	if (!confirmed || confirmed.response !== 1) return
	await store.deletePersona(editingId.value)
	close()
}
</script>
