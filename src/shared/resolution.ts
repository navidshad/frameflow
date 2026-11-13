import { sequenceFrame, type FrameSource } from './framing'

/**
 * Project resolution and the export sizes derived from it.
 *
 * A project has ONE explicit frame (`timelineMeta.width × height`, with
 * `frameChosen`). Everything an export offers comes from that frame, and nothing
 * is ever larger than it: asking for 4K from a 1080p project would only stretch
 * pixels that were never there.
 *
 * THE RULE for naming sizes: a rung is named by the SHORT side of the frame, in
 * lines. 1080p is 1920×1080 in landscape, 1080×1920 vertical, 1080×1080 square
 * and 1080×1350 for 4:5 — "1080" says how sharp the picture is whichever way the
 * phone is held. For landscape that is exactly the height, so it agrees with how
 * every earlier export was sized.
 */

export interface ResolutionRung {
	id: '4k' | '2k' | '1080' | '720'
	/** Short side of the frame, in lines. */
	lines: number
	label: string
}

/** Largest first. 2K is QHD (2560×1440); 1080p is what people call 1K. */
export const RESOLUTION_RUNGS: readonly ResolutionRung[] = [
	{ id: '4k', lines: 2160, label: '4K' },
	{ id: '2k', lines: 1440, label: '2K' },
	{ id: '1080', lines: 1080, label: '1080p' },
	{ id: '720', lines: 720, label: '720p' }
]

/** The fast-preview height, rendered from the 480p proxies. */
export const PREVIEW_LINES = 480

type Frame = { width: number; height: number }

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

export const shortSide = (frame: Frame): number => Math.min(frame.width, frame.height)

/**
 * The frame scaled so its short side is `lines`, the other side following the
 * aspect and kept even (h264/h265 cannot encode an odd one).
 *
 * NEVER UPSCALES: a frame whose short side is already `lines` or less comes back
 * unchanged.
 */
export function fitFrameToShortSide(frame: Frame, lines: number): Frame {
	const short = shortSide(frame)
	if (short <= lines) return { width: frame.width, height: frame.height }
	const scale = lines / short
	return { width: even(frame.width * scale), height: even(frame.height * scale) }
}

/**
 * The frame at a rung, either way: the same aspect with the short side set to
 * `lines`. Unlike `fitFrameToShortSide` this may grow the frame — it is how a
 * project's OWN resolution is changed, where an export must never grow.
 */
export function frameAtRung(frame: Frame, lines: number): Frame {
	const scale = lines / shortSide(frame)
	return { width: even(frame.width * scale), height: even(frame.height * scale) }
}

/** "3840×2160", for labels. */
export const sizeText = (frame: Frame): string => `${frame.width}×${frame.height}`

/** The rung a frame IS (its short side matches), if it is one of the standard sizes. */
export function rungOf(frame: Frame): ResolutionRung | null {
	const short = shortSide(frame)
	return RESOLUTION_RUNGS.find((r) => r.lines === short) ?? null
}

export type ExportChoiceId = 'original' | ResolutionRung['id'] | 'preview'

export interface ExportChoice {
	id: ExportChoiceId
	/** The line count to hand to the render; absent = the project's own size. */
	lines?: number
	/** What the file will measure. */
	frame: Frame
	/** "4K · 3840×2160" */
	label: string
}

/**
 * The sizes an export can be made at for this project: its own size first, then
 * every standard rung strictly smaller than it. The fast preview is not here — it
 * is a different kind of render (from proxies), listed separately by the dialog.
 */
export function exportChoices(frame: Frame): ExportChoice[] {
	const own = rungOf(frame)
	const choices: ExportChoice[] = [{
		id: 'original',
		frame,
		label: own ? `${own.label} · ${sizeText(frame)}` : sizeText(frame)
	}]
	for (const rung of RESOLUTION_RUNGS) {
		if (rung.lines >= shortSide(frame)) continue
		const fit = fitFrameToShortSide(frame, rung.lines)
		choices.push({ id: rung.id, lines: rung.lines, frame: fit, label: `${rung.label} · ${sizeText(fit)}` })
	}
	return choices
}

/** The lines for a rung id, or undefined for "original" / an unknown id. */
export function linesForChoice(id: string | undefined): number | undefined {
	return RESOLUTION_RUNGS.find((r) => r.id === id)?.lines
}

// ===== Shapes =====

export interface FrameShape {
	label: string
	short: string
	/** Width : height. */
	ratio: [number, number]
}

/** The shapes worth one click. Anything else is a custom W×H. */
export const FRAME_SHAPES: readonly FrameShape[] = [
	{ label: 'Landscape', short: '16:9', ratio: [16, 9] },
	{ label: 'Vertical', short: '9:16', ratio: [9, 16] },
	{ label: 'Square', short: '1:1', ratio: [1, 1] },
	{ label: 'Portrait', short: '4:5', ratio: [4, 5] }
]

/** A shape at a rung: short side = `lines`. 16:9 at 1080 is 1920×1080, 9:16 is 1080×1920. */
export function frameForShape(shape: FrameShape, lines: number): Frame {
	const [rw, rh] = shape.ratio
	const short = Math.min(rw, rh)
	return { width: even((lines * rw) / short), height: even((lines * rh) / short) }
}

/** Which preset shape a frame is, within half a percent of its aspect. */
export function shapeOf(frame: Frame): FrameShape | null {
	const aspect = frame.width / frame.height
	return FRAME_SHAPES.find((s) => Math.abs(aspect / (s.ratio[0] / s.ratio[1]) - 1) < 0.005) ?? null
}

/** Custom sizes are held to something an encoder will take: even, and sane. */
export const CUSTOM_FRAME_LIMITS = { min: 128, max: 7680 } as const

export function normalizeCustomFrame(width: number, height: number): Frame | null {
	if (!Number.isFinite(width) || !Number.isFinite(height)) return null
	const clamp = (n: number) => Math.min(CUSTOM_FRAME_LIMITS.max, Math.max(CUSTOM_FRAME_LIMITS.min, n))
	return { width: even(clamp(width)), height: even(clamp(height)) }
}

// ===== The frame of a whole document =====

interface FrameDoc {
	timelineMeta?: FrameMeta
	timeline: { sourceAssetId: string }[]
	media: { id: string; kind: string; metadata?: FrameSource }[]
}

/** The picture sources the timeline uses — the ones that decide an unchosen frame. */
export function usedVideoSources(doc: Pick<FrameDoc, 'timeline' | 'media'>): FrameSource[] {
	const used = new Set(doc.timeline.map((i) => i.sourceAssetId))
	return doc.media.filter((a) => used.has(a.id) && a.kind !== 'audio').map((a) => a.metadata ?? {})
}

/** The frame this project exports at: the editor, the dialog and MCP all ask here. */
export function documentFrame(doc: FrameDoc): Frame {
	return sequenceFrame(doc.timelineMeta, usedVideoSources(doc))
}

// ===== Old projects =====

interface FrameMeta { width?: number; height?: number; frameChosen?: boolean }

/**
 * Give a project that never chose a frame its resolution, written down.
 *
 * Until now such a project exported at the largest video source it USED, resolved
 * on the fly by `sequenceFrame()`. The migration asks that same function once and
 * stores the answer with `frameChosen: true`, so the export frame is the one the
 * project always had — and stays that, rather than silently following the next
 * clip dropped in.
 *
 * Returns the meta unchanged (same object) when there is nothing to do: the
 * project already chose, or no used source has dimensions yet (an empty project
 * keeps following its first import, as it always did).
 */
export function migrateProjectFrame<M extends FrameMeta>(meta: M, sources: FrameSource[]): M {
	if (meta.frameChosen) return meta
	if (!sources.some((s) => s.width && s.height)) return meta
	const { width, height } = sequenceFrame(meta, sources)
	return { ...meta, width, height, frameChosen: true }
}
