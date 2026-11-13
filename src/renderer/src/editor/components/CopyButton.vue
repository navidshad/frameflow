<template>
	<button type="button"
		class="w-5 h-5 inline-flex items-center justify-center rounded-md text-zinc-400 hover:text-primary hover:bg-primary/10 transition"
		:title="copied ? 'Copied' : label" :aria-label="copied ? 'Copied' : label" @click.stop="copy">
		<span class="iconify w-3 h-3" :class="copied ? 'tabler--check text-accent' : 'tabler--copy'"></span>
	</button>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

/** Copies a whole message to the clipboard, and says so for a moment. */
const props = withDefaults(defineProps<{ text: string; label?: string }>(), { label: 'Copy message' })

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

const copy = async () => {
	try {
		await navigator.clipboard.writeText(props.text)
		copied.value = true
		clearTimeout(timer)
		timer = setTimeout(() => { copied.value = false }, 1500)
	} catch {
		/* The clipboard refused (no focus): the button simply does not turn into a tick. */
	}
}

onBeforeUnmount(() => clearTimeout(timer))
</script>
