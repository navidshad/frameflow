/**
 * The geometry of marks drawn on an attached frame: their size on a picture,
 * what a click lands on, moving and resizing. No DOM here, so it is tested in
 * node; drawing is frameMarks.ts.
 *
 * Points are fractions of the picture (0–1). Sizes are relative to the
 * picture's short side, so a mark looks the same on the small editor canvas
 * and on the full-size still that is sent.
 */

export type MarkTool = 'arrow' | 'rect' | 'ellipse' | 'pen' | 'text'

export interface FrameMark {
	tool: MarkTool
	color: string
	/** Two points for arrow/rect/ellipse (start, end); every sample for pen; the top-left corner for text. */
	points: { x: number; y: number }[]
	/** Stroke size, 1–20 (thousandths of the short side). Text is five strokes tall. Absent: SIZE_DEFAULT. */
	size?: number
	/** Text marks: their words, one line per `\n`. */
	text?: string
}

export const SIZE_MIN = 1
export const SIZE_MAX = 20
/** The size every mark had before sizes could be chosen (short side / 140). */
export const SIZE_DEFAULT = 7

export interface Box { x: number; y: number; w: number; h: number }
export type Corner = 'nw' | 'ne' | 'sw' | 'se'
/** How big a text mark's lines are, in pixels, at a font size. The editor measures with its canvas. */
export type Measure = (text: string, fontPx: number) => { width: number }

const clampSize = (size: number) => Math.min(SIZE_MAX, Math.max(SIZE_MIN, size))

export const strokePx = (mark: Pick<FrameMark, 'size'>, w: number, h: number): number =>
	Math.max(1, (Math.min(w, h) * clampSize(mark.size ?? SIZE_DEFAULT)) / 1000)

export const fontPx = (mark: Pick<FrameMark, 'size'>, w: number, h: number): number => Math.max(8, strokePx(mark, w, h) * 5)

export const LINE_HEIGHT = 1.25

export const textLines = (mark: Pick<FrameMark, 'text'>): string[] => (mark.text ?? '').split('\n')

/** A mark's extent in pixels on a picture of w×h (text measured, strokes not included). */
export function markBounds(mark: FrameMark, w: number, h: number, measure: Measure): Box {
	const pts = mark.points.map((p) => ({ x: p.x * w, y: p.y * h }))
	if (mark.tool === 'text') {
		const font = fontPx(mark, w, h)
		const lines = textLines(mark)
		const width = Math.max(font * 0.5, ...lines.map((l) => measure(l, font).width))
		return { x: pts[0].x, y: pts[0].y, w: width, h: lines.length * font * LINE_HEIGHT }
	}
	const xs = pts.map((p) => p.x)
	const ys = pts.map((p) => p.y)
	const x = Math.min(...xs)
	const y = Math.min(...ys)
	return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

const distToSegment = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
	const dx = b.x - a.x
	const dy = b.y - a.y
	const len = dx * dx + dy * dy
	const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/**
 * The mark under a point (pixels), or -1. A click on a mark's line wins over a
 * click inside a box or ring, so an arrow drawn inside a big ring can still be
 * picked; among equals the newest (top) mark wins.
 */
export function hitMark(marks: FrameMark[], p: { x: number; y: number }, w: number, h: number, measure: Measure, tolerance: number): number {
	let inside = -1
	for (let i = marks.length - 1; i >= 0; i--) {
		const mark = marks[i]
		const tol = Math.max(tolerance, strokePx(mark, w, h))
		const pts = mark.points.map((q) => ({ x: q.x * w, y: q.y * h }))
		const box = markBounds(mark, w, h, measure)
		switch (mark.tool) {
			case 'arrow':
				if (distToSegment(p, pts[0], pts[pts.length - 1]) <= tol) return i
				break
			case 'pen':
				for (let s = 1; s < pts.length; s++) if (distToSegment(p, pts[s - 1], pts[s]) <= tol) return i
				if (pts.length === 1 && Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= tol) return i
				break
			case 'text':
				if (p.x >= box.x - tol && p.x <= box.x + box.w + tol && p.y >= box.y - tol && p.y <= box.y + box.h + tol) return i
				break
			case 'rect': {
				const inX = p.x >= box.x - tol && p.x <= box.x + box.w + tol
				const inY = p.y >= box.y - tol && p.y <= box.y + box.h + tol
				if (!inX || !inY) break
				const edge = Math.min(Math.abs(p.x - box.x), Math.abs(p.x - box.x - box.w), Math.abs(p.y - box.y), Math.abs(p.y - box.y - box.h))
				if (edge <= tol) return i
				if (inside < 0) inside = i
				break
			}
			case 'ellipse': {
				const rx = box.w / 2
				const ry = box.h / 2
				if (rx < 0.5 || ry < 0.5) break
				const r = Math.hypot((p.x - box.x - rx) / rx, (p.y - box.y - ry) / ry)
				if (Math.abs(r - 1) * Math.min(rx, ry) <= tol) return i
				if (r < 1 && inside < 0) inside = i
				break
			}
		}
	}
	return inside
}

/** The resize handle of a selection box under a point, if any. */
export function handleAt(box: Box, p: { x: number; y: number }, tolerance: number): Corner | null {
	const corners: [Corner, number, number][] = [
		['nw', box.x, box.y], ['ne', box.x + box.w, box.y], ['sw', box.x, box.y + box.h], ['se', box.x + box.w, box.y + box.h]
	]
	return corners.find(([, x, y]) => Math.abs(p.x - x) <= tolerance && Math.abs(p.y - y) <= tolerance)?.[0] ?? null
}

/** A mark moved by a fraction of the picture, kept on the picture. */
export function moveMark(mark: FrameMark, dx: number, dy: number): FrameMark {
	// Clamp the move as a whole so the mark keeps its shape at the edge.
	const xs = mark.points.map((p) => p.x)
	const ys = mark.points.map((p) => p.y)
	const mx = Math.min(Math.max(dx, -Math.min(...xs)), 1 - Math.max(...xs))
	const my = Math.min(Math.max(dy, -Math.min(...ys)), 1 - Math.max(...ys))
	return { ...mark, points: mark.points.map((p) => ({ x: p.x + mx, y: p.y + my })) }
}

/** The box a corner handle drags to: the opposite corner stays put. */
export function resizeBox(box: Box, corner: Corner, p: { x: number; y: number }, minSize = 4): Box {
	const fixedX = corner === 'nw' || corner === 'sw' ? box.x + box.w : box.x
	const fixedY = corner === 'nw' || corner === 'ne' ? box.y + box.h : box.y
	const w = Math.max(minSize, Math.abs(p.x - fixedX))
	const h = Math.max(minSize, Math.abs(p.y - fixedY))
	return { x: p.x < fixedX ? fixedX - w : fixedX, y: p.y < fixedY ? fixedY - h : fixedY, w, h }
}

/**
 * A mark fitted from one box to another (pixels on a w×h picture). Shapes
 * stretch; text keeps its proportions and scales its size with the height,
 * since stretched letters read worse than bigger ones.
 */
export function resizeMark(mark: FrameMark, from: Box, to: Box, w: number, h: number): FrameMark {
	if (mark.tool === 'text') {
		const scale = from.h > 0 ? to.h / from.h : 1
		return { ...mark, size: clampSize((mark.size ?? SIZE_DEFAULT) * scale), points: [{ x: to.x / w, y: to.y / h }] }
	}
	const map = (v: number, a: number, aw: number, b: number, bw: number) => (aw > 0 ? b + ((v - a) * bw) / aw : v + (b - a))
	return {
		...mark,
		points: mark.points.map((q) => ({
			x: map(q.x * w, from.x, from.w, to.x, to.w) / w,
			y: map(q.y * h, from.y, from.h, to.y, to.h) / h
		}))
	}
}

/** The words written on a frame, for the agent to read as text too. */
export const markLabels = (marks: FrameMark[]): string[] =>
	marks.filter((m) => m.tool === 'text').map((m) => (m.text ?? '').trim()).filter(Boolean)
