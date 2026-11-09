import { windowToTensor, type Frame, type Window } from './image'
import { modelSession, ort } from './models'

/**
 * VitTrack (OpenCV Zoo, Apache-2.0): follows one box from frame to frame.
 *
 * A port of OpenCV's TrackerVit. The model is shown a picture of the object
 * (the template, taken once) and a wider window around where it last was, and
 * answers with where the object is inside that window and how sure it is.
 * It has no idea what the object is and cannot find it again once it has lost
 * it; deciding "lost" is the caller's job (shared/tracking.ts).
 *
 * Boxes are whole pixels, as in the reference, so results match it exactly.
 */

export interface PixelBox {
	x: number
	y: number
	w: number
	h: number
}

const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const
const MAP = 16

/** The square around `box`, `factor` times its size, with the reference's own padding rule. */
function cropWindow(frame: Frame, box: PixelBox, factor: number): Window {
	const size = Math.ceil(Math.sqrt(box.w * box.h) * factor)
	const x1 = box.x + Math.trunc((box.w - size) / 2)
	const y1 = box.y + Math.trunc((box.h - size) / 2)
	const x2 = x1 + size, y2 = y1 + size
	return {
		x: x1, y: y1, w: size, h: size,
		valid: {
			x0: x1 + Math.max(0, -x1), y0: y1 + Math.max(0, -y1),
			x1: x2 - Math.max(x2 - frame.width + 1, 0), y1: y2 - Math.max(y2 - frame.height + 1, 0)
		}
	}
}

const hann = (i: number): number => 0.5 * (1 - Math.cos(((2 * Math.PI) / (MAP + 1)) * (i + 1)))

export class ObjectFollower {
	private template: Float32Array | null = null
	private last: PixelBox = { x: 0, y: 0, w: 0, h: 0 }

	async start(frame: Frame, box: PixelBox): Promise<void> {
		this.last = { x: Math.round(box.x), y: Math.round(box.y), w: Math.max(2, Math.round(box.w)), h: Math.max(2, Math.round(box.h)) }
		this.template = windowToTensor(frame, cropWindow(frame, this.last, 2), 128, 128, { scale: 1 / 255, mean: MEAN, std: STD })
	}

	/** The object's box in `frame` and the model's confidence (0–1). Always answers; see `objectLost`. */
	async step(frame: Frame): Promise<{ box: PixelBox; score: number }> {
		if (!this.template) throw new Error('ObjectFollower.step before start')
		const session = await modelSession('vittrack')
		const { Tensor } = await ort()
		const search = windowToTensor(frame, cropWindow(frame, this.last, 4), 256, 256, { scale: 1 / 255, mean: MEAN, std: STD })
		const out = await session.run({
			template: new Tensor('float32', this.template, [1, 3, 128, 128]),
			search: new Tensor('float32', search, [1, 3, 256, 256])
		})
		const conf = out.output1.data as Float32Array
		const size = out.output2.data as Float32Array
		const offset = out.output3.data as Float32Array
		let best = -Infinity, bx = 0, by = 0
		for (let y = 0; y < MAP; y++) {
			for (let x = 0; x < MAP; x++) {
				const v = conf[y * MAP + x] * hann(y) * hann(x)
				if (v > best) { best = v; bx = x; by = y }
			}
		}
		const at = by * MAP + bx
		const cx = (bx + offset[at]) / MAP, cy = (by + offset[MAP * MAP + at]) / MAP
		const w = size[at], h = size[MAP * MAP + at]
		const win = 4 * Math.floor(Math.sqrt(this.last.w * this.last.h))
		const x0 = this.last.x + Math.trunc((this.last.w - win) / 2)
		const y0 = this.last.y + Math.trunc((this.last.h - win) / 2)
		const box = {
			x: Math.floor((cx - w / 2) * win + x0), y: Math.floor((cy - h / 2) * win + y0),
			w: Math.floor(w * win), h: Math.floor(h * win)
		}
		// A box of no size cannot be cropped next frame; hold the last one and report no confidence.
		if (box.w < 2 || box.h < 2) return { box: { ...this.last }, score: 0 }
		this.last = box
		return { box: { ...box }, score: best }
	}
}
