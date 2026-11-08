/**
 * Marks a person draws on an attached frame to point at something: an arrow,
 * a box, a ring, a freehand line. Coordinates are fractions of the picture
 * (0–1), so the same marks draw on the small editor canvas and on the
 * full-size still that is sent.
 *
 * The marks are kept beside the untouched picture rather than burnt into it,
 * so reopening the editor can still undo or move on from them.
 */

import { fontPx, LINE_HEIGHT, strokePx, textLines, type FrameMark } from './markGeometry'

export type { FrameMark, MarkTool } from './markGeometry'

/** A frame in the composer, before it is sent. */
export interface ComposerAttachment {
	id: string
	timeSec: number
	note: string
	/** The frame as captured (base64 JPEG). */
	original: string
	/** What is sent: the original, or the original with the marks drawn in. */
	data: string
	mimeType: 'image/jpeg'
	thumbnail: string
	width: number
	height: number
	marks: FrameMark[]
}

/** The swatches offered first; the colour well picks any other. */
export const MARK_COLORS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#ffffff', '#000000'] as const

/** The font text marks are drawn in, on the canvas and when measured for hit tests. */
export const markFont = (px: number) => `600 ${px}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`

/**
 * Draws marks on a context the size of the picture. Each mark's line width is
 * relative to the picture's short side, so it reads the same on a 720p still
 * and a 4K one.
 */
export function drawMarks(ctx: CanvasRenderingContext2D, marks: FrameMark[], width: number, height: number): void {
	ctx.save()
	ctx.lineCap = 'round'
	ctx.lineJoin = 'round'
	for (const mark of marks) {
		const pts = mark.points.map((p) => ({ x: p.x * width, y: p.y * height }))
		if (!pts.length) continue
		const line = strokePx(mark, width, height)
		ctx.lineWidth = line
		ctx.strokeStyle = mark.color
		ctx.fillStyle = mark.color
		// A dark halo under each mark: a white or yellow line must read on a bright frame.
		ctx.shadowColor = 'rgba(0,0,0,0.55)'
		ctx.shadowBlur = line * 1.5
		const [a, b] = [pts[0], pts[pts.length - 1]]
		ctx.beginPath()
		switch (mark.tool) {
			case 'pen':
				ctx.moveTo(pts[0].x, pts[0].y)
				for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y)
				ctx.stroke()
				break
			case 'rect':
				ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y))
				break
			case 'ellipse':
				ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2)
				ctx.stroke()
				break
			case 'arrow': {
				const angle = Math.atan2(b.y - a.y, b.x - a.x)
				const head = line * 4.5
				// The shaft stops at the head's base so its round cap does not poke through the tip.
				const base = { x: b.x - Math.cos(angle) * head * 0.8, y: b.y - Math.sin(angle) * head * 0.8 }
				ctx.moveTo(a.x, a.y)
				ctx.lineTo(base.x, base.y)
				ctx.stroke()
				ctx.beginPath()
				ctx.moveTo(b.x, b.y)
				ctx.lineTo(b.x - Math.cos(angle - 0.45) * head, b.y - Math.sin(angle - 0.45) * head)
				ctx.lineTo(b.x - Math.cos(angle + 0.45) * head, b.y - Math.sin(angle + 0.45) * head)
				ctx.closePath()
				ctx.fill()
				break
			}
			case 'text': {
				const px = fontPx(mark, width, height)
				ctx.font = markFont(px)
				ctx.textBaseline = 'top'
				// An outline in the opposite tone, so the words read on any picture.
				ctx.shadowBlur = 0
				ctx.lineWidth = Math.max(2, px / 7)
				ctx.strokeStyle = isLight(mark.color) ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)'
				textLines(mark).forEach((text, i) => {
					const y = a.y + i * px * LINE_HEIGHT + (px * (LINE_HEIGHT - 1)) / 2
					ctx.strokeText(text, a.x, y)
					ctx.fillText(text, a.x, y)
				})
				break
			}
		}
	}
	ctx.restore()
}

/** Whether a #rrggbb colour is light (it takes a dark outline). */
export function isLight(color: string): boolean {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
	if (!m) return true
	const [r, g, b] = m.slice(1).map((v) => parseInt(v, 16))
	return 0.299 * r + 0.587 * g + 0.114 * b > 150
}

const loadImage = (src: string) =>
	new Promise<HTMLImageElement>((resolve, reject) => {
		const img = new Image()
		img.onload = () => resolve(img)
		img.onerror = () => reject(new Error('The frame could not be drawn.'))
		img.src = src
	})

/**
 * The picture that is sent: the original with the marks drawn in, at full
 * size, plus a thumbnail for the composer and the chat. Works from a data URL,
 * so the canvas is never tainted and can be read back.
 */
export async function composeMarked(original: string, marks: FrameMark[]): Promise<{ data: string; thumbnail: string }> {
	const img = await loadImage(`data:image/jpeg;base64,${original}`)
	const canvas = document.createElement('canvas')
	canvas.width = img.naturalWidth
	canvas.height = img.naturalHeight
	const ctx = canvas.getContext('2d')!
	ctx.drawImage(img, 0, 0)
	drawMarks(ctx, marks, canvas.width, canvas.height)
	const thumb = document.createElement('canvas')
	thumb.width = 224
	thumb.height = Math.max(1, Math.round((224 * canvas.height) / canvas.width))
	thumb.getContext('2d')!.drawImage(canvas, 0, 0, thumb.width, thumb.height)
	return {
		data: canvas.toDataURL('image/jpeg', 0.88).split(',')[1],
		thumbnail: thumb.toDataURL('image/jpeg', 0.75)
	}
}

/**
 * The words sent with the draft. Frames alone are a message too: their notes
 * say what is wanted, and the agent still needs a sentence to answer.
 */
export function draftPrompt(text: string, frames: number): string {
	const words = text.trim()
	if (words || !frames) return words
	return frames === 1 ? 'See the attached frame.' : 'See the attached frames.'
}
