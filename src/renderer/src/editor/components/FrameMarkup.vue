<template>
	<Teleport to="body">
		<div ref="rootRef" class="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-6" tabindex="-1"
			data-testid="frame-markup" @keydown.stop="onKey" @mousedown.self="$emit('close')">
			<div class="pop flex flex-col max-w-full max-h-full p-3 gap-2">
				<!-- Tools -->
				<div class="flex items-center gap-1">
					<button v-for="t in tools" :key="t.id"
						class="h-7 px-2 rounded-md flex items-center gap-1 text-[11px] font-semibold transition"
						:class="tool === t.id ? 'bg-primary text-white' : 'text-zinc-500 hover:text-primary'"
						:title="t.label" :data-testid="`markup-${t.id}`" @click="tool = t.id">
						<span class="iconify w-3.5 h-3.5" :class="t.icon"></span>{{ t.label }}
					</button>
					<span class="w-px h-4 bg-[color:var(--ff-hairline-strong)] mx-1"></span>
					<button v-for="c in MARK_COLORS" :key="c" class="w-5 h-5 rounded-full border-2 transition"
						:class="color === c ? 'border-primary scale-110' : 'border-transparent'"
						:style="{ background: c, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.25)' }" :aria-label="`Colour ${c}`"
						@click="color = c"></button>
					<div class="flex-1 min-w-4"></div>
					<button class="h-7 px-2 text-[11px] font-semibold text-zinc-500 hover:text-primary disabled:opacity-40 transition"
						:disabled="!marks.length" title="Undo (⌘Z)" @click="marks = marks.slice(0, -1)">Undo</button>
					<button class="h-7 px-2 text-[11px] font-semibold text-zinc-500 hover:text-red-500 disabled:opacity-40 transition"
						:disabled="!marks.length" @click="marks = []">Clear</button>
				</div>

				<!-- The still, with the marks drawn over it at the size it is shown -->
				<div class="relative select-none" :style="{
					aspectRatio: `${attachment.width} / ${attachment.height}`,
					width: `min(80vw, calc((100vh - 170px) * ${attachment.width / attachment.height}))`
				}">
					<img :src="`data:image/jpeg;base64,${attachment.original}`" alt="" draggable="false"
						class="block w-full h-full" @load="resize" />
					<canvas ref="canvasRef" class="absolute inset-0 w-full h-full cursor-crosshair touch-none"
						data-testid="markup-canvas"
						@pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up"></canvas>
				</div>

				<div class="flex items-center gap-2">
					<span class="font-mono text-[10px] text-zinc-400">Frame at {{ formatTimecode(attachment.timeSec) }}</span>
					<span class="text-[10px] text-zinc-400">· The agent gets the frame with these marks on it.</span>
					<div class="flex-1"></div>
					<button class="h-7 px-3 rounded-md text-[11px] font-semibold text-zinc-500 hover:text-primary transition" @click="$emit('close')">Cancel</button>
					<button class="h-7 px-3 rounded-md bg-primary text-white text-[11px] font-semibold hover:bg-primary-dark disabled:opacity-50 transition"
						:disabled="saving" data-testid="markup-done" @click="save">
						{{ saving ? 'Saving…' : 'Done' }}
					</button>
				</div>
				<p v-if="error" class="text-[10px] text-red-500">{{ error }}</p>
			</div>
		</div>
	</Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { formatTimecode } from '@shared/promptRefs'
import { useEditorStore } from '../../stores/editorStore'
import { composeMarked, drawMarks, MARK_COLORS, type ComposerAttachment, type FrameMark, type MarkTool } from '../frameMarks'

/**
 * A light markup editor on an attached frame: arrow, box, ring, freehand.
 * Deliberately not a paint program; enough to point at the thing a note is
 * about. Marks are kept apart from the picture (see frameMarks.ts), so this
 * opens on what was drawn before and Done re-draws the sent picture from the
 * untouched original.
 */
const props = defineProps<{ attachment: ComposerAttachment }>()
const emit = defineEmits<{ (e: 'close'): void }>()
const store = useEditorStore()

const tools: { id: MarkTool; label: string; icon: string }[] = [
	{ id: 'arrow', label: 'Arrow', icon: 'tabler--arrow-up-right' },
	{ id: 'rect', label: 'Box', icon: 'tabler--square' },
	{ id: 'ellipse', label: 'Ring', icon: 'tabler--circle' },
	{ id: 'pen', label: 'Draw', icon: 'tabler--scribble' }
]
const tool = ref<MarkTool>('arrow')
const color = ref<string>(MARK_COLORS[0])
const marks = ref<FrameMark[]>(props.attachment.marks.map((m) => ({ ...m, points: [...m.points] })))
const drawing = ref<FrameMark | null>(null)
const saving = ref(false)
const error = ref('')
const canvasRef = ref<HTMLCanvasElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

const redraw = () => {
	const canvas = canvasRef.value
	if (!canvas) return
	const ctx = canvas.getContext('2d')!
	ctx.clearRect(0, 0, canvas.width, canvas.height)
	drawMarks(ctx, drawing.value ? [...marks.value, drawing.value] : marks.value, canvas.width, canvas.height)
}

// The canvas draws at the size it is shown (times the screen's density), not
// the picture's: line widths then look on screen as they will in the export.
const resize = () => {
	const canvas = canvasRef.value
	if (!canvas) return
	const dpr = window.devicePixelRatio || 1
	canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr))
	canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr))
	redraw()
}
watch([marks, drawing], redraw, { deep: true })
onMounted(() => {
	window.addEventListener('resize', resize)
	nextTick(() => { resize(); rootRef.value?.focus() })
})
onBeforeUnmount(() => window.removeEventListener('resize', resize))

const at = (e: PointerEvent) => {
	const rect = canvasRef.value!.getBoundingClientRect()
	return {
		x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
		y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
	}
}
const down = (e: PointerEvent) => {
	canvasRef.value?.setPointerCapture(e.pointerId)
	const p = at(e)
	drawing.value = { tool: tool.value, color: color.value, points: [p, p] }
}
const move = (e: PointerEvent) => {
	if (!drawing.value) return
	const p = at(e)
	if (drawing.value.tool === 'pen') drawing.value.points.push(p)
	else drawing.value.points = [drawing.value.points[0], p]
}
const up = () => {
	const mark = drawing.value
	drawing.value = null
	if (!mark) return
	// A click without a drag is not a mark.
	const [a, b] = [mark.points[0], mark.points[mark.points.length - 1]]
	const span = mark.points.reduce((m, p) => Math.max(m, Math.hypot(p.x - a.x, p.y - a.y)), Math.hypot(b.x - a.x, b.y - a.y))
	if (span > 0.01) marks.value = [...marks.value, mark]
}

const onKey = (e: KeyboardEvent) => {
	if (e.key === 'Escape') emit('close')
	else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
		e.preventDefault()
		marks.value = marks.value.slice(0, -1)
	}
}

const save = async () => {
	saving.value = true
	error.value = ''
	try {
		const a = props.attachment
		const drawn = marks.value.length ? await composeMarked(a.original, marks.value) : null
		store.updatePromptAttachment(a.id, {
			marks: marks.value,
			data: drawn?.data ?? a.original,
			// Without marks, back to the thumbnail main made of the untouched frame.
			thumbnail: drawn?.thumbnail ?? (a.marks.length ? (await composeMarked(a.original, [])).thumbnail : a.thumbnail)
		})
		emit('close')
	} catch (e: any) {
		error.value = e?.message || 'The marks could not be saved.'
	} finally {
		saving.value = false
	}
}
</script>
