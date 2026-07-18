<template>
	<div class="relative" ref="rootRef">
		<!-- Trigger chip -->
		<button
			class="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:border-primary/40 transition active:scale-95"
			@click="open = !open">
			<span class="text-sm leading-none">{{ store.activePersona?.icon || '🎬' }}</span>
			<span class="text-[10px] font-bold uppercase tracking-widest text-zinc-600 dark:text-zinc-300 max-w-[110px] truncate">
				{{ store.activePersona?.name || 'Persona' }}
			</span>
			<span class="iconify tabler--chevron-up w-3 h-3 text-zinc-400 transition-transform" :class="{ 'rotate-180': open }"></span>
		</button>

		<!-- Popover -->
		<div v-if="open"
			class="absolute bottom-full left-0 mb-2 w-72 max-h-96 overflow-y-auto custom-scrollbar rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl shadow-premium z-50 py-2 animate-fade-in-up">
			<template v-for="group in groups" :key="group.key">
				<div v-if="group.items.length" class="px-3 pt-2 pb-1">
					<span class="text-[9px] font-bold uppercase tracking-widest text-zinc-400">{{ group.label }}</span>
				</div>
				<button v-for="persona in group.items" :key="persona.id"
					class="w-full px-3 py-2 flex items-start gap-2.5 hover:bg-primary/5 transition text-left group/row"
					@click="pick(persona.id)">
					<span class="text-base leading-none mt-0.5">{{ persona.icon }}</span>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-1.5">
							<span class="text-xs font-bold text-zinc-800 dark:text-zinc-200 truncate">{{ persona.name }}</span>
							<span v-if="persona.id === store.activePersona?.id" class="iconify tabler--check w-3 h-3 text-primary shrink-0"></span>
						</div>
						<p class="text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug line-clamp-2">{{ persona.description }}</p>
					</div>
					<!-- Hover actions -->
					<div class="flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition shrink-0">
						<span class="w-5 h-5 flex items-center justify-center rounded text-zinc-400 hover:text-primary hover:bg-primary/10"
							title="Duplicate" @click.stop="duplicate(persona.id)">
							<span class="iconify tabler--copy w-3 h-3"></span>
						</span>
						<template v-if="!persona.builtin">
							<span class="w-5 h-5 flex items-center justify-center rounded text-zinc-400 hover:text-primary hover:bg-primary/10"
								title="Edit" @click.stop="edit(persona)">
								<span class="iconify tabler--pencil w-3 h-3"></span>
							</span>
							<span class="w-5 h-5 flex items-center justify-center rounded text-zinc-400 hover:text-red-500 hover:bg-red-500/10"
								title="Delete" @click.stop="remove(persona.id)">
								<span class="iconify tabler--trash w-3 h-3"></span>
							</span>
						</template>
					</div>
				</button>
			</template>

			<!-- Footer -->
			<div class="border-t border-zinc-200 dark:border-zinc-800 mt-1 pt-1 px-2">
				<button
					class="w-full px-2 py-2 rounded-xl flex items-center gap-2 text-xs font-bold text-primary hover:bg-primary/10 transition"
					@click="createNew">
					<span class="iconify tabler--plus w-3.5 h-3.5"></span>
					New persona
				</button>
			</div>
		</div>

		<PersonaEditorModal v-model="editorOpen" :persona="editing" @saved="onSaved" />
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { EditorPersona } from '@shared/types'
import { useEditorStore } from '../../stores/editorStore'
import PersonaEditorModal from './PersonaEditorModal.vue'

const store = useEditorStore()

const open = ref(false)
const editorOpen = ref(false)
const editing = ref<EditorPersona | null>(null)
const rootRef = ref<HTMLElement | null>(null)

const groups = computed(() => [
	{ key: 'longform', label: 'Long-form', items: store.personasByMode.longform },
	{ key: 'summarize', label: 'Summarize', items: store.personasByMode.summarize },
	{ key: 'custom', label: 'Custom', items: store.personasByMode.custom }
])

const pick = (id: string) => {
	store.setActivePersona(id)
	open.value = false
}

const duplicate = (id: string) => {
	const clone = store.clonePersona(id)
	if (clone) {
		editing.value = clone
		editorOpen.value = true
		open.value = false
	}
}

const edit = (persona: EditorPersona) => {
	editing.value = JSON.parse(JSON.stringify(persona))
	editorOpen.value = true
	open.value = false
}

const remove = async (id: string) => {
	await store.deletePersona(id)
}

const createNew = () => {
	editing.value = null
	editorOpen.value = true
	open.value = false
}

const onSaved = (persona: EditorPersona) => {
	store.setActivePersona(persona.id)
}

// Close on outside click / Escape
const onDocClick = (e: MouseEvent) => {
	if (open.value && rootRef.value && !rootRef.value.contains(e.target as Node)) open.value = false
}
const onKey = (e: KeyboardEvent) => {
	if (e.key === 'Escape') open.value = false
}
onMounted(() => {
	document.addEventListener('click', onDocClick)
	document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
	document.removeEventListener('click', onDocClick)
	document.removeEventListener('keydown', onKey)
})
</script>
