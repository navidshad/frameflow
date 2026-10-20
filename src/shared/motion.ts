/**
 * Motion layers: an HTML page drawn as a pure function of time.
 *
 * The council studios make their films this way — a page exposes
 * `seek(t)`, a headless browser screenshots it frame by frame, ffmpeg encodes
 * the frames. FrameFlow does the same inside the editor, and the whole point of
 * this module is that the MONITOR and the EXPORT run the same page:
 *
 *   monitor — a sandboxed <iframe srcdoc> per active layer, seeked to the
 *             playhead by postMessage;
 *   export  — a hidden transparent window, seeked frame by frame, captured and
 *             piped to ffmpeg as an alpha-carrying intermediate.
 *
 * Both load the string `composeMotionPage` returns and both ask
 * `motionFrameState` what to show at an instant, so they agree by construction
 * rather than by two implementations kept in step.
 *
 * ## The page contract
 *
 *   frameflow.define({ duration, settings, moments, seek(t, settings) })
 *
 * `t` is the page's OWN seconds, 0..duration. `seek` must be a pure function of
 * `t` and `settings`: no CSS animations or transitions, no timers, no
 * `Date.now`, no `Math.random`, no requestAnimationFrame, no network. The
 * runtime neutralises those at load as well, but `lintMotionHtml` is what says
 * so to the person (or agent) who wrote the page.
 *
 * ## Moments
 *
 * A page's timeline is cut into named windows — typically in / hold / out —
 * that partition `duration`. A clip on the timeline can be longer or shorter
 * than the page, and can retime any window: the clip's own time maps onto the
 * page's piecewise-linearly, window by window. One window is FLEXIBLE (the
 * hold, by convention) and absorbs whatever length the clip has beyond the
 * others, which is why trimming a lower third lengthens its hold rather than
 * slowing its entrance.
 *
 * No Node or Electron imports: this runs in the renderer, in main and in tests.
 */
import type { TimelineItem, Track } from './types'
import { normalise, valueAt } from './keyframes'
import { MOTION_TEMPLATES, motionTemplate } from './motionTemplates'
import { MOTION_FONT_CSS } from './motion-templates/fonts'

// ===== Model =====

export type MotionSettingValue = number | string

export interface MotionSettingDef {
	key: string
	label: string
	type: 'number' | 'text' | 'color' | 'enum'
	default: MotionSettingValue
	/** Numbers only. */
	min?: number
	max?: number
	step?: number
	/** Shown after the value: 'px', '%', '×'. */
	unit?: string
	/** Enums only. */
	options?: { value: string; label: string }[]
	/**
	 * Keyframable. Numbers only — a colour or a string has no "halfway". The
	 * path is `motion.<key>` and the editor interpolates it with the same
	 * `valueAt` every other keyframe uses, then hands the page a plain number.
	 */
	animate?: boolean
	/** Text only: a textarea rather than a line. */
	multiline?: boolean
}

export interface MotionMomentDef {
	name: string
	/** Seconds of the PAGE's timeline this window spans. */
	duration: number
	/** The window that absorbs a clip's extra (or missing) length. */
	flex?: boolean
}

export interface MotionDefinition {
	duration: number
	settings: MotionSettingDef[]
	moments: MotionMomentDef[]
}

/**
 * What a timeline item stores. `template` names a bundled page; `html` is a
 * custom page's own source (stage 5 builds the editor for it). Exactly one of
 * the two applies — a template wins when both are set.
 */
export interface MotionSpec {
	template?: string
	html?: string
	/**
	 * A custom page's definition, as last reported by the page itself. Templates
	 * never carry one: theirs lives in the catalogue, so a fixed template is
	 * fixed everywhere it is used.
	 */
	definition?: MotionDefinition
	/** Values the user changed. Anything absent takes the setting's default. */
	settings?: Record<string, MotionSettingValue>
	/** Retimed windows, in CLIP seconds, by moment name. Never the flex one. */
	moments?: Record<string, number>
}

// ===== Tracks =====

/**
 * A motion layer's lane. An ordinary VIDEO track found by name — the way titles
 * live on `T1` and backgrounds on `BG` — so it composites in the stack like
 * everything else and the track model stays two families.
 */
export const MOTION_TRACK_NAME = 'M1'
export const isMotionTrack = (track: { name: string; kind: string } | undefined): boolean =>
	!!track && track.kind === 'video' && /^M\d+$/.test(track.name)

/**
 * The motion track a layer at [start, start + duration) should go on: the first
 * motion track (M1, M2, …) that is free then, or null when none is — the caller
 * makes the next one. Timing is the point of a motion layer, so a clash is
 * never resolved by sliding it later; the UI's drop and the AI's `addMotion`
 * both ask here, so a person and an agent place layers the same way.
 */
export function freeMotionTrack<T extends Pick<Track, 'id' | 'name' | 'kind' | 'locked' | 'hidden'>>(
	tracks: T[],
	items: Pick<TimelineItem, 'trackId' | 'timelineStart' | 'in' | 'out' | 'speed'>[],
	start: number,
	duration: number,
	ignoreId?: string
): T | null {
	const end = start + duration
	const lanes = tracks
		.filter((t) => isMotionTrack(t) && !t.locked && !t.hidden)
		.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
	for (const track of lanes) {
		const clash = items.some((i) =>
			(i as { id?: string }).id !== ignoreId &&
			i.trackId === track.id &&
			i.timelineStart < end - 1e-6 &&
			i.timelineStart + (i.out - i.in) / (i.speed || 1) > start + 1e-6)
		if (!clash) return track
	}
	return null
}

/** M1, then M2… — the first motion-track name not in use. */
export function nextMotionTrackName(tracks: Pick<Track, 'name'>[]): string {
	const taken = new Set(tracks.map((t) => t.name))
	let n = 1
	while (taken.has(`M${n}`)) n++
	return `M${n}`
}

/** The pink every motion surface uses (tailwind pink-500). */
export const MOTION_COLOUR = '#ec4899'

// ===== Definitions =====

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/** The smallest window anything resolves to. Keeps every division defined. */
const MIN_PAGE_SEC = 0.05

/**
 * A definition that can be trusted: a positive duration, moments that
 * partition it exactly, and exactly one flexible window.
 *
 * Pages are written by people and agents, so this repairs rather than rejects:
 * no moments becomes one flexible window over the whole page; moments that do
 * not add up have the flexible one take up the difference.
 */
export function normaliseDefinition(input: Partial<MotionDefinition> | undefined): MotionDefinition {
	const duration = finite(input?.duration) && input!.duration > 0 ? input!.duration : 3
	const settings = (input?.settings ?? [])
		.filter((s) => s && typeof s.key === 'string' && s.key && ['number', 'text', 'color', 'enum'].includes(s.type))
	let moments = (input?.moments ?? [])
		.filter((m) => m && typeof m.name === 'string' && m.name && finite(m.duration) && m.duration >= 0)
		.map((m) => ({ name: m.name, duration: m.duration, flex: !!m.flex }))
	if (!moments.length) moments = [{ name: 'all', duration, flex: true }]

	// Exactly one flexible window: the first flagged, else one called `hold`,
	// else the longest.
	let flex = moments.findIndex((m) => m.flex)
	if (flex < 0) flex = moments.findIndex((m) => m.name === 'hold')
	if (flex < 0) flex = moments.reduce((best, m, i) => (m.duration > moments[best].duration ? i : best), 0)
	moments = moments.map((m, i) => ({ ...m, flex: i === flex }))

	const fixed = moments.reduce((sum, m) => sum + (m.flex ? 0 : m.duration), 0)
	if (fixed <= duration) {
		moments[flex].duration = duration - fixed
	} else {
		// The fixed windows alone overrun the page: shrink them to fit.
		const scale = duration / fixed
		moments = moments.map((m) => ({ ...m, duration: m.flex ? 0 : m.duration * scale }))
	}
	return { duration, settings, moments }
}

/** A blank custom layer: something to start writing into. */
export const BLANK_MOTION_DEFINITION: MotionDefinition = normaliseDefinition({
	duration: 3,
	settings: [],
	moments: [
		{ name: 'in', duration: 0.5 },
		{ name: 'hold', duration: 2, flex: true },
		{ name: 'out', duration: 0.5 }
	]
})

export const BLANK_MOTION_HTML = [
	'<div id="card" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
	'font:700 6vh Inter,sans-serif;color:#fff">Custom motion</div>',
	'<script>',
	'  const card = document.getElementById("card")',
	'  frameflow.define({',
	'    duration: 3,',
	'    settings: [],',
	'    moments: [{ name: "in", duration: 0.5 }, { name: "hold", duration: 2, flex: true }, { name: "out", duration: 0.5 }],',
	'    seek(t) {',
	'      card.style.opacity = String(frameflow.progress("in", t) * (1 - frameflow.progress("out", t)))',
	'    }',
	'  })',
	'</script>'
].join('\n')

/** The definition that governs this spec — the catalogue's, for a template. */
export function resolveDefinition(spec: MotionSpec | undefined): MotionDefinition {
	const template = motionTemplate(spec?.template)
	if (template) return template.definition
	return spec?.definition ? normaliseDefinition(spec.definition) : BLANK_MOTION_DEFINITION
}

/** The page's own source, before composition. */
export function motionSource(spec: MotionSpec | undefined): string {
	const template = motionTemplate(spec?.template)
	if (template) return template.html
	return typeof spec?.html === 'string' && spec.html.trim() ? spec.html : BLANK_MOTION_HTML
}

/** "Lower third", or "Custom HTML". */
export function motionName(spec: MotionSpec | undefined): string {
	return motionTemplate(spec?.template)?.label ?? 'Custom HTML'
}

/** A fresh spec for a template, or a blank custom layer. */
export function newMotionSpec(templateId?: string): MotionSpec {
	if (templateId && motionTemplate(templateId)) return { template: templateId }
	return { html: BLANK_MOTION_HTML, definition: BLANK_MOTION_DEFINITION }
}

// ===== Settings =====

const HEX = /^#[0-9a-f]{6}$/i

/** One setting's value, made safe for its type. */
export function sanitiseSetting(def: MotionSettingDef, value: unknown): MotionSettingValue {
	switch (def.type) {
		case 'number': {
			const n = typeof value === 'string' ? Number(value) : value
			const fallback = finite(def.default) ? def.default : 0
			if (!finite(n)) return fallback
			return clamp(n, finite(def.min) ? def.min : -Infinity, finite(def.max) ? def.max : Infinity)
		}
		case 'color': {
			const s = typeof value === 'string' ? value.trim() : ''
			return HEX.test(s) ? s.toUpperCase() : String(def.default).toUpperCase()
		}
		case 'enum': {
			const s = String(value ?? '')
			return def.options?.some((o) => o.value === s) ? s : String(def.default)
		}
		default:
			return typeof value === 'string' ? value : value == null ? String(def.default) : String(value)
	}
}

/** Every setting's static value: defaults, overlaid by what the user set. */
export function settingValues(spec: MotionSpec | undefined, def = resolveDefinition(spec)): Record<string, MotionSettingValue> {
	const out: Record<string, MotionSettingValue> = {}
	for (const s of def.settings) {
		const own = spec?.settings?.[s.key]
		out[s.key] = sanitiseSetting(s, own === undefined ? s.default : own)
	}
	return out
}

// ===== Keyframe paths =====

export const OPACITY_PATH = 'opacity'
export const MOTION_PATH_PREFIX = 'motion.'
export const motionSettingPath = (key: string) => `${MOTION_PATH_PREFIX}${key}`

/**
 * The paths a motion item can animate beyond the transform every layer has:
 * its opacity, and every numeric setting the page marked `animate`.
 */
export function motionAnimatablePaths(item: Pick<TimelineItem, 'motion'>): string[] {
	if (!item.motion) return []
	const def = resolveDefinition(item.motion)
	return [
		OPACITY_PATH,
		...def.settings.filter((s) => s.animate && s.type === 'number').map((s) => motionSettingPath(s.key))
	]
}

// ===== Time =====

export interface ResolvedMoment {
	name: string
	flex: boolean
	/** Clip seconds. */
	start: number
	duration: number
	/** Page seconds. */
	pageStart: number
	pageDuration: number
}

/**
 * The clip's windows, laid onto a clip of length `clipDuration`.
 *
 * A retimed window keeps the length the user gave it; the flexible window takes
 * whatever is left. When the fixed windows alone overrun the clip they shrink
 * proportionally, so the in and the out both still play — just faster.
 */
export function resolveMoments(
	spec: MotionSpec | undefined,
	clipDuration: number,
	def = resolveDefinition(spec)
): ResolvedMoment[] {
	const D = Math.max(0, clipDuration)
	const own = spec?.moments ?? {}
	const wanted = def.moments.map((m) => {
		if (m.flex) return 0
		const v = own[m.name]
		return finite(v) && v >= 0 ? v : m.duration
	})
	const fixed = wanted.reduce((a, b) => a + b, 0)
	const scale = fixed > D && fixed > 0 ? D / fixed : 1
	const flexLength = Math.max(0, D - fixed * scale)

	let at = 0
	let pageAt = 0
	return def.moments.map((m, i) => {
		const duration = m.flex ? flexLength : wanted[i] * scale
		const out: ResolvedMoment = {
			name: m.name, flex: !!m.flex,
			start: at, duration,
			pageStart: pageAt, pageDuration: m.duration
		}
		at += duration
		pageAt += m.duration
		return out
	})
}

/**
 * Clip seconds → page seconds.
 *
 * Linear inside each window, so a window stretched to twice its length plays at
 * half speed and one squeezed to nothing jumps straight to its end. Outside the
 * clip the page holds its first or last frame.
 */
export function pageTime(spec: MotionSpec | undefined, clipDuration: number, u: number, def = resolveDefinition(spec)): number {
	const moments = resolveMoments(spec, clipDuration, def)
	if (u <= 0) return 0
	for (const m of moments) {
		if (u < m.start + m.duration) {
			if (m.duration <= 1e-9) continue
			return m.pageStart + ((u - m.start) / m.duration) * m.pageDuration
		}
	}
	return def.duration
}

/** Which window the clip is in at `u`, and how far through it — the monitor's "in · 62%". */
export function momentAt(
	spec: MotionSpec | undefined,
	clipDuration: number,
	u: number
): { name: string; progress: number } | null {
	const moments = resolveMoments(spec, clipDuration)
	for (const m of moments) {
		if (m.duration > 1e-9 && u >= m.start && u < m.start + m.duration) {
			return { name: m.name, progress: (u - m.start) / m.duration }
		}
	}
	return null
}

// ===== The one evaluator =====

export interface MotionFrameState {
	/** Page seconds handed to `seek`. */
	t: number
	settings: Record<string, MotionSettingValue>
	/** 0..1, applied to the whole page. */
	opacity: number
}

const round = (n: number, places = 6) => Math.round(n * 10 ** places) / 10 ** places

/**
 * Everything the page needs to draw one instant of `item`, at clip-local `u`.
 *
 * THE evaluator: the monitor calls it at the playhead, the export at every
 * frame. Settings come out of the same `valueAt` the transform keyframes use,
 * so a key on `motion.slide` moves the same way a key on `transform.x` does.
 */
export function motionFrameState(
	item: Pick<TimelineItem, 'motion' | 'duration' | 'keyframes'>,
	u: number
): MotionFrameState {
	const spec = item.motion
	const def = resolveDefinition(spec)
	const settings = settingValues(spec, def)
	const keys = item.keyframes ?? {}
	for (const s of def.settings) {
		if (!s.animate || s.type !== 'number') continue
		const track = keys[motionSettingPath(s.key)]
		if (normalise(track).length) {
			settings[s.key] = round(sanitiseSetting(s, valueAt(track, u, settings[s.key] as number)) as number)
		}
	}
	const opacity = round(clamp(valueAt(keys[OPACITY_PATH], u, 1), 0, 1))
	return { t: round(pageTime(spec, item.duration, u, def)), settings, opacity }
}

/** Frames in a clip at `fps`. Never zero, so a sliver still renders. */
export const motionFrameCount = (duration: number, fps: number): number =>
	Math.max(1, Math.round(duration * fps))

/** Every frame the export will capture, in order. Frame k is clip time k / fps. */
export function motionFramePlan(
	item: Pick<TimelineItem, 'motion' | 'duration' | 'keyframes'>,
	fps: number
): MotionFrameState[] {
	const count = motionFrameCount(item.duration, fps)
	return Array.from({ length: count }, (_, k) => motionFrameState(item, k / fps))
}

// ===== Rendering identity =====

/** Bumped whenever the capture or encode changes what a cached file contains. */
export const MOTION_PIPELINE_VERSION = 1

/**
 * Everything that changes the rendered clip, as one string — derived, not
 * listed: the composed page itself, every frame's state and the geometry. The
 * export hashes this for its cache key, so two clips that would render the same
 * pixels share one file and nothing that changes a pixel can be missed.
 */
export function motionRenderRecipe(
	item: Pick<TimelineItem, 'motion' | 'duration' | 'keyframes'>,
	frame: { width: number; height: number; fps: number }
): string {
	return JSON.stringify({
		v: MOTION_PIPELINE_VERSION,
		page: composeMotionPage(item.motion, frame),
		size: [frame.width, frame.height],
		fps: frame.fps,
		frames: motionFramePlan(item, frame.fps)
	})
}

/** Value comparison for the undo diff. Writers replace, never mutate. */
export function sameMotion(a: MotionSpec | undefined, b: MotionSpec | undefined): boolean {
	if (a === b) return true
	if (!a || !b) return false
	return stableJson(a) === stableJson(b)
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
	}
	return JSON.stringify(value)
}

// ===== Labels =====

/**
 * The clip's caption on the timeline: "Lower third · Sara Ahmadi". The first
 * text setting is what tells two lower thirds apart at a glance.
 */
export function motionClipLabel(item: Pick<TimelineItem, 'motion' | 'label'>): string {
	const spec = item.motion
	if (!spec) return item.label || ''
	const name = item.label || motionName(spec)
	const def = resolveDefinition(spec)
	const firstText = def.settings.find((s) => s.type === 'text')
	const value = firstText ? String(settingValues(spec, def)[firstText.key] ?? '').trim() : ''
	return value ? `${name} · ${value.replace(/\s+/g, ' ').slice(0, 40)}` : name
}

/** "4.0s · 3 moments". */
export function motionSummary(def: MotionDefinition): string {
	const n = def.moments.length
	return `${def.duration.toFixed(1)}s${n > 1 ? ` · ${n} moments` : ''}`
}

// ===== The page =====

/**
 * The page's CSP. `default-src 'none'` is the network ban; inline script and
 * style are the page itself; fonts and images may only be data: URLs, which is
 * how the bundled fonts arrive.
 */
export const MOTION_CSP =
	"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
	"font-src data:; img-src data:; media-src data:"

/**
 * The runtime injected ahead of the page's own code.
 *
 * It exposes `frameflow` (define, ready, progress, easing helpers), answers
 * `frameflow:seek` messages from the monitor and `__seek` calls from the
 * export, and neutralises the clocks a page could reach for: a `seek` that
 * depends on anything but its arguments would make the preview and the export
 * disagree, which is the one thing this layer exists to prevent.
 *
 * `__seek` resolves after two animation frames — the first runs style and
 * layout, the second guarantees the frame carrying them was produced — and only
 * then may the export capture.
 */
const RUNTIME = `(function () {
'use strict';
var DEF = __DEF__;
var raf = window.requestAnimationFrame.bind(window);
var post = function (m) { try { window.parent.postMessage(m, '*'); } catch (e) {} };
var seed = 1;
Math.random = function () {
  seed = (seed + 0x6D2B79F5) | 0;
  var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Date.now = function () { return 0; };
try { performance.now = function () { return 0; }; } catch (e) {}
var off = function () { return 0; };
window.setTimeout = off; window.setInterval = off; window.requestAnimationFrame = off;
window.requestIdleCallback = off;
window.fetch = function () { return Promise.reject(new Error('Motion pages have no network.')); };
window.XMLHttpRequest = undefined; window.WebSocket = undefined; window.EventSource = undefined;
var windows = {};
(function () { var at = 0; DEF.moments.forEach(function (m) { windows[m.name] = { start: at, duration: m.duration }; at += m.duration; }); })();
var clamp = function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); };
var seekFn = null, defined = false, resolveReady;
var ready = new Promise(function (r) { resolveReady = r; });
function bounds() {
  var marked = document.querySelectorAll('[data-ff-bounds]');
  var list = marked.length ? marked : document.body.querySelectorAll('*');
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (var i = 0; i < list.length; i++) {
    var el = list[i];
    if (!marked.length && el.children.length) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  var W = window.innerWidth || 1, H = window.innerHeight || 1;
  x0 = clamp(x0, 0, W); y0 = clamp(y0, 0, H); x1 = clamp(x1, 0, W); y1 = clamp(y1, 0, H);
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0 / W, y: y0 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
}
var ff = {
  definition: DEF,
  ready: ready,
  define: function (d) {
    if (d && typeof d.seek === 'function') seekFn = d.seek;
    if (defined) return;
    defined = true;
    var own = d ? { duration: d.duration, settings: d.settings, moments: d.moments } : null;
    try { post({ type: 'frameflow:defined', definition: JSON.parse(JSON.stringify(own)) }); } catch (e) {}
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    fonts.then(function () { resolveReady(true); }, function () { resolveReady(true); });
  },
  progress: function (name, t) {
    var m = windows[name];
    if (!m) return 0;
    if (m.duration <= 0) return t >= m.start ? 1 : 0;
    return clamp((t - m.start) / m.duration, 0, 1);
  },
  clamp: clamp,
  lerp: function (a, b, u) { return a + (b - a) * u; },
  ease: {
    linear: function (u) { return u; },
    in: function (u) { return u * u * u; },
    out: function (u) { return 1 - Math.pow(1 - u, 3); },
    inOut: function (u) { return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; },
    back: function (u) { var c = 1.70158; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); }
  },
  __seek: function (t, settings, opacity, wantBounds) {
    return ready.then(function () {
      seed = 1;
      document.documentElement.style.opacity = String(opacity == null ? 1 : opacity);
      if (seekFn) seekFn(Number(t) || 0, settings || {});
      return new Promise(function (resolve) {
        raf(function () { raf(function () { resolve(wantBounds ? bounds() : null); }); });
      });
    });
  }
};
window.frameflow = ff;
window.addEventListener('message', function (e) {
  var d = e.data;
  if (!d || d.type !== 'frameflow:seek') return;
  ff.__seek(d.t, d.settings, d.opacity, true).then(
    function (b) { post({ type: 'frameflow:seeked', id: d.id, bounds: b }); },
    function (err) { post({ type: 'frameflow:error', message: String((err && err.message) || err) }); });
});
window.addEventListener('error', function (e) { post({ type: 'frameflow:error', message: String(e.message) }); });
})();`

/** `</script>` inside a JSON blob would end the script element early. */
const scriptSafe = (s: string) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')

/**
 * The exact document both the monitor and the export load.
 *
 * Our head goes FIRST — the runtime has to exist before the page's own scripts
 * call `frameflow.define` — and pins the viewport to the sequence frame, so a
 * page laid out in `vw`/`vh` lands identically in a 480px-wide monitor iframe
 * (scaled down by CSS) and a 1920px export window. Animations and transitions
 * are switched off outright; the lint says why, this makes sure.
 */
export function composeMotionPage(
	spec: MotionSpec | undefined,
	frame: { width: number; height: number }
): string {
	const def = resolveDefinition(spec)
	const width = Math.max(2, Math.round(frame.width))
	const height = Math.max(2, Math.round(frame.height))
	const head = [
		'<meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${MOTION_CSP}">`,
		`<meta name="viewport" content="width=${width}, height=${height}">`,
		`<style>${MOTION_FONT_CSS}\n` +
			`html{color-scheme:normal}html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent}\n` +
			'*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent}</style>',
		`<script>${scriptSafe(RUNTIME.replace('__DEF__', JSON.stringify(def)))}</script>`
	].join('\n')

	const source = motionSource(spec)
	const headTag = /<head(\s[^>]*)?>/i.exec(source)
	if (headTag) {
		const at = headTag.index + headTag[0].length
		return `${source.slice(0, at)}\n${head}\n${source.slice(at)}`
	}
	const htmlTag = /<html(\s[^>]*)?>/i.exec(source)
	if (htmlTag) {
		const at = htmlTag.index + htmlTag[0].length
		return `${source.slice(0, at)}\n<head>\n${head}\n</head>\n${source.slice(at)}`
	}
	return `<!doctype html>\n<html>\n<head>\n${head}\n</head>\n<body>\n${source}\n</body>\n</html>\n`
}

// ===== Lint =====

export interface MotionLintIssue {
	rule: 'css-animation' | 'timer' | 'clock' | 'random' | 'animation-frame' | 'network' | 'remote-url' | 'no-define'
	message: string
	/** 1-based line in the page's source. */
	line: number
	excerpt: string
}

export interface MotionLintResult {
	ok: boolean
	issues: MotionLintIssue[]
}

interface LintRule {
	rule: MotionLintIssue['rule']
	pattern: RegExp
	message: string
}

const LINT_RULES: LintRule[] = [
	{ rule: 'css-animation', pattern: /@keyframes\b/gi, message: 'CSS @keyframes run on their own clock. Draw the motion in seek(t) instead.' },
	{ rule: 'css-animation', pattern: /(^|[;{\s"'])animation(-name|-duration|-delay|-play-state)?\s*:/gim, message: 'A CSS animation runs on its own clock, so the export would not match the preview. Draw it in seek(t).' },
	{ rule: 'css-animation', pattern: /(^|[;{\s"'])transition(-property|-duration|-delay)?\s*:/gim, message: 'A CSS transition eases on its own clock. Interpolate in seek(t) instead.' },
	{ rule: 'css-animation', pattern: /\.animate\s*\(/g, message: 'The Web Animations API runs on its own clock. Draw the motion in seek(t).' },
	{ rule: 'timer', pattern: /\bset(Timeout|Interval|Immediate)\s*\(/g, message: 'Timers fire on wall-clock time, not on t. Everything must be computed in seek(t).' },
	{ rule: 'timer', pattern: /\brequestIdleCallback\s*\(/g, message: 'Idle callbacks fire on wall-clock time, not on t.' },
	{ rule: 'animation-frame', pattern: /\brequestAnimationFrame\s*\(/g, message: 'requestAnimationFrame ticks on the display, not on t. seek(t) is called for every frame.' },
	{ rule: 'clock', pattern: /\bDate\.now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\.now\s*\(/g, message: 'The wall clock differs between preview and export. Use t.' },
	{ rule: 'random', pattern: /\bMath\.random\s*\(|\bcrypto\.getRandomValues\s*\(/g, message: 'Random numbers differ on every render. Derive variation from t or a fixed seed.' },
	{ rule: 'network', pattern: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\s*\(|\bimport\s*\(/g, message: 'Motion pages have no network. Inline what the page needs.' },
	{ rule: 'remote-url', pattern: /\b(src|href|action|poster|srcset)\s*=\s*["']?\s*(https?:)?\/\//gi, message: 'Remote files are blocked. Inline images as data: URLs; fonts come bundled.' },
	{ rule: 'remote-url', pattern: /url\(\s*["']?\s*(https?:)?\/\//gi, message: 'Remote files are blocked. Inline it as a data: URL.' },
	{ rule: 'remote-url', pattern: /@import\b/gi, message: '@import loads a remote stylesheet. Inline the CSS.' }
]

/**
 * A static scan for everything that would make a page draw differently in the
 * export than in the preview, or reach the network.
 *
 * Static on purpose: it runs on a string, anywhere, before anything executes —
 * in the inspector, in an agent's tool call, in a test over the templates. The
 * runtime neutralises the same things anyway; this is what tells the author.
 * Comments are blanked first (keeping line numbers), so a note that SAYS
 * "no setTimeout" is not reported as using one.
 */
export function lintMotionHtml(html: string): MotionLintResult {
	const source = blankComments(html)
	const issues: MotionLintIssue[] = []
	const lineAt = (index: number) => source.slice(0, index).split('\n').length
	const lines = html.split('\n')
	for (const rule of LINT_RULES) {
		rule.pattern.lastIndex = 0
		let match: RegExpExecArray | null
		while ((match = rule.pattern.exec(source))) {
			const line = lineAt(match.index + (match[1] && /^[;{\s"']$/.test(match[1]) ? 1 : 0))
			issues.push({ rule: rule.rule, message: rule.message, line, excerpt: (lines[line - 1] ?? '').trim().slice(0, 120) })
			if (match[0].length === 0) rule.pattern.lastIndex++
		}
	}
	if (!/\bframeflow\.define\s*\(/.test(source)) {
		issues.push({
			rule: 'no-define', line: 1, excerpt: '',
			message: 'The page never calls frameflow.define({ duration, settings, moments, seek }), so nothing can drive it.'
		})
	}
	issues.sort((a, b) => a.line - b.line)
	return { ok: issues.length === 0, issues }
}

/** Replace HTML, block and line comments with spaces, keeping newlines. */
function blankComments(html: string): string {
	const blank = (s: string) => s.replace(/[^\n]/g, ' ')
	return html
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\/\*[\s\S]*?\*\//g, blank)
		// Line comments: `//` not preceded by a colon (so `https://` survives).
		.replace(/(^|[^:"'\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)))
}

// ===== Catalogue access =====

export { MOTION_TEMPLATES, motionTemplate }
