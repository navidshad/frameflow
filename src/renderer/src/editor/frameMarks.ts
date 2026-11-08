/**
 * Marks a person draws on an attached frame to point at something: an arrow,
 * a box, a ring, a freehand line. Coordinates are fractions of the picture
 * (0–1), so the same marks draw on the small editor canvas and on the
 * full-size still that is sent.
 *
 * The marks are kept beside the untouched picture rather than burnt into it,
 * so reopening the editor can still undo or move on from them.
 */

export type MarkTool = 'arrow' | 'rect' | 'ellipse' | 'pen'

export interface FrameMark {
	tool: MarkTool
	color: string
	/** Two points for arrow/rect/ellipse (start, end); every sample for pen. */
	points: { x: number; y: number }[]
}

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

export const MARK_COLORS = ['#ef4444', '#facc15', '#ffffff'] as const

/**
 * Draws marks on a context the size of the picture. Line width follows the
 * picture's size, so a mark reads the same on a 720p still and a 4K one.
 */
export function drawMarks(ctx: CanvasRenderingContext2D, marks: FrameMark[], width: number, height: number): void {
	const line = Math.max(2, Math.round(Math.min(width, height) / 140))
	ctx.save()
	ctx.lineCap = 'round'
	ctx.lineJoin = 'round'
	ctx.lineWidth = line
	for (const mark of marks) {
		const pts = mark.points.map((p) => ({ x: p.x * width, y: p.y * height }))
		if (!pts.length) continue
		ctx.strokeStyle = mark.color
		ctx.fillStyle = mark.color
		// A dark halo under each mark: a white or yellow line must read on a bright frame.
		ctx.shadowColor = 'rgba(0,0,0,0.55)'
		ctx.shadowBlur = line * 1.5
		const [a, b = pts[0]] = [pts[0], pts[pts.length - 1]]
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
		}
	}
	ctx.restore()
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
