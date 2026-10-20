<template>
	<div ref="host" class="code-editor" :data-failing-lines="failingLines.join(',')"></div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, RangeSet, StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, EditorView, GutterMarker, keymap, lineNumberMarkers, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { html } from '@codemirror/lang-html'
import { tags as t } from '@lezer/highlight'

/**
 * The code view for a custom motion layer (board 5): line numbers, the board's
 * syntax colours, and the lines that fail their checks marked amber.
 *
 * CodeMirror 6 rather than a textarea under a highlighted <pre>: it is MIT,
 * modular (only the pieces below are bundled), and gives per-line decorations
 * and scroll-to-line for nothing — which is most of what this view is. It is a
 * thin wrapper on purpose; what an edit MEANS (debounce, checks, a history
 * step) is the inspector's business.
 */

const props = defineProps<{
	modelValue: string
	/** 1-based lines to mark amber. */
	failingLines: number[]
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null

// ===== Failing lines =====

const setFailing = StateEffect.define<number[]>()
const failingField = StateField.define<number[]>({
	create: () => [],
	update: (value, tr) => {
		for (const e of tr.effects) if (e.is(setFailing)) return e.value
		return value
	},
	provide: (field) => [
		EditorView.decorations.compute([field], (state) => {
			const lines = state.field(field).filter((n) => n >= 1 && n <= state.doc.lines)
			return Decoration.set(lines.map((n) => Decoration.line({ class: 'cm-failing' }).range(state.doc.line(n).from)))
		}),
		lineNumberMarkers.compute([field], (state) => {
			const lines = state.field(field).filter((n) => n >= 1 && n <= state.doc.lines)
			return RangeSet.of(lines.map((n) => failingNumber.range(state.doc.line(n).from)))
		})
	]
})

class FailingNumber extends GutterMarker {
	elementClass = 'cm-failing-num'
}
const failingNumber = new FailingNumber()

const sortedLines = (lines: number[]) => [...new Set(lines)].sort((a, b) => a - b)

// ===== Look (the design's palette) =====

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

const theme = EditorView.theme({
	'&': { backgroundColor: '#0c0c0e', color: '#d4d4d8', fontSize: '11px', height: '100%' },
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': { fontFamily: MONO, lineHeight: '18px', overflow: 'auto', padding: '10px 0' },
	'.cm-content': { padding: '0', caretColor: '#fafafa' },
	'.cm-line': { padding: '0 12px 0 0' },
	'.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: '#52525b' },
	'.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 0', minWidth: '28px', boxSizing: 'border-box', textAlign: 'right' },
	'.cm-failing': { backgroundColor: 'rgba(245,158,11,0.12)', boxShadow: 'inset 2px 0 0 #f59e0b' },
	'.cm-lineNumbers .cm-failing-num': {
		color: '#fbbf24', backgroundColor: 'rgba(245,158,11,0.12)', boxShadow: 'inset 2px 0 0 #f59e0b'
	},
	'.cm-cursor': { borderLeftColor: '#fafafa' },
	'&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(59,130,246,0.35)' },
	'.cm-matchingBracket': { backgroundColor: 'rgba(59,130,246,0.25)', outline: 'none' }
}, { dark: true })

// The board colours: keywords violet, strings green, numbers amber, comments
// and markup grey, function names blue.
const highlight = HighlightStyle.define([
	{ tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self, t.bool, t.null], color: '#c084fc' },
	{ tag: [t.string, t.special(t.string), t.regexp], color: '#34d399' },
	{ tag: [t.number, t.integer, t.float], color: '#fbbf24' },
	{ tag: [t.comment, t.lineComment, t.blockComment], color: '#71717a' },
	{ tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: '#60a5fa' },
	{ tag: [t.tagName, t.angleBracket, t.attributeName, t.attributeValue, t.documentMeta, t.processingInstruction], color: '#71717a' },
	{ tag: [t.propertyName, t.definition(t.propertyName)], color: '#e4e4e7' },
	{ tag: t.className, color: '#fbbf24' },
	{ tag: t.invalid, color: '#f87171' }
])

// ===== Lifecycle =====

onMounted(() => {
	if (!host.value) return
	view = new EditorView({
		parent: host.value,
		state: EditorState.create({
			doc: props.modelValue,
			extensions: [
				lineNumbers(),
				history(),
				indentOnInput(),
				bracketMatching(),
				html(),
				syntaxHighlighting(highlight),
				theme,
				failingField,
				EditorState.tabSize.of(2),
				keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
				EditorView.contentAttributes.of({ 'aria-label': 'Page source (HTML)', spellcheck: 'false' }),
				EditorView.updateListener.of((update) => {
					// A change that came FROM the model (undo, a revision switch) is not an edit.
					if (!update.docChanged || update.transactions.some((tr) => tr.annotation(Transaction.remote))) return
					emit('update:modelValue', update.state.doc.toString())
				})
			]
		})
	})
	view.dispatch({ effects: setFailing.of(sortedLines(props.failingLines)) })
})

onBeforeUnmount(() => {
	view?.destroy()
	view = null
})

watch(() => props.modelValue, (value) => {
	if (!view || value === view.state.doc.toString()) return
	view.dispatch({
		changes: { from: 0, to: view.state.doc.length, insert: value },
		annotations: Transaction.remote.of(true)
	})
})

watch(() => props.failingLines, (lines) => {
	view?.dispatch({ effects: setFailing.of(sortedLines(lines)) })
}, { deep: true })

/** Scroll to a 1-based line, select it and focus the editor. */
const jumpToLine = (n: number) => {
	if (!view) return
	const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Math.round(n))))
	view.dispatch({
		selection: { anchor: line.from, head: line.to },
		effects: EditorView.scrollIntoView(line.from, { y: 'center' })
	})
	view.focus()
}

defineExpose({ jumpToLine, focus: () => view?.focus() })
</script>

<style scoped>
.code-editor { min-height: 0; min-width: 0; }
.code-editor :deep(.cm-editor) { height: 100%; }
</style>
