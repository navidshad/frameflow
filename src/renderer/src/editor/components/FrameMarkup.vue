<template>
	<Teleport to="body">
		<div ref="rootRef" class="fixed inset-0 z-[100] bg-black/70 flex items-center justify-center p-6" tabindex="-1"
			data-testid="frame-markup" @keydown.stop="onKey" @mousedown.self="$emit('close')">
			<div class="pop flex flex-col max-w-full max-h-full p-3 gap-2">
				<!-- Tools -->
				<div class="flex items-center gap-1 flex-wrap">
					<button v-for="t in tools" :key="t.id"
						class="h-7 px-2 rounded-md flex items-center gap-1 text-[11px] font-semibold transition"
						:class="tool === t.id ? 'bg-primary text-white' : 'text-zinc-500 hover:text-primary'"
						:title="`${t.label} (${t.key.toUpperCase()})`" :data-testid="`markup-${t.id}`" @click="pickTool(t.id)">
						<span class="iconify w-3.5 h-3.5" :class="t.icon"></span>{{ t.label }}
					</button>
					<span class="w-px h-4 bg-[color:var(--ff-hairline-strong)] mx-1"></span>

					<!-- Colour: the usual few, and the well for any other -->
					<button v-for="c in MARK_COLORS" :key="c" class="w-5 h-5 rounded-full border-2 transition"
						:class="activeColor.toLowerCase() === c ? 'border-primary scale-110' : 'border-transparent'"
						:style="{ background: c, boxShadow: 'inset 0 0 0 1px rgba(127,127,127,0.5)' }" :aria-label="`Colour ${c}`"
						@click="setColor(c)"></button>
					<label class="relative w-5 h-5 rounded-full overflow-hidden cursor-pointer border-2 transition"
						:class="customColor ? 'border-primary scale-110' : 'border-transparent'" title="Any colour">
						<span class="absolute inset-0" :style="{ background: customColor ? activeColor : 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }"></span>
						<input type="color" class="absolute inset-0 opacity-0 cursor-pointer" :value="activeColor" data-testid="markup-color"
							@input="setColor(($event.target as HTMLInputElement).value, false)" @change="sliderDone" />
					</label>
					<span class="w-px h-4 bg-[color:var(--ff-hairline-strong)] mx-1"></span>

					<!-- Stroke size; text is drawn five strokes tall, so this sizes text too -->
					<label class="flex items-center gap-1.5 text-[10px] font-semibold text-zinc-500" :title="activeTool === 'text' ? 'Text size' : 'Line width'">
						<span class="iconify w-3.5 h-3.5" :class="activeTool === 'text' ? 'tabler--text-size' : 'tabler--line-height'"></span>
						<input type="range" :min="SIZE_MIN" :max="SIZE_MAX" step="0.5" :value="activeSize" class="w-20 accent-[color:var(--color-primary,#4f46e5)]"
							data-testid="markup-size" @input="setSize(Number(($event.target as HTMLInputElement).value))" @change="sliderDone" />
						<span class="w-6 font-mono text-right">{{ activeSize }}</span>
					</label>

					<div class="flex-1 min-w-4"></div>
					<button v-if="selected !== null" class="h-7 px-2 text-[11px] font-semibold text-zinc-500 hover:text-red-500 transition"
						title="Delete the selected mark (⌫)" data-testid="markup-delete" @click="removeSelected">Delete</button>
					<button class="h-7 px-2 text-[11px] font-semibold text-zinc-500 hover:text-primary disabled:opacity-40 transition"
						:disabled="!history.length" title="Undo (⌘Z)" @click="undo">Undo</button>
					<button class="h-7 px-2 text-[11px] font-semibold text-zinc-500 hover:text-red-500 disabled:opacity-40 transition"
						:disabled="!marks.length" @click="commit([])">Clear</button>
				</div>

				<!-- The still, with the marks drawn over it at the size it is shown -->
				<div ref="stageRef" class="relative select-none" :style="{
					aspectRatio: `${attachment.width} / ${attachment.height}`,
					width: `min(80vw, calc((100vh - 170px) * ${attachment.width / attachment.height}))`
				}">
					<img :src="`data:image/jpeg;base64,${attachment.original}`" alt="" draggable="false"
						class="block w-full h-full" @load="resize" />
					<canvas ref="canvasRef" class="absolute inset-0 w-full h-full touch-none" :style="{ cursor }"
						data-testid="markup-canvas"
						@pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @dblclick="dblclick"></canvas>
					<!-- Text being typed: a real field over the picture, so typing, selection and IME work as anywhere -->
					<textarea v-if="editing" ref="textRef" v-model="editing.text" rows="1" spellcheck="false"
						class="absolute bg-black/10 outline-dashed outline-1 outline-white/70 resize-none overflow-hidden p-0 m-0 border-0 whitespace-pre"
						:style="editorStyle" data-testid="markup-text-field"
						@blur="finishText" @pointerdown.stop></textarea>
				</div>

				<div class="flex items-center gap-2">
					<span class="font-mono text-[10px] text-zinc-400">Frame at {{ formatTimecode(attachment.timeSec) }}</span>
					<span class="text-[10px] text-zinc-400">· {{ hint }}</span>
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { formatTimecode } from '@shared/promptRefs'
import { useEditorStore } from '../../stores/editorStore'
import { composeMarked, drawMarks, markFont, MARK_COLORS, type ComposerAttachment } from '../frameMarks'
import {
	fontPx, handleAt, hitMark, LINE_HEIGHT, markBounds, moveMark, resizeBox, resizeMark, SIZE_DEFAULT, SIZE_MAX, SIZE_MIN, strokePx,
	type Box, type Corner, type FrameMark, type MarkTool
} from '../markGeometry'

/**
 * A light markup editor on an attached frame: select, arrow, box, ring,
 * freehand and text, in any colour and line width. Enough to point at the
 * thing a note is about, not a paint program.
 *
 * Marks are kept apart from the picture (see frameMarks.ts), so this opens on
 * what was drawn before, every mark stays selectable, and Done re-draws the
 * sent picture from the untouched original.
 */
const props = defineProps<{ attachment: ComposerAttachment }>()
const emit = defineEmits<{ (e: 'close'): void }>()
const store = useEditorStore()

type Tool = 'select' | MarkTool
const tools: { id: Tool; label: string; icon: string; key: string }[] = [
	{ id: 'select', label: 'Select', icon: 'tabler--pointer', key: 'v' },
	{ id: 'arrow', label: 'Arrow', icon: 'tabler--arrow-up-right', key: 'a' },
	{ id: 'rect', label: 'Box', icon: 'tabler--square', key: 'b' },
	{ id: 'ellipse', label: 'Ring', icon: 'tabler--circle', key: 'r' },
	{ id: 'pen', label: 'Draw', icon: 'tabler--scribble', key: 'd' },
	{ id: 'text', label: 'Text', icon: 'tabler--typography', key: 't' }
]
const tool = ref<Tool>('arrow')
const color = ref<string>(MARK_COLORS[0])
const size = ref(SIZE_DEFAULT)

const marks = ref<FrameMark[]>(props.attachment.marks.map((m) => ({ ...m, points: [...m.points] })))
/** Earlier states of `marks`, newest last: Undo steps back through any change, not only the last mark drawn. */
const history = ref<FrameMark[][]>([])
const selected = ref<number | null>(null)
/** Text being typed: a new mark (index null) or an existing one. */
const editing = ref<{ index: number | null; x: number; y: number; text: string; color: string; size: number } | null>(null)

const saving = ref(false)
const error = ref('')
const canvasRef = ref<HTMLCanvasElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)
const textRef = ref<HTMLTextAreaElement | null>(null)
const cursor = ref('crosshair')

const commit = (next: FrameMark[]) => {
	history.value = [...history.value, marks.value]
	marks.value = next
	if (selected.value !== null && selected.value >= next.length) selected.value = null
}
const undo = () => {
	if (editing.value) editing.value = null
	const prev = history.value[history.value.length - 1]
	if (!prev) return
	history.value = history.value.slice(0, -1)
	marks.value = prev
	selected.value = null
}
const replaceAt = (index: number, mark: FrameMark) => marks.value.map((m, i) => (i === index ? mark : m))

// ===== What the controls show: the selected mark's, or the next one's =====

const selectedMark = computed(() => (selected.value !== null ? marks.value[selected.value] ?? null : null))
const activeColor = computed(() => editing.value?.color ?? selectedMark.value?.color ?? color.value)
const activeSize = computed(() => editing.value?.size ?? selectedMark.value?.size ?? size.value)
const activeTool = computed(() => (editing.value ? 'text' : selectedMark.value?.tool ?? tool.value))
const customColor = computed(() => !MARK_COLORS.some((c) => c === activeColor.value.toLowerCase()))
const hint = computed(() => {
	if (editing.value) return 'Type; Enter adds a line, Esc or a click outside finishes.'
	if (tool.value === 'select') return selected.value !== null ? 'Drag to move, a corner to resize, ⌫ to delete.' : 'Click a mark to select it. Double-click text to edit it.'
	if (tool.value === 'text') return 'Click where the text goes.'
	return 'The agent gets the frame with these marks on it.'
})

/**
 * A colour or size applies to what is being typed or selected, and becomes
 * the default for the next mark. Sliders fire many inputs per drag: only the
 * first takes an undo step (`sliderDone` re-arms it).
 */
let sliderStepTaken = false
const restyle = (patch: Partial<FrameMark>, step: boolean) => {
	if (editing.value) {
		Object.assign(editing.value, patch)
		return
	}
	const index = selected.value
	if (index === null) return
	const next = replaceAt(index, { ...marks.value[index], ...patch })
	if (step || !sliderStepTaken) {
		commit(next)
		sliderStepTaken = !step
	} else marks.value = next
}
const setColor = (c: string, step = true) => {
	color.value = c
	restyle({ color: c }, step)
}
const setSize = (s: number) => {
	size.value = s
	restyle({ size: s }, false)
}
const sliderDone = () => { sliderStepTaken = false }

const pickTool = (t: Tool) => {
	finishText()
	tool.value = t
	if (t !== 'select') selected.value = null
	cursor.value = t === 'select' ? 'default' : t === 'text' ? 'text' : 'crosshair'
}

// ===== Drawing =====

const dpr = () => window.devicePixelRatio || 1
const measure = (text: string, px: number) => {
	const ctx = canvasRef.value!.getContext('2d')!
	ctx.font = markFont(px)
	return ctx.measureText(text)
}
const dims = () => ({ w: canvasRef.value?.width ?? 1, h: canvasRef.value?.height ?? 1 })
/** The selection box sits a little outside the mark, so its handles never cover the mark's own line. */
const pad = (mark: FrameMark) => strokePx(mark, dims().w, dims().h) / 2 + 6 * dpr()
const selectionBox = (mark: FrameMark): Box => {
	const { w, h } = dims()
	const b = markBounds(mark, w, h, measure)
	const p = pad(mark)
	return { x: b.x - p, y: b.y - p, w: b.w + p * 2, h: b.h + p * 2 }
}

const redraw = () => {
	const canvas = canvasRef.value
	if (!canvas) return
	const ctx = canvas.getContext('2d')!
	ctx.clearRect(0, 0, canvas.width, canvas.height)
	// The text being edited is drawn by its field, not twice.
	const shown = marks.value.filter((_, i) => !(editing.value && editing.value.index === i))
	drawMarks(ctx, drag?.kind === 'draw' ? [...shown, drag.mark] : shown, canvas.width, canvas.height)
	const mark = selectedMark.value
	if (!mark || editing.value) return
	const box = selectionBox(mark)
	const unit = dpr()
	ctx.save()
	ctx.strokeStyle = '#3b82f6'
	ctx.lineWidth = 1.5 * unit
	ctx.setLineDash([5 * unit, 4 * unit])
	ctx.strokeRect(box.x, box.y, box.w, box.h)
	ctx.setLineDash([])
	ctx.fillStyle = '#ffffff'
	for (const [x, y] of [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]]) {
		ctx.fillRect(x - 4 * unit, y - 4 * unit, 8 * unit, 8 * unit)
		ctx.strokeRect(x - 4 * unit, y - 4 * unit, 8 * unit, 8 * unit)
	}
	ctx.restore()
}

// The canvas draws at the size it is shown (times the screen's density), not
// the picture's: sizes are relative to the picture, so they look on screen as
// they will in the picture that is sent.
const resize = () => {
	const canvas = canvasRef.value
	if (!canvas) return
	canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr()))
	canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr()))
	redraw()
}
watch([marks, selected, editing], redraw, { deep: true })
onMounted(() => {
	window.addEventListener('resize', resize)
	nextTick(() => { resize(); rootRef.value?.focus() })
})
onBeforeUnmount(() => window.removeEventListener('resize', resize))

// ===== Pointer =====

type Drag =
	| { kind: 'draw'; mark: FrameMark }
	| { kind: 'move'; index: number; start: { x: number; y: number }; orig: FrameMark; moved: boolean }
	| { kind: 'resize'; index: number; corner: Corner; startBox: Box; from: Box; orig: FrameMark; pad: number; moved: boolean }
let drag: Drag | null = null

/** The pointer on the canvas, in canvas pixels. */
const at = (e: PointerEvent | MouseEvent) => {
	const canvas = canvasRef.value!
	const rect = canvas.getBoundingClientRect()
	return {
		x: Math.min(canvas.width, Math.max(0, ((e.clientX - rect.left) / rect.width) * canvas.width)),
		y: Math.min(canvas.height, Math.max(0, ((e.clientY - rect.top) / rect.height) * canvas.height))
	}
}
const tolerance = () => 8 * dpr()

const down = (e: PointerEvent) => {
	if (e.button !== 0) return
	if (editing.value) {
		finishText()
		if (tool.value === 'text') return
	}
	canvasRef.value?.setPointerCapture(e.pointerId)
	const p = at(e)
	const { w, h } = dims()

	if (tool.value === 'select') {
		const current = selectedMark.value
		if (current) {
			const box = selectionBox(current)
			const corner = handleAt(box, p, tolerance())
			if (corner) {
				const padding = pad(current)
				drag = { kind: 'resize', index: selected.value!, corner, startBox: box, from: markBounds(current, w, h, measure), orig: current, pad: padding, moved: false }
				return
			}
		}
		const hit = hitMark(marks.value, p, w, h, measure, tolerance())
		selected.value = hit >= 0 ? hit : null
		if (hit >= 0) drag = { kind: 'move', index: hit, start: p, orig: marks.value[hit], moved: false }
		return
	}

	if (tool.value === 'text') {
		const hit = hitMark(marks.value, p, w, h, measure, tolerance())
		if (hit >= 0 && marks.value[hit].tool === 'text') editText(hit)
		else startText({ x: p.x / w, y: p.y / h })
		return
	}

	const q = { x: p.x / w, y: p.y / h }
	drag = { kind: 'draw', mark: { tool: tool.value, color: color.value, size: size.value, points: [q, q] } }
}

const move = (e: PointerEvent) => {
	const p = at(e)
	const { w, h } = dims()
	if (!drag) {
		cursor.value = hoverCursor(p)
		return
	}
	if (drag.kind === 'draw') {
		const q = { x: p.x / w, y: p.y / h }
		if (drag.mark.tool === 'pen') drag.mark.points.push(q)
		else drag.mark.points = [drag.mark.points[0], q]
		redraw()
	} else if (drag.kind === 'move') {
		drag.moved = true
		marks.value = replaceAt(drag.index, moveMark(drag.orig, (p.x - drag.start.x) / w, (p.y - drag.start.y) / h))
	} else {
		drag.moved = true
		const box = resizeBox(drag.startBox, drag.corner, p, drag.pad * 2 + 4)
		const to = { x: box.x + drag.pad, y: box.y + drag.pad, w: box.w - drag.pad * 2, h: box.h - drag.pad * 2 }
		marks.value = replaceAt(drag.index, resizeMark(drag.orig, drag.from, to, w, h))
	}
}

const up = () => {
	const d = drag
	drag = null
	if (!d) return
	if (d.kind === 'draw') {
		// A click without a drag is not a mark.
		const pts = d.mark.points
		const span = pts.reduce((m, p) => Math.max(m, Math.hypot(p.x - pts[0].x, p.y - pts[0].y)), 0)
		if (span > 0.01) commit([...marks.value, d.mark])
		else redraw()
		return
	}
	// The drag changed `marks` live; the undo step is the state before it.
	if (d.moved) history.value = [...history.value, replaceAtIn(marks.value, d.index, d.orig)]
}
const replaceAtIn = (list: FrameMark[], index: number, mark: FrameMark) => list.map((m, i) => (i === index ? mark : m))

const hoverCursor = (p: { x: number; y: number }) => {
	if (tool.value === 'text') return 'text'
	if (tool.value !== 'select') return 'crosshair'
	const { w, h } = dims()
	const current = selectedMark.value
	const corner = current ? handleAt(selectionBox(current), p, tolerance()) : null
	if (corner) return corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize'
	return hitMark(marks.value, p, w, h, measure, tolerance()) >= 0 ? 'move' : 'default'
}

const dblclick = (e: MouseEvent) => {
	if (tool.value !== 'select') return
	const { w, h } = dims()
	const hit = hitMark(marks.value, at(e), w, h, measure, tolerance())
	if (hit >= 0 && marks.value[hit].tool === 'text') editText(hit)
}

// ===== Text =====

const startText = (anchor: { x: number; y: number }) => {
	selected.value = null
	editing.value = { index: null, x: anchor.x, y: anchor.y, text: '', color: color.value, size: size.value }
	nextTick(() => textRef.value?.focus())
}
const editText = (index: number) => {
	const mark = marks.value[index]
	selected.value = index
	editing.value = { index, x: mark.points[0].x, y: mark.points[0].y, text: mark.text ?? '', color: mark.color, size: mark.size ?? SIZE_DEFAULT }
	nextTick(() => {
		const el = textRef.value
		if (!el) return
		el.focus()
		el.setSelectionRange(el.value.length, el.value.length)
	})
}
/** Ends typing: the words become (or update) a mark; no words, no mark. */
function finishText() {
	const e = editing.value
	if (!e) return
	editing.value = null
	const text = e.text.replace(/\s+$/, '')
	const mark: FrameMark = { tool: 'text', color: e.color, size: e.size, text, points: [{ x: e.x, y: e.y }] }
	if (e.index === null) {
		if (text.trim()) {
			commit([...marks.value, mark])
			selected.value = tool.value === 'select' ? marks.value.length - 1 : null
		}
		return
	}
	const before = marks.value[e.index]
	if (!text.trim()) commit(marks.value.filter((_, i) => i !== e.index))
	else if (before.text !== text || before.color !== e.color || before.size !== e.size) commit(replaceAt(e.index, mark))
	rootRef.value?.focus()
}

/** The field sits exactly where the drawn text will: same font, size and anchor (in CSS pixels). */
const editorStyle = computed(() => {
	const e = editing.value
	const canvas = canvasRef.value
	if (!e || !canvas) return {}
	const px = fontPx({ size: e.size }, canvas.width, canvas.height) / dpr()
	return {
		left: `${e.x * 100}%`,
		top: `${e.y * 100}%`,
		font: markFont(px),
		lineHeight: String(LINE_HEIGHT),
		color: e.color,
		minWidth: `${px}px`,
		maxWidth: `${(1 - e.x) * 100}%`,
		fieldSizing: 'content'
	} as Record<string, string>
})

// ===== Keys and saving =====

const removeSelected = () => {
	if (selected.value === null) return
	const index = selected.value
	selected.value = null
	commit(marks.value.filter((_, i) => i !== index))
}

const onKey = (e: KeyboardEvent) => {
	const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement
	// While text is being typed, Esc (from anywhere in the editor) or ⌘Enter
	// finishes it and never closes the editor; plain Enter adds a line.
	if (editing.value && (e.key === 'Escape' || (typing && e.key === 'Enter' && (e.metaKey || e.ctrlKey)))) {
		e.preventDefault()
		finishText()
		return
	}
	if (typing) return
	const key = e.key.toLowerCase()
	if (e.key === 'Escape') {
		if (selected.value !== null) selected.value = null
		else emit('close')
	} else if ((e.metaKey || e.ctrlKey) && key === 'z') {
		e.preventDefault()
		undo()
	} else if (e.key === 'Delete' || e.key === 'Backspace') {
		e.preventDefault()
		removeSelected()
	} else if (!e.metaKey && !e.ctrlKey && !e.altKey) {
		const t = tools.find((x) => x.key === key)
		if (t) pickTool(t.id)
	}
}

const save = async () => {
	finishText()
	saving.value = true
	error.value = ''
	try {
		const a = props.attachment
		const drawn = marks.value.length ? await composeMarked(a.original, marks.value) : null
		store.updatePromptAttachment(a.id, {
			marks: marks.value,
			data: drawn?.data ?? a.original,
			// Without marks, back to a thumbnail of the untouched frame.
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
