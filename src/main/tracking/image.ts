/**
 * The few image operations tracking needs, on raw frames, with no native
 * library: a crop-and-resize, an affine warp, a small grey copy and a
 * whole-picture shift estimate.
 *
 * A frame is `bgr24` exactly as ffmpeg writes it: three bytes a pixel, blue
 * first. BGR is kept because the models were trained through OpenCV, which
 * feeds them that order; each caller says which order its model wants.
 *
 * Sampling is bilinear with half-pixel centres, which is what OpenCV's
 * INTER_LINEAR does, so a port can be checked number for number against it.
 */

export interface Frame {
	data: Uint8Array
	width: number
	height: number
}

export interface TensorOptions {
	/** Multiplied in first: 1 keeps 0–255, 1/255 gives 0–1. */
	scale?: number
	/** Per OUTPUT channel, applied after `scale`: (v - mean) / std. */
	mean?: readonly [number, number, number]
	std?: readonly [number, number, number]
	/** Output channel order RGB instead of the frame's own BGR. */
	rgb?: boolean
}

/** A whole-pixel window of the frame; everything outside it reads as black. */
export interface Window {
	x: number
	y: number
	w: number
	h: number
	/** The part of the window that holds real pixels. Defaults to its overlap with the frame. */
	valid?: { x0: number; y0: number; x1: number; y1: number }
}

const finish = (v: number, c: number, o: TensorOptions): number => {
	const s = v * (o.scale ?? 1)
	return o.mean && o.std ? (s - o.mean[c]) / o.std[c] : s
}

/**
 * `win` of the frame, resized to outW × outH, as a planar float tensor (CHW).
 * `padW`/`padH` make the tensor larger than the picture, leaving the rest black
 * (the face detector wants a fixed square).
 */
export function windowToTensor(
	frame: Frame, win: Window, outW: number, outH: number, options: TensorOptions = {}, padW = outW, padH = outH
): Float32Array {
	const { data, width, height } = frame
	const v = win.valid ?? { x0: Math.max(0, win.x), y0: Math.max(0, win.y), x1: Math.min(width, win.x + win.w), y1: Math.min(height, win.y + win.h) }
	const out = new Float32Array(3 * padW * padH)
	const plane = padW * padH
	if (options.mean && options.std) {
		// Padding is black BEFORE normalising, as it is when OpenCV pads the crop.
		for (let c = 0; c < 3; c++) out.fill(finish(0, c, options), c * plane, (c + 1) * plane)
	}
	const sx = win.w / outW
	const sy = win.h / outH
	const px = (x: number, y: number, ch: number): number => {
		const fx = win.x + x
		const fy = win.y + y
		if (fx < v.x0 || fx >= v.x1 || fy < v.y0 || fy >= v.y1) return 0
		return data[(fy * width + fx) * 3 + ch]
	}
	for (let j = 0; j < outH; j++) {
		const fy = Math.max(0, (j + 0.5) * sy - 0.5)
		const y0 = Math.min(win.h - 1, Math.floor(fy))
		const y1 = Math.min(win.h - 1, y0 + 1)
		const wy = fy - y0
		for (let i = 0; i < outW; i++) {
			const fx = Math.max(0, (i + 0.5) * sx - 0.5)
			const x0 = Math.min(win.w - 1, Math.floor(fx))
			const x1 = Math.min(win.w - 1, x0 + 1)
			const wx = fx - x0
			for (let c = 0; c < 3; c++) {
				const ch = options.rgb ? 2 - c : c
				const top = px(x0, y0, ch) * (1 - wx) + px(x1, y0, ch) * wx
				const bottom = px(x0, y1, ch) * (1 - wx) + px(x1, y1, ch) * wx
				out[c * plane + j * padW + i] = finish(top * (1 - wy) + bottom * wy, c, options)
			}
		}
	}
	return out
}

/** A 2×3 matrix taking SOURCE points to OUTPUT points, as OpenCV's warpAffine is given. */
export type Affine = [number, number, number, number, number, number]

/** The frame warped by `m` into outW × outH (black outside), as a CHW tensor. */
export function warpToTensor(frame: Frame, m: Affine, outW: number, outH: number, options: TensorOptions = {}): Float32Array {
	const { data, width, height } = frame
	const [a, b, tx, c, d, ty] = m
	const det = a * d - b * c
	const ia = d / det, ib = -b / det, ic = -c / det, id = a / det
	const out = new Float32Array(3 * outW * outH)
	const plane = outW * outH
	const at = (x: number, y: number, ch: number): number =>
		x < 0 || y < 0 || x >= width || y >= height ? 0 : data[(y * width + x) * 3 + ch]
	for (let j = 0; j < outH; j++) {
		for (let i = 0; i < outW; i++) {
			const sx = ia * (i - tx) + ib * (j - ty)
			const sy = ic * (i - tx) + id * (j - ty)
			const x0 = Math.floor(sx), y0 = Math.floor(sy)
			const wx = sx - x0, wy = sy - y0
			for (let ch = 0; ch < 3; ch++) {
				const src = options.rgb ? 2 - ch : ch
				const top = at(x0, y0, src) * (1 - wx) + at(x0 + 1, y0, src) * wx
				const bottom = at(x0, y0 + 1, src) * (1 - wx) + at(x0 + 1, y0 + 1, src) * wx
				out[ch * plane + j * outW + i] = finish(top * (1 - wy) + bottom * wy, ch, options)
			}
		}
	}
	return out
}

/**
 * The least-squares similarity (rotate, scale, move — no shear, no mirror)
 * taking `src` points onto `dst` points. In 2D it has a closed form, which is
 * the same answer as the SVD route the reference takes.
 */
export function similarity(src: readonly number[][], dst: readonly number[][]): Affine {
	const n = src.length
	const mean = (pts: readonly number[][], k: number) => pts.reduce((s, p) => s + p[k], 0) / n
	const sx = mean(src, 0), sy = mean(src, 1), dx = mean(dst, 0), dy = mean(dst, 1)
	let dot = 0, cross = 0, norm = 0
	for (let i = 0; i < n; i++) {
		const ux = src[i][0] - sx, uy = src[i][1] - sy
		const vx = dst[i][0] - dx, vy = dst[i][1] - dy
		dot += ux * vx + uy * vy
		cross += ux * vy - uy * vx
		norm += ux * ux + uy * uy
	}
	const a = dot / norm, b = cross / norm
	return [a, -b, dx - (a * sx - b * sy), b, a, dy - (b * sx + a * sy)]
}

export interface Grey {
	data: Float32Array
	width: number
	height: number
}

/** A small grey copy (block average), for measuring how the whole picture moved. */
export function greyThumb(frame: Frame, outW: number): Grey {
	const outH = Math.max(1, Math.round((frame.height * outW) / frame.width))
	const bx = frame.width / outW, by = frame.height / outH
	const out = new Float32Array(outW * outH)
	for (let j = 0; j < outH; j++) {
		const y0 = Math.floor(j * by), y1 = Math.max(y0 + 1, Math.floor((j + 1) * by))
		for (let i = 0; i < outW; i++) {
			const x0 = Math.floor(i * bx), x1 = Math.max(x0 + 1, Math.floor((i + 1) * bx))
			let sum = 0, count = 0
			// Every other pixel is plenty for an average and halves the work.
			for (let y = y0; y < y1; y += 2) {
				for (let x = x0; x < x1; x += 2) {
					const p = (y * frame.width + x) * 3
					sum += frame.data[p] + frame.data[p + 1] * 2 + frame.data[p + 2]
					count++
				}
			}
			out[j * outW + i] = sum / (count * 4)
		}
	}
	return { data: out, width: outW, height: outH }
}

/**
 * How far the picture's content moved from `prev` to `cur`, in thumb pixels:
 * the shift with the smallest mean difference over the area the two share. A
 * camera swing moves every face at once; knowing it keeps a face's track from
 * breaking (or jumping to a neighbour) when the camera, not the person, moved.
 */
export function pictureShift(prev: Grey, cur: Grey, maxShift = 12): { dx: number; dy: number } {
	const { width: w, height: h } = cur
	let best = { dx: 0, dy: 0 }, bestCost = Infinity
	for (let dy = -maxShift; dy <= maxShift; dy++) {
		for (let dx = -maxShift; dx <= maxShift; dx++) {
			let sum = 0, count = 0
			for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y += 2) {
				for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x += 2) {
					sum += Math.abs(cur.data[(y + dy) * w + x + dx] - prev.data[y * w + x])
					count++
				}
			}
			// A tiny pull towards "did not move" settles flat pictures on zero.
			const cost = sum / count + 0.002 * (Math.abs(dx) + Math.abs(dy))
			if (cost < bestCost) { bestCost = cost; best = { dx, dy } }
		}
	}
	return best
}

/** A window of the frame resized to outW × outH, as a frame of its own. */
export function resizeWindow(frame: Frame, win: Window, outW: number, outH: number): Frame {
	const t = windowToTensor(frame, win, outW, outH)
	const plane = outW * outH
	const data = new Uint8Array(plane * 3)
	for (let p = 0; p < plane; p++) {
		data[p * 3] = t[p]
		data[p * 3 + 1] = t[plane + p]
		data[p * 3 + 2] = t[2 * plane + p]
	}
	return { data, width: outW, height: outH }
}

/** The frame as a binary PPM, a format with no compression that ffmpeg reads. */
export function frameToPpm(frame: Frame): Buffer {
	const header = Buffer.from(`P6\n${frame.width} ${frame.height}\n255\n`, 'ascii')
	const body = Buffer.alloc(frame.width * frame.height * 3)
	for (let p = 0; p < frame.width * frame.height; p++) {
		body[p * 3] = frame.data[p * 3 + 2]
		body[p * 3 + 1] = frame.data[p * 3 + 1]
		body[p * 3 + 2] = frame.data[p * 3]
	}
	return Buffer.concat([header, body])
}

/** Draws a rectangle outline into the frame, in place. */
export function drawBox(frame: Frame, box: { x: number; y: number; w: number; h: number }, bgr: readonly [number, number, number], thickness = 3): void {
	const x0 = Math.round(box.x), y0 = Math.round(box.y), x1 = Math.round(box.x + box.w), y1 = Math.round(box.y + box.h)
	const put = (x: number, y: number) => {
		if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return
		const p = (y * frame.width + x) * 3
		frame.data[p] = bgr[0]; frame.data[p + 1] = bgr[1]; frame.data[p + 2] = bgr[2]
	}
	for (let t = 0; t < thickness; t++) {
		for (let x = x0 - t; x <= x1 + t; x++) { put(x, y0 - t); put(x, y1 + t) }
		for (let y = y0 - t; y <= y1 + t; y++) { put(x0 - t, y); put(x1 + t, y) }
	}
}

/**
 * How crisp a region is: the mean step between neighbouring pixels. A face
 * smeared by a camera swing scores low, which is how the clearest frame of a
 * person is chosen to show for them.
 */
export function sharpness(frame: Frame, box: { x: number; y: number; w: number; h: number }): number {
	const x0 = Math.max(0, Math.round(box.x)), y0 = Math.max(0, Math.round(box.y))
	const x1 = Math.min(frame.width - 1, Math.round(box.x + box.w)), y1 = Math.min(frame.height - 1, Math.round(box.y + box.h))
	let sum = 0, count = 0
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const p = (y * frame.width + x) * 3 + 1
			sum += Math.abs(frame.data[p + 3] - frame.data[p]) + Math.abs(frame.data[p + frame.width * 3] - frame.data[p])
			count++
		}
	}
	return count ? sum / count : 0
}
