<template>
	<!-- A flat dropdown: the chosen model, and a list of the models that can do the job with their prices. -->
	<div ref="root" class="relative">
		<button type="button" class="field flex items-center gap-2 text-left cursor-pointer" :aria-label="label"
			aria-haspopup="listbox" :aria-expanded="open" @click="open = !open" @keydown.esc="open = false">
			<span class="flex-1 truncate" :class="{ 'text-zinc-500': !modelValue }">{{ modelLabel(modelValue) || placeholder }}</span>
			<span class="iconify tabler--chevron-down w-3.5 h-3.5 text-zinc-500 shrink-0"></span>
		</button>
		<div v-if="open" role="listbox" :aria-label="label"
			:class="alignRight ? 'right-0' : 'left-0'"
			class="absolute top-full mt-1 z-20 min-w-full w-[280px] rounded border border-[color:var(--ff-hairline-strong)] bg-white dark:bg-[#141417] shadow-2xl p-1.5 text-xs">
			<div class="lbl px-2.5 pt-2 pb-1.5">Gemini API</div>
			<button v-for="m in models" :key="m" type="button" role="option" :aria-selected="m === modelValue"
				class="w-full flex items-center gap-2 h-8 px-2.5 rounded-sm text-left hover:bg-zinc-500/10"
				:class="m === modelValue ? 'bg-primary/15 font-semibold' : ''" @click="pick(m)">
				<span class="flex-1 truncate">{{ modelLabel(m) }}</span>
				<span class="font-mono text-[11px] text-zinc-500">{{ optionPrice(pricing, m) }}</span>
				<span class="w-3.5 h-3.5 shrink-0 text-primary">
					<span v-if="m === modelValue" class="iconify tabler--check w-3.5 h-3.5"></span>
				</span>
			</button>
			<p class="px-2.5 pt-1.5 pb-2 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{{ footnote }}</p>
		</div>
		<div v-if="hint" class="mt-[5px] text-[11px] font-mono text-zinc-500">{{ hint }}</div>
	</div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { ModelPricing } from '@shared/types'
import { optionPrice } from '@shared/modelPickers'

const props = defineProps<{
	modelValue: string | null
	models: string[]
	pricing: Record<string, ModelPricing>
	labels: Record<string, { label: string }>
	label: string
	hint?: string
	placeholder?: string
	footnote?: string
	alignRight?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const root = ref<HTMLElement>()
const modelLabel = (m: string | null) => (m ? props.labels[m]?.label || m : '')
const pick = (m: string) => {
	open.value = false
	emit('update:modelValue', m)
}
const away = (e: MouseEvent) => {
	if (open.value && root.value && !root.value.contains(e.target as Node)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', away))
onBeforeUnmount(() => document.removeEventListener('mousedown', away))
</script>
