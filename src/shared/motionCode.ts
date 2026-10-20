/**
 * Custom HTML motion layers: everything about WRITING one that can be decided
 * without a window — board 5 of the design.
 *
 * The page contract and the lint live in motion.ts. This module is what the
 * code view, the checks panel and the AI's `updateMotion.html` share:
 *
 *   extractMotionDefinition  read `frameflow.define({...})` out of the text, so
 *                            "Settings it exposes", the Settings tab and the
 *                            keyframe lanes follow the code as it is typed;
 *   buildChecks              the lint plus the runtime checks, folded into the
 *                            rows the panel draws and the one verdict that
 *                            decides whether a version may be drawn;
 *   editedSpec / writtenSpec how an edit becomes a spec — passing text becomes
 *                            the new `passed` version, failing text does not;
 *   provenanceLabel          "Written by Claude Code in V8 · edited by you";
 *   fixPrompt                what "Ask AI to fix" sends.
 *
 * No Node or Electron imports: it runs in the renderer, in main and in tests.
 */
import {
	BLANK_MOTION_DEFINITION, blankComments, motionTemplate, lintMotionHtml, normaliseDefinition, renderVersion, sanitiseSetting,
	type MotionAuthor, type MotionDefinition, type MotionLintIssue, type MotionMomentDef, type MotionSettingDef,
	type MotionSnapshot, type MotionSpec
} from './motion'

// ===== What can be keyframed =====

/**
 * A line for whoever wrote a page, naming the settings a person can set but
 * cannot keyframe — or null when there is nothing to say.
 *
 * Keyframing is opt-in per setting (`animate: true`), and the bare shorthand
 * `settings: { jacket: "#7A5BC4" }` has nowhere to say it. A page written that
 * way is valid, so nothing fails, and an author who was asked for a keyframable
 * field would report it as done. This puts the fact in the result they read.
 */
export function keyframingNote(label: string, definition: MotionDefinition | undefined): string | null {
	const fixed = (definition?.settings ?? []).filter((s) => s.type !== 'text' && !s.animate).map((s) => s.key)
	if (!fixed.length) return null
	const names = fixed.map((k) => `"${k}"`).join(', ')
	return `"${label}": ${names} ${fixed.length === 1 ? 'is a setting but is' : 'are settings but are'} not keyframable. `
		+ 'Declare it in the object form with `animate: true` (e.g. `key: { default: "#7A5BC4", animate: true }`) to give it a keyframe lane; '
		+ 'the bare `key: value` form cannot. Only tell the user it is keyframable if you did.'
}

// ===== Reading frameflow.define(...) out of the text =====

/** A value the reader could not evaluate (a variable, a call, a function). */
const UNPARSED = Symbol('unparsed')
type Raw = unknown

interface Cursor {
	s: string
	i: number
}

const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r'
const isIdStart = (c: string) => /[A-Za-z_$]/.test(c)
const isIdPart = (c: string) => /[\w$]/.test(c)

function skipWs(c: Cursor): void {
	while (c.i < c.s.length && isWs(c.s[c.i])) c.i++
}

/** Past the closing quote of a string that opens at c.i; returns its text. */
function readString(c: Cursor): string | typeof UNPARSED {
	const quote = c.s[c.i++]
	let out = ''
	while (c.i < c.s.length) {
		const ch = c.s[c.i++]
		if (ch === '\\') {
			const next = c.s[c.i++]
			out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next
		} else if (ch === quote) {
			return out
		} else if (quote === '`' && ch === '$' && c.s[c.i] === '{') {
			return UNPARSED
		} else {
			out += ch
		}
	}
	return UNPARSED
}

/**
 * Step over one expression the reader does not understand, stopping at the
 * `,` or closing bracket that ends it at depth 0. Strings and template
 * literals are skipped whole so a comma inside one does not end it early.
 */
function skipExpression(c: Cursor): void {
	let depth = 0
	while (c.i < c.s.length) {
		const ch = c.s[c.i]
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch
			c.i++
			while (c.i < c.s.length && c.s[c.i] !== quote) c.i += c.s[c.i] === '\\' ? 2 : 1
			c.i++
			continue
		}
		if (ch === '(' || ch === '[' || ch === '{') depth++
		else if (ch === ')' || ch === ']' || ch === '}') {
			if (depth === 0) return
			depth--
		} else if (ch === ',' && depth === 0) return
		c.i++
	}
}

function parseValue(c: Cursor): Raw {
	skipWs(c)
	const ch = c.s[c.i]
	let value: Raw
	if (ch === '{') value = parseObject(c)
	else if (ch === '[') value = parseArray(c)
	else if (ch === '"' || ch === "'" || ch === '`') value = readString(c)
	else if (/[-+.\d]/.test(ch ?? '')) {
		const m = /^[-+]?(?:0[xX][\da-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(c.s.slice(c.i))
		if (m) {
			c.i += m[0].length
			value = Number(m[0])
		} else value = UNPARSED
	} else {
		const m = /^[A-Za-z_$][\w$]*/.exec(c.s.slice(c.i))
		const word = m?.[0]
		if (word === 'true' || word === 'false') { c.i += word.length; value = word === 'true' }
		else if (word === 'null' || word === 'undefined') { c.i += word.length; value = null }
		else value = UNPARSED
	}
	// A literal followed by an operator (`4 * 2`, `'a' + b`) is an expression.
	skipWs(c)
	const next = c.s[c.i]
	if (c.i < c.s.length && next !== ',' && next !== '}' && next !== ']' && next !== ')') {
		skipExpression(c)
		return UNPARSED
	}
	if (value === UNPARSED) {
		// Identifier, call, arrow function: nothing consumed yet — consume it.
		skipExpression(c)
	}
	return value
}

function parseArray(c: Cursor): Raw {
	c.i++ // [
	const out: Raw[] = []
	for (;;) {
		skipWs(c)
		if (c.i >= c.s.length) return UNPARSED
		if (c.s[c.i] === ']') { c.i++; return out }
		out.push(parseValue(c))
		skipWs(c)
		if (c.s[c.i] === ',') c.i++
	}
}

function skipBalanced(c: Cursor, open: string, close: string): void {
	let depth = 0
	while (c.i < c.s.length) {
		const ch = c.s[c.i]
		if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch
			c.i++
			while (c.i < c.s.length && c.s[c.i] !== quote) c.i += c.s[c.i] === '\\' ? 2 : 1
			c.i++
			continue
		}
		if (ch === open) depth++
		else if (ch === close) { depth--; if (depth === 0) { c.i++; return } }
		c.i++
	}
}

function parseObject(c: Cursor): Raw {
	c.i++ // {
	const out: Record<string, Raw> = {}
	for (;;) {
		skipWs(c)
		if (c.i >= c.s.length) return UNPARSED
		if (c.s[c.i] === '}') { c.i++; return out }
		// Key: identifier, quoted string or number.
		let key: string
		const ch = c.s[c.i]
		if (ch === '"' || ch === "'") {
			const k = readString(c)
			if (k === UNPARSED) return UNPARSED
			key = k
		} else if (isIdStart(ch)) {
			const start = c.i
			while (c.i < c.s.length && isIdPart(c.s[c.i])) c.i++
			key = c.s.slice(start, c.i)
		} else if (/\d/.test(ch)) {
			const start = c.i
			while (c.i < c.s.length && /[\d.]/.test(c.s[c.i])) c.i++
			key = c.s.slice(start, c.i)
		} else {
			return UNPARSED
		}
		skipWs(c)
		if (c.s[c.i] === ':') {
			c.i++
			out[key] = parseValue(c)
		} else if (c.s[c.i] === '(') {
			// Method shorthand: `seek(t, s) { … }`.
			skipBalanced(c, '(', ')')
			skipWs(c)
			if (c.s[c.i] === '{') skipBalanced(c, '{', '}')
			out[key] = UNPARSED
		} else {
			// Property shorthand: `{ duration, seek }`.
			out[key] = UNPARSED
		}
		skipWs(c)
		if (c.s[c.i] === ',') c.i++
	}
}

/** The object literal handed to `frameflow.define`, or null when there is none. */
export function parseDefineCall(html: string): Record<string, Raw> | null {
	const source = blankComments(html)
	const call = /\bframeflow\s*\.\s*define\s*\(\s*/.exec(source)
	if (!call) return null
	const c: Cursor = { s: source, i: call.index + call[0].length }
	if (source[c.i] !== '{') return null
	const value = parseObject(c)
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, Raw> : null
}

// ===== Definitions from loose input =====

const TYPE_ALIASES: Record<string, MotionSettingDef['type']> = {
	number: 'number', num: 'number', range: 'number', slider: 'number', int: 'number', integer: 'number', float: 'number',
	text: 'text', string: 'text', str: 'text',
	color: 'color', colour: 'color',
	enum: 'enum', select: 'enum', choice: 'enum', option: 'enum'
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const isRecord = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === 'object' && !Array.isArray(v)
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())

/** `accentColour` → "Accent colour". */
export function humaniseKey(key: string): string {
	const words = key.replace(/[_-]+/g, ' ').replace(/([a-z\d])([A-Z])/g, '$1 $2').trim().toLowerCase()
	return words ? words[0].toUpperCase() + words.slice(1) : key
}

function coerceSetting(key: string | undefined, raw: unknown, problems: string[]): MotionSettingDef | null {
	// A bare value is its own default: `label: 'faster triage'`.
	const v: Record<string, unknown> = isRecord(raw) ? raw : { default: raw }
	const name = typeof v.key === 'string' && v.key ? v.key : typeof v.name === 'string' && v.name ? v.name : key
	if (!name) return null

	let type = typeof v.type === 'string' ? TYPE_ALIASES[v.type.toLowerCase()] : undefined
	if (!type && v.type !== undefined) {
		problems.push(`Setting "${name}" has type "${String(v.type)}", which is not number, text, color or enum.`)
		return null
	}
	const given = v.default ?? v.value
	if (!type) type = finite(given) ? 'number' : isHex(given) ? 'color' : Array.isArray(v.options) ? 'enum' : 'text'

	const out: MotionSettingDef = {
		key: name,
		label: typeof v.label === 'string' && v.label.trim() ? v.label.trim() : humaniseKey(name),
		type,
		default: type === 'number' ? 0 : type === 'color' ? '#FFFFFF' : ''
	}
	if (type === 'number') {
		if (finite(v.min)) out.min = v.min
		if (finite(v.max)) out.max = v.max
		if (finite(v.step)) out.step = v.step
		if (typeof v.unit === 'string') out.unit = v.unit
	}
	if (type === 'enum') {
		const options = (Array.isArray(v.options) ? v.options : [])
			.map((o): { value: string; label: string } | null => {
				if (typeof o === 'string' || finite(o)) return { value: String(o), label: String(o) }
				if (isRecord(o) && (typeof o.value === 'string' || finite(o.value))) {
					return { value: String(o.value), label: typeof o.label === 'string' ? o.label : String(o.value) }
				}
				return null
			})
			.filter((o): o is { value: string; label: string } => !!o)
		if (!options.length) {
			problems.push(`Setting "${name}" is an enum with no options.`)
			return null
		}
		out.options = options
		out.default = options[0].value
	}
	if (type === 'text' && v.multiline === true) out.multiline = true
	if (v.animate === true && type !== 'text') out.animate = true
	// A default that does not fit its type is dropped, not coerced: a colour
	// written `#abc` becomes the fallback, not `#ABC`.
	const fits =
		type === 'number' ? finite(given) || (typeof given === 'string' && given.trim() !== '' && finite(Number(given)))
			: type === 'color' ? isHex(given)
				: type === 'enum' ? out.options!.some((o) => o.value === String(given))
					: typeof given === 'string' || finite(given)
	if (fits) out.default = given as MotionSettingDef['default']
	out.default = sanitiseSetting(out, out.default)
	return out
}

function coerceSettings(raw: unknown, problems: string[]): MotionSettingDef[] {
	const out: MotionSettingDef[] = []
	const seen = new Set<string>()
	const push = (s: MotionSettingDef | null) => {
		if (!s) return
		if (seen.has(s.key)) { problems.push(`Setting "${s.key}" is defined twice; the first wins.`); return }
		seen.add(s.key)
		out.push(s)
	}
	if (Array.isArray(raw)) for (const item of raw) push(coerceSetting(undefined, item, problems))
	else if (isRecord(raw)) for (const [key, value] of Object.entries(raw)) push(coerceSetting(key, value, problems))
	return out
}

function coerceMoments(raw: unknown, duration: number): MotionMomentDef[] {
	interface Window { name: string; start?: number; duration?: number; end?: number; flex?: boolean }
	const windows: Window[] = []
	const read = (name: string | undefined, v: unknown) => {
		if (finite(v)) { if (name) windows.push({ name, duration: v }); return }
		if (Array.isArray(v) && finite(v[0]) && finite(v[1]) && name) {
			windows.push({ name, start: v[0], end: v[1] }); return
		}
		if (!isRecord(v)) return
		const n = typeof v.name === 'string' && v.name ? v.name : name
		if (!n) return
		const start = finite(v.start) ? v.start : finite(v.from) ? v.from : undefined
		const end = finite(v.end) ? v.end : finite(v.to) ? v.to : undefined
		windows.push({
			name: n,
			duration: finite(v.duration) ? v.duration : undefined,
			start, end, flex: v.flex === true
		})
	}
	if (Array.isArray(raw)) for (const item of raw) read(undefined, item)
	else if (isRecord(raw)) for (const [name, value] of Object.entries(raw)) read(name, value)

	// Windows given as [start, end] ranges rather than lengths: lay them end to
	// end, and give whatever time falls between them to a flexible `hold`.
	if (windows.some((w) => w.start !== undefined && w.end !== undefined)) {
		const ranged = windows
			.filter((w) => w.start !== undefined && w.end !== undefined && w.end > w.start)
			.sort((a, b) => a.start! - b.start!)
		const out: MotionMomentDef[] = []
		let at = 0
		const gaps: { index: number; length: number }[] = []
		const gapName = () => (out.some((m) => m.name === 'hold') ? `gap${gaps.length + 1}` : 'hold')
		for (const w of ranged) {
			if (w.start! - at > 1e-6) {
				gaps.push({ index: out.length, length: w.start! - at })
				out.push({ name: gapName(), duration: w.start! - at })
			}
			out.push({ name: w.name, duration: w.end! - w.start!, flex: w.flex })
			at = w.end!
		}
		if (duration - at > 1e-6) {
			gaps.push({ index: out.length, length: duration - at })
			out.push({ name: gapName(), duration: duration - at })
		}
		if (!out.some((m) => m.flex) && gaps.length) {
			const biggest = gaps.reduce((a, b) => (b.length > a.length ? b : a))
			out[biggest.index].flex = true
		}
		return out
	}
	return windows
		.filter((w) => finite(w.duration) && w.duration >= 0)
		.map((w) => ({ name: w.name, duration: w.duration!, flex: w.flex }))
}

/**
 * A definition from whatever shape the author wrote: `settings` as an array of
 * `{key, type, default}` or as a map of key → `{type, default}`; `moments` as
 * `[{name, duration}]`, as name → length, or as name → `[start, end]`. Repairs
 * rather than rejects (see `normaliseDefinition`), and says what it fixed.
 */
export function coerceDefinition(raw: unknown): { definition: MotionDefinition; problems: string[] } {
	const problems: string[] = []
	const input = isRecord(raw) ? raw : {}
	const duration = finite(input.duration) && input.duration > 0 ? input.duration : 3
	if (!finite(input.duration) || input.duration <= 0) problems.push('duration is missing or not a positive number; using 3 seconds.')
	const definition = normaliseDefinition({
		duration,
		settings: coerceSettings(input.settings, problems),
		moments: coerceMoments(input.moments, duration)
	})
	return { definition, problems }
}

export interface ExtractedDefinition {
	/** A `frameflow.define({…})` call with an object literal was found. */
	found: boolean
	definition?: MotionDefinition
	/**
	 * Every part of the definition was a literal. When false (`duration: DUR`),
	 * the page's own report at run time is the better source.
	 */
	complete: boolean
	problems: string[]
}

/**
 * What the page exposes, read from its text — no window, no execution. This is
 * what "Settings it exposes" lists, and what the ops path stores so a layer an
 * agent writes has its settings before anyone has loaded it.
 */
export function extractMotionDefinition(html: string): ExtractedDefinition {
	const raw = parseDefineCall(html)
	if (!raw) return { found: false, complete: false, problems: [] }
	const unresolved = ['duration', 'settings', 'moments'].filter((k) => k in raw && raw[k] === UNPARSED)
	const clean: Record<string, unknown> = {}
	for (const key of ['duration', 'settings', 'moments']) {
		if (key in raw && raw[key] !== UNPARSED) clean[key] = stripUnparsed(raw[key])
	}
	const { definition, problems } = coerceDefinition(clean)
	return {
		found: true,
		definition,
		complete: !unresolved.length && !containsUnparsed(raw.settings) && !containsUnparsed(raw.moments),
		problems: [
			...problems,
			...unresolved.map((k) => `${k} is not a literal, so it is read when the page runs.`)
		]
	}
}

function containsUnparsed(v: Raw): boolean {
	if (v === UNPARSED) return true
	if (Array.isArray(v)) return v.some(containsUnparsed)
	if (isRecord(v)) return Object.values(v).some(containsUnparsed)
	return false
}

/** Drop the parts the reader could not evaluate, keeping the rest. */
function stripUnparsed(v: Raw): unknown {
	if (v === UNPARSED) return undefined
	if (Array.isArray(v)) return v.filter((x) => x !== UNPARSED).map(stripUnparsed)
	if (isRecord(v)) {
		const out: Record<string, unknown> = {}
		for (const [k, x] of Object.entries(v)) if (x !== UNPARSED) out[k] = stripUnparsed(x)
		return out
	}
	return v
}

// ===== "Settings it exposes" =====

export interface ExposedSetting {
	key: string
	/** ◆ — the setting has a keyframe lane. */
	animate: boolean
	/** "number · 3", "text", "colour · #EC4899", "enum · bar". */
	detail: string
}

/** The board's right-hand list, one row per setting. */
export function exposedSettings(definition: MotionDefinition): ExposedSetting[] {
	return definition.settings.map((s) => {
		const kind = s.type === 'color' ? 'colour' : s.type
		const shows = s.type === 'text' ? null : String(s.default)
		return {
			key: s.key,
			animate: !!s.animate && s.type !== 'text',
			detail: shows === null ? kind : `${kind} · ${shows}`
		}
	})
}

// ===== Checks =====

/** The fonts bundled with every motion page (Inter, Outfit). */
export const BUNDLED_MOTION_FONTS = ['Inter', 'Outfit']

/** Which bundled families the page names — "No network; fonts bundled (Outfit)". */
export function bundledFontsUsed(html: string): string[] {
	const families = [...blankComments(html).matchAll(/font(?:-family)?\s*:[^;}\n]*/gi)].map((m) => m[0].toLowerCase())
	return BUNDLED_MOTION_FONTS.filter((f) => families.some((text) => text.includes(f.toLowerCase())))
}

export type CheckStatus = 'pass' | 'fail' | 'pending'

/** What the runtime checks found (the hidden-window probe). */
export interface RuntimeReport {
	/** `skipped`: the probe could not run, which neither passes nor blocks. */
	determinism: 'pass' | 'fail' | 'pending' | 'skipped'
	/** Page seconds at which two renders of the same instant first differed. */
	differsAt?: number
	/** The page threw while loading or seeking. */
	error?: string
	/**
	 * The definition the page itself passed to `define`, read at run time. The
	 * truth when its `define` call is not a literal the text reader can evaluate.
	 */
	definition?: MotionDefinition
}

export interface CheckRow {
	id: 'timing' | 'network' | 'determinism'
	status: CheckStatus
	label: string
}

export interface CheckIssue {
	id: string
	/** "Line 14 reads the clock". */
	title: string
	/** Backticks mark code: "Draw only from `t`." */
	detail: string
	/** 1-based; absent for a problem with the page as a whole. */
	line?: number
	excerpt?: string
	rule: MotionLintIssue['rule'] | 'runtime' | 'determinism'
}

export interface MotionChecks {
	rows: CheckRow[]
	issues: CheckIssue[]
	/** Every check settled and none failed: this version may be drawn. */
	passing: boolean
	/** Nothing is still running. */
	settled: boolean
	/** Lines to mark in the code view. */
	failingLines: number[]
}

const TIMING_RULES: ReadonlySet<string> = new Set(['css-animation', 'timer', 'animation-frame', 'random'])
const NETWORK_RULES: ReadonlySet<string> = new Set(['network', 'remote-url'])

const ISSUE_TITLES: Record<MotionLintIssue['rule'], string> = {
	'css-animation': 'animates in CSS',
	timer: 'starts a timer',
	clock: 'reads the clock',
	random: 'uses random numbers',
	'animation-frame': 'waits for animation frames',
	network: 'reaches for the network',
	'remote-url': 'loads a remote file',
	'no-define': ''
}

function issueFromLint(issue: MotionLintIssue, index: number): CheckIssue {
	if (issue.rule === 'no-define') {
		return {
			id: `lint-${index}`, rule: issue.rule, line: issue.line,
			title: 'The page never calls frameflow.define',
			detail: 'Nothing can drive it. Call `frameflow.define({ duration, settings, moments, seek })`.'
		}
	}
	return {
		id: `lint-${index}`, rule: issue.rule, line: issue.line, excerpt: issue.excerpt,
		title: `Line ${issue.line} ${ISSUE_TITLES[issue.rule]}`,
		detail: issue.rule === 'clock'
			? 'The export would flicker differently from the preview. Draw only from `t`.'
			: issue.message
	}
}

/**
 * Fold the lint and the runtime report into what the panel draws.
 *
 * Three fixed rows, as the design has them — each fails when anything in its
 * family does — and one issue row per problem, with its line. A clock read is
 * an issue of its own rather than a failure of "no timers or random": the
 * runtime pins the clock to zero, so the pixels still agree, and the row says
 * so truthfully.
 */
export function buildChecks(html: string, runtime: RuntimeReport = { determinism: 'skipped' }): MotionChecks {
	const lint = lintMotionHtml(html)
	const issues = lint.issues.map(issueFromLint)
	if (runtime.error) {
		issues.push({
			id: 'runtime', rule: 'runtime', title: 'The page threw an error',
			detail: runtime.error
		})
	}
	if (runtime.determinism === 'fail') {
		issues.push({
			id: 'determinism', rule: 'determinism', title: 'The same frame drew two different ways',
			detail: runtime.differsAt === undefined
				? 'Drawing one instant twice gave different pixels, so the export would not match the preview.'
				: `Drawing t = ${runtime.differsAt.toFixed(2)}s twice gave different pixels, so the export would not match the preview.`
		})
	}

	const familyFails = (rules: ReadonlySet<string>): CheckStatus =>
		lint.issues.some((i) => rules.has(i.rule)) ? 'fail' : 'pass'
	const fonts = bundledFontsUsed(html)
	const determinism: CheckStatus =
		runtime.error || runtime.determinism === 'fail' ? 'fail'
			: runtime.determinism === 'pending' ? 'pending' : 'pass'

	const rows: CheckRow[] = [
		{ id: 'timing', status: familyFails(TIMING_RULES), label: 'No CSS animations, timers, or random' },
		{
			id: 'network', status: familyFails(NETWORK_RULES),
			label: `No network; fonts bundled${fonts.length ? ` (${fonts.join(', ')})` : ''}`
		},
		{ id: 'determinism', status: determinism, label: 'Same frame twice gives the same pixels' }
	]
	const settled = runtime.determinism !== 'pending'
	return {
		rows, issues, settled,
		passing: settled && issues.length === 0,
		failingLines: [...new Set(issues.map((i) => i.line).filter((l): l is number => typeof l === 'number'))].sort((a, b) => a - b)
	}
}

// ===== Edits become versions =====

/** The version the layer draws today, as a snapshot — or null when there is none. */
export function lastPassingOf(spec: MotionSpec | undefined): MotionSnapshot | null {
	if (!spec) return null
	const template = motionTemplate(spec.template)
	if (template) return { html: template.html, definition: template.definition }
	if (spec.passed !== undefined) return spec.passed
	// Predates the checks: its text is the version, if it would have passed.
	const own = typeof spec.html === 'string' && spec.html.trim() ? spec.html : null
	if (own && lintMotionHtml(own).ok) return { html: own, definition: spec.definition }
	return null
}

/** A person's edit keeps the original author and notes that it was edited. */
function authorAfterYourEdit(author: MotionAuthor | undefined): MotionAuthor {
	if (!author) return { by: 'you' }
	if (author.by === 'you') return author
	return author.editedByYou ? author : { ...author, editedByYou: true }
}

/**
 * The spec after a person edits the page's text.
 *
 * `passed` says whether it cleared every check (static and runtime). If so the
 * text becomes the version that is drawn; if not it is kept for editing, and
 * the layer carries on drawing the last version that did pass.
 */
export function editedSpec(
	spec: MotionSpec,
	text: string,
	outcome: { passed: boolean; definition?: MotionDefinition }
): MotionSpec {
	if (text === spec.html && (outcome.passed ? spec.passed?.html === text : true)) return spec
	const definition = outcome.definition ?? extractMotionDefinition(text).definition ?? spec.definition
	const previous = lastPassingOf(spec)
	return {
		...spec,
		html: text,
		definition,
		passed: outcome.passed ? { html: text, definition, verified: true } : previous,
		author: authorAfterYourEdit(spec.author)
	}
}

/**
 * The spec after an AI or an agent writes the page. Only the static checks can
 * run where this does (the ops path has no window), so text that lints clean is
 * drawn at once and the renderer's probe confirms it afterwards; text that
 * does not is kept as the working text and the layer keeps drawing what passed.
 */
export function writtenSpec(
	spec: MotionSpec | undefined,
	text: string,
	author: { by: string; turnId?: string }
): MotionSpec {
	const base: MotionSpec = spec ?? {}
	const { found, definition: parsed } = extractMotionDefinition(text)
	const definition = parsed ?? base.definition ?? BLANK_MOTION_DEFINITION
	const ok = found && lintMotionHtml(text).ok
	return {
		...base,
		template: undefined,
		html: text,
		definition,
		passed: ok ? { html: text, definition } : (lastPassingOf(base) ?? null),
		author: { by: author.by, turnId: author.turnId }
	}
}

/** The page this layer draws, if it has not been probed yet. */
export function unverifiedPage(spec: MotionSpec | undefined): MotionSnapshot | null {
	if (!spec || spec.template || !spec.passed || spec.passed.verified) return null
	return spec.passed
}

/** The probe passed on `html`: mark the version that draws it as verified. */
export function verifiedSpec(spec: MotionSpec, html: string): MotionSpec {
	if (!spec.passed || spec.passed.html !== html || spec.passed.verified) return spec
	return { ...spec, passed: { ...spec.passed, verified: true } }
}

/**
 * The probe failed on `html`, the page this layer draws: draw nothing rather
 * than a page that fails. The text stays, as the working copy to fix.
 */
export function failedSpec(spec: MotionSpec, html: string): MotionSpec {
	if (!spec.passed || spec.passed.html !== html) return spec
	return { ...spec, passed: null }
}

export type MotionStatus =
	| { state: 'template' }
	/** The working text is what is drawn. */
	| { state: 'ok' }
	/** The text fails its checks; an older version that passed is drawn. */
	| { state: 'last-passing' }
	/** The text fails and nothing has ever passed: nothing is drawn. */
	| { state: 'nothing' }

/** Is this layer drawing its own working text, an older version, or nothing? */
export function motionStatus(spec: MotionSpec | undefined): MotionStatus {
	if (!spec || spec.template) return { state: 'template' }
	const version = renderVersion(spec)
	if (version.source === 'last-passing') return { state: 'last-passing' }
	if (version.source === 'nothing') return { state: 'nothing' }
	return { state: 'ok' }
}

/** The monitor's amber badge for a layer whose text fails; null when it is fine. */
export function motionBadge(spec: MotionSpec | undefined): string | null {
	const status = motionStatus(spec)
	if (status.state === 'last-passing') return 'Showing last version that passed'
	if (status.state === 'nothing') return 'No version has passed yet'
	return null
}

// ===== Provenance =====

/**
 * "Written by Claude Code in V8 · edited by you". `versionOf` finds the V
 * number of the revision a turn made; without one the version is left out.
 */
export function provenanceLabel(
	author: MotionAuthor | undefined,
	versionOf: (turnId: string) => number | null = () => null
): string {
	const by = !author || author.by === 'you' ? 'you' : author.by
	const version = author?.turnId ? versionOf(author.turnId) : null
	return [
		`Written by ${by}${version !== null ? ` in V${version}` : ''}`,
		by !== 'you' && author?.editedByYou ? 'edited by you' : ''
	].filter(Boolean).join(' · ')
}

// ===== Asking the AI =====

const MAX_PAGE_CHARS = 12_000

/**
 * What "Ask AI to fix" sends: the error, the line, the page — the editor prompt
 * is scoped to the layer by its id, and the answer is an `updateMotion.html`.
 */
export function fixPrompt(args: {
	layer: string
	itemId: string
	issue?: Pick<CheckIssue, 'title' | 'detail' | 'line' | 'excerpt'>
	html: string
}): string {
	const { layer, itemId, issue, html } = args
	const problem = issue
		? `${issue.title}. ${issue.detail.replace(/`/g, '')}${issue.excerpt ? `\nThe line: ${issue.excerpt}` : ''}`
		: 'It fails one of its checks.'
	return [
		`About the motion layer "${layer}" (item ${itemId}): its custom HTML page fails a check, so FrameFlow is showing an older version.`,
		'',
		`The problem: ${problem}`,
		'',
		'Fix it with updateMotion (id above) and the corrected whole page in `html`. Keep what the page looks like and every setting it exposes; draw only from `t` in seek(t, settings).',
		'',
		'The page now:',
		'```html',
		html.length > MAX_PAGE_CHARS ? `${html.slice(0, MAX_PAGE_CHARS)}\n… (cut)` : html,
		'```'
	].join('\n')
}

/** What the library's "describe it" sends for a new, blank custom layer. */
export function describePrompt(args: { layer: string; itemId: string; description: string }): string {
	return [
		`About the motion layer "${args.layer}" (item ${args.itemId}): it is a blank custom HTML layer. Write its page.`,
		'',
		`What I want: ${args.description.trim()}`,
		'',
		'Use updateMotion (id above) with the whole page in `html`. Follow the custom page contract: call frameflow.define({ duration, settings, moments, seek(t, settings) }) and draw only from t. Expose the text, numbers and colours I would want to change as settings.'
	].join('\n')
}

// ===== Library =====

/** One tile of the "This project" section. */
export interface ProjectCustomLayer {
	itemId: string
	name: string
	/** "custom · by Claude Code". */
	by: string
	html: string
	definition: MotionDefinition
}

/**
 * The custom layers in the project, one per distinct page — three placements of
 * the same page are one tile, the way three of a template are one template.
 */
export function projectCustomLayers(
	items: { id: string; label?: string; motion?: MotionSpec }[]
): ProjectCustomLayer[] {
	const seen = new Set<string>()
	const out: ProjectCustomLayer[] = []
	for (const item of items) {
		const spec = item.motion
		if (!spec || spec.template) continue
		const version = renderVersion(spec)
		const key = version.html
		if (seen.has(key)) continue
		seen.add(key)
		out.push({
			itemId: item.id,
			name: item.label?.trim() || 'Custom layer',
			by: `custom · by ${!spec.author || spec.author.by === 'you' ? 'you' : spec.author.by}`,
			html: version.html,
			definition: version.definition
		})
	}
	return out
}

/** `my-triage-stat`, unique among `taken`. */
export function templateId(label: string, taken: Iterable<string>): string {
	const base = `my-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer'}`
	const used = new Set(taken)
	if (!used.has(base)) return base
	let n = 2
	while (used.has(`${base}-${n}`)) n++
	return `${base}-${n}`
}

/** A tiny non-cryptographic hash (FNV-1a), for keying a verdict to a text. */
export function htmlHash(text: string): string {
	let h = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i)
		h = Math.imul(h, 0x01000193)
	}
	return (h >>> 0).toString(16).padStart(8, '0')
}

/** Why a layer cannot be saved as a template yet, or null when it can. */
export function saveAsTemplateBlocker(spec: MotionSpec | undefined, checks: Pick<MotionChecks, 'passing'>): string | null {
	if (!spec || spec.template) return 'Only a custom layer can be saved as a template.'
	if (!checks.passing) return 'Fix the failing checks first: a template must pass them.'
	if (!spec.passed || spec.passed.html !== spec.html) return 'Apply your latest edit first.'
	return null
}
