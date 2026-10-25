<template>
	<div class="min-h-full flex flex-col" data-motion-code-tab>
		<!-- The page. Edits wait a beat, are checked, then become ONE undo step. -->
		<div class="rounded-lg border border-zinc-800 bg-[#0c0c0e] overflow-hidden flex flex-col min-h-[200px] flex-[1_1_260px]">
			<CodeEditor ref="editor" class="flex-1" v-model="draft" :failing-lines="checks.failingLines" />
		</div>

		<div class="pt-3.5 grid grid-cols-2 gap-4">
			<!-- Checks: the lint, then the page drawn twice in the hidden window -->
			<div class="min-w-0" data-motion-checks>
				<span class="lbl block mb-1">Checks</span>
				<div v-for="row in checks.rows" :key="row.id" class="chk" :data-check="row.id" :data-status="row.status">
					<span v-if="row.status === 'pending'" class="iconify tabler--loader-2 w-3 h-3 mt-0.5 animate-spin text-zinc-400" aria-label="Checking"></span>
					<span v-else class="text-xs font-bold leading-none mt-0.5" :class="row.status === 'pass' ? 'text-emerald-500' : 'text-amber-500'"
						:aria-label="row.status === 'pass' ? 'Passes' : 'Fails'">{{ row.status === 'pass' ? '✓' : '!' }}</span>
					<span class="text-[11px] leading-snug text-zinc-700 dark:text-zinc-300">{{ row.label }}</span>
				</div>
				<div v-for="(issue, i) in checks.issues" :key="issue.id" class="chk" :class="i === checks.issues.length - 1 ? '!border-b-0' : ''"
					data-check="issue" :data-line="issue.line">
					<span class="text-xs font-bold leading-none mt-0.5 text-amber-500">!</span>
					<span class="min-w-0">
						<span class="block text-[11px] leading-snug text-amber-600 dark:text-amber-400">{{ issue.title }}</span>
						<span class="block mt-0.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400 break-words">
							<template v-for="(part, k) in detailParts(issue.detail)" :key="k">
								<code v-if="part.code" class="mono">{{ part.text }}</code>
								<template v-else>{{ part.text }}</template>
							</template>
						</span>
						<span class="flex gap-1.5 mt-2">
							<button class="px-2 py-1 rounded-lg bg-secondary/10 text-violet-500 dark:text-violet-400 text-[9px] font-bold uppercase tracking-widest
							               hover:bg-secondary/20 transition disabled:opacity-50"
								:disabled="store.promptRunning" @click="askAi(issue)">Ask AI to fix</button>
							<button v-if="issue.line" class="px-2 py-1 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400
							               text-[9px] font-bold uppercase tracking-widest hover:border-primary/40 hover:text-primary transition"
								@click="editor?.jumpToLine(issue.line!)">Jump to line</button>
						</span>
					</span>
				</div>
			</div>

			<!-- Settings it exposes: read from frameflow.define as it is typed -->
			<div class="min-w-0" data-motion-exposed>
				<span class="lbl block mb-1">Settings it exposes</span>
				<template v-if="exposed.length">
					<div v-for="(row, i) in exposed" :key="row.key" class="chk" :class="i === exposed.length - 1 ? '!border-b-0' : ''" :data-setting="row.key">
						<span v-if="row.animate" class="text-blue-400 mt-[3px]" title="Can be keyframed">
							<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-label="Keyframable"><path d="M12 3l9 9-9 9-9-9z" /></svg>
						</span>
						<span v-else class="text-zinc-500 leading-none">—</span>
						<span class="flex justify-between gap-2 text-[11px] text-zinc-700 dark:text-zinc-300 min-w-0">
							<span class="truncate">{{ row.key }}</span>
							<span class="mono text-zinc-500 dark:text-zinc-400 shrink-0">{{ row.detail }}</span>
						</span>
					</div>
				</template>
				<p v-else class="text-[10px] leading-snug text-zinc-500 dark:text-zinc-400 py-2">
					{{ extracted.found ? 'The page defines no settings.' : 'Nothing yet: the page has to call frameflow.define.' }}
				</p>
				<p v-if="notLiteral" class="mt-1.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
					Part of the definition is computed, so FrameFlow reads it when the page runs.
				</p>
				<p class="mt-1.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
					These become fields on the Settings tab. ◆ means you can keyframe it, like any other property.
				</p>
			</div>
		</div>

		<!-- Who wrote it, and what to do with it -->
		<div class="mt-auto pt-3 border-t border-zinc-200 dark:border-zinc-800 flex flex-wrap items-center gap-2" data-motion-footer>
			<span class="mono text-[9px] text-zinc-500" data-provenance>{{ provenance }}</span>
			<span class="flex-1"></span>
			<span v-if="note" class="text-[10px]" :class="note.ok ? 'text-emerald-500' : 'text-amber-500'" role="status">{{ note.text }}</span>
			<button class="btn" :disabled="!!blocker" :title="blocker || 'Add this page to the library, for every project'"
				@click="naming = !naming">Save as template</button>
			<button class="btn !bg-primary !border-primary !text-white disabled:!opacity-50" :disabled="!pendingEdit"
				:title="pendingEdit ? 'Check and keep this edit now' : 'Nothing waiting'" @click="apply">Apply</button>
		</div>

		<form v-if="naming" class="mt-2 flex items-center gap-1.5" @submit.prevent="save">
			<input v-model="templateName" class="motion-inp !py-1" aria-label="Template name" placeholder="Template name" maxlength="40" />
			<button type="submit" class="btn" :disabled="!templateName.trim()">Save</button>
			<button type="button" class="btn" @click="naming = false">Cancel</button>
		</form>
	</div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { TimelineItem } from '@shared/types'
import { motionWorkingHtml, resolveDefinition } from '@shared/motion'
import {
	buildChecks, exposedSettings, extractMotionDefinition, provenanceLabel, saveAsTemplateBlocker,
	type CheckIssue, type RuntimeReport
} from '@shared/motionCode'
import { useEditorStore } from '../../stores/editorStore'
import CodeEditor from './CodeEditor.vue'

/**
 * The HTML tab of a custom motion layer (board 5).
 *
 * Typing never writes the project. Each edit starts a short wait; when it ends
 * the page is checked — the lint at once, then drawn twice in the hidden
 * window — and only then does ONE step go into the history, so undo takes a
 * whole edit back, not a keystroke. A page that fails its checks is kept as the
 * working text and the layer carries on drawing the last version that passed.
 */

const props = defineProps<{ item: TimelineItem }>()
const store = useEditorStore()

const DEBOUNCE_MS = 700

const spec = computed(() => props.item.motion!)
const working = computed(() => motionWorkingHtml(spec.value))

const editor = ref<InstanceType<typeof CodeEditor> | null>(null)
const draft = ref(working.value)
const runtime = ref<RuntimeReport>({ determinism: 'pending' })

// ===== What the text says =====

const extracted = computed(() => extractMotionDefinition(draft.value))
const checks = computed(() => buildChecks(draft.value, runtime.value))
/** The page's own report, when its define call is computed rather than literal. */
const effectiveDefinition = computed(() =>
	(!extracted.value.complete && runtime.value.definition) || extracted.value.definition || resolveDefinition(spec.value))
const exposed = computed(() => exposedSettings(effectiveDefinition.value))
const notLiteral = computed(() => extracted.value.found && !extracted.value.complete)

// ===== Edits: wait, check, commit =====

let timer: ReturnType<typeof setTimeout> | undefined
let token = 0

/** Text typed but not yet kept — or kept but not yet promoted to the drawn version. */
const pendingEdit = computed(() =>
	draft.value !== working.value ||
	(checks.value.passing && !!spec.value.passed && spec.value.passed.html !== draft.value))

const settle = async () => {
	clearTimeout(timer)
	const text = draft.value
	const mine = ++token
	runtime.value = { determinism: 'pending' }
	const report = await store.probeMotionHtml(text, extractMotionDefinition(text).definition ?? resolveDefinition(spec.value), spec.value?.kit)
	// A newer edit, or another layer, took over while the window was drawing.
	if (mine !== token || text !== draft.value) return
	runtime.value = report
	const verdict = buildChecks(text, report)
	const drawn = spec.value.passed?.html
	if (text !== working.value || (verdict.passing && drawn !== text)) {
		const definition = (!extractMotionDefinition(text).complete && report.definition) || extractMotionDefinition(text).definition
		store.commitMotionHtml(props.item.id, text, { passed: verdict.passing, definition })
	}
}

const schedule = () => {
	clearTimeout(timer)
	runtime.value = { determinism: 'pending' }
	timer = setTimeout(() => { void settle() }, DEBOUNCE_MS)
}

watch(draft, (value, old) => {
	if (value === old) return
	if (value === working.value && !pendingEdit.value) {
		// Typed back to what was kept: nothing to check or commit.
		clearTimeout(timer)
		void settle()
		return
	}
	schedule()
})

const apply = () => { void settle() }

/**
 * The project moved under the editor: an undo, a revision switch, an AI turn
 * that rewrote the page. What the store says wins over a half-typed draft.
 */
watch(working, (value) => {
	if (value === draft.value) return
	clearTimeout(timer)
	token++
	draft.value = value
	void settle()
})

/** A different layer: start over from its own text. */
watch(() => props.item.id, () => {
	flushPending()
	clearTimeout(timer)
	token++
	draft.value = working.value
	void settle()
})

/** Leaving with an edit still waiting keeps it, as a working copy, rather than losing it. */
const flushPending = () => {
	if (draft.value === working.value) return
	clearTimeout(timer)
	token++
	const text = draft.value
	const def = extractMotionDefinition(text)
	store.commitMotionHtml(props.item.id, text, { passed: false, definition: def.definition })
}
onBeforeUnmount(flushPending)

// First look: show what the probe says about the text as it stands.
void settle()

// ===== Ask the AI =====

const askAi = (issue: CheckIssue) => store.askAiToFixMotion(props.item.id, issue, draft.value)

/** "Draw only from `t`." → plain and code parts. */
const detailParts = (detail: string) =>
	detail.split(/`([^`]+)`/).map((text, i) => ({ text, code: i % 2 === 1 })).filter((p) => p.text)

// ===== Provenance and templates =====

const provenance = computed(() => provenanceLabel(
	spec.value.author,
	(turnId) => store.revisions.find((r) => r.turnId === turnId)?.seq ?? null))

const blocker = computed(() => saveAsTemplateBlocker(spec.value, checks.value) ?? (pendingEdit.value ? 'Apply your latest edit first.' : null))
const naming = ref(false)
const templateName = ref('')
const note = ref<{ ok: boolean; text: string } | null>(null)
let noteTimer: ReturnType<typeof setTimeout> | undefined

watch(naming, async (open) => {
	if (!open) return
	templateName.value = props.item.label || 'Custom layer'
	await nextTick()
})

const flash = (ok: boolean, text: string) => {
	note.value = { ok, text }
	clearTimeout(noteTimer)
	noteTimer = setTimeout(() => { note.value = null }, 5000)
}

const save = async () => {
	const label = templateName.value.trim()
	if (!label) return
	const result = await store.saveMotionAsTemplate(props.item.id, label)
	naming.value = false
	flash(result.ok, result.ok ? `Saved “${result.template.label}” to the library` : result.error)
}
</script>

<style scoped>
.lbl {
	font-size: 10px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: #71717a;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
.chk {
	display: grid;
	grid-template-columns: 18px minmax(0, 1fr);
	gap: 8px;
	align-items: start;
	padding: 8px 0;
	border-bottom: 1px solid rgba(113, 113, 122, 0.25);
}
.btn {
	padding: 6px 12px;
	border-radius: 12px;
	border: 1px solid #52525b;
	background: transparent;
	font-size: 12px;
	font-weight: 700;
	color: #71717a;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	cursor: pointer;
	transition: color 0.15s, border-color 0.15s, opacity 0.15s;
}
.btn:hover:not(:disabled) { border-color: rgba(59, 130, 246, 0.4); color: #3b82f6; }
.btn:disabled { opacity: 0.45; cursor: default; }
:global(.dark) .btn { color: #d4d4d8; border-color: #3f3f46; }
</style>
