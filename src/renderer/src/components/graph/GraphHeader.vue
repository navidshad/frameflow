<template>
	<!-- The graph's header is the shared 40px top bar; its props and slots are unchanged. -->
	<AppTopBar :title="title || (editable ? 'Untitled Project' : 'Graph Task Manager')" :total-cost="totalCost"
		:editable="editable" show-back @back="$emit('back')" @rename="$emit('rename', $event)">
		<template v-if="$slots.center" #center><slot name="center" /></template>
		<template v-if="$slots.actions" #actions><slot name="actions" /></template>
	</AppTopBar>
</template>

<script setup lang="ts">
import AppTopBar from '../AppTopBar.vue'

defineProps<{
	title?: string
	totalCost: number
	editable?: boolean
}>()

defineEmits<{
	(e: 'back'): void
	(e: 'rename', value: string): void
}>()
</script>
