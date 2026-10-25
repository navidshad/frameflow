import { deflateSync } from 'zlib'

/**
 * Evidence for "drawing the same frame twice gave different pixels".
 *
 * The probe knew THAT two renders differed; an agent needs WHERE and HOW MUCH
 * to fix it. A few faint pixels along an edge is a sub-pixel transform near
 * rest (round to whole pixels); a whole block that moved is state carried over
 * from the previous seek. Both read at a glance from the box, the numbers and
 * a picture of the two renders side by side.
 *
 * Pure Node (no Electron) so it is tested without a window. Frames are the
 * capture's premultiplied BGRA, width × height × 4.
 */

export interface FrameDifference {
	/** The smallest box holding every differing pixel, in the SEQUENCE's pixels. */
	box: { x: number; y: number; width: number; height: number }
	/** How many pixels differ, at the probe's size. */
	pixels: number
	/** Share of the probed frame that differs, 0–1. */
	share: number
	/** Largest change in any one channel, 0–255. */
	maxDelta: number
	/** Average of each differing pixel's largest channel change, 0–255. */
	meanDelta: number
	/** The probe drew at this many sequence pixels per probe pixel. */
	scale: number
	/** Faint differences hugging edges: what a sub-pixel position near rest gives. */
	looksSubPixel: boolean
	/** PNG, base64: first render | second render | differing pixels in red. */
	image?: string
}

interface Size { width: number; height: number }

/** Compare two renders of one instant. `scale` maps probe pixels to the sequence's. */
export function compareFrames(a: Buffer, b: Buffer, size: Size, scale = 1): FrameDifference {
	const { width, height } = size
	let minX = width, minY = height, maxX = -1, maxY = -1
	let pixels = 0, maxDelta = 0, sum = 0
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4
			const d = Math.max(
				Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]),
				Math.abs(a[o + 2] - b[o + 2]), Math.abs(a[o + 3] - b[o + 3])
			)
			if (!d) continue
			pixels++
			sum += d
			if (d > maxDelta) maxDelta = d
			if (x < minX) minX = x
			if (x > maxX) maxX = x
			if (y < minY) minY = y
			if (y > maxY) maxY = y
		}
	}
	const boxW = maxX < 0 ? 0 : maxX - minX + 1
	const boxH = maxY < 0 ? 0 : maxY - minY + 1
	const meanDelta = pixels ? sum / pixels : 0
	// An edge that shifted by a fraction of a pixel changes a band one or two
	// pixels thick, and only partly: few pixels for the box they span, and faint.
	const thin = pixels <= 3 * (boxW + boxH)
	const s = scale > 0 ? scale : 1
	return {
		box: maxX < 0
			? { x: 0, y: 0, width: 0, height: 0 }
			: { x: Math.round(minX * s), y: Math.round(minY * s), width: Math.round(boxW * s), height: Math.round(boxH * s) },
		pixels,
		share: pixels / Math.max(1, width * height),
		maxDelta,
		meanDelta: Math.round(meanDelta * 10) / 10,
		scale: Math.round(s * 1000) / 1000,
		looksSubPixel: pixels > 0 && meanDelta < 96 && thin
	}
}

const PAD = 8
const MIN_CROP = 24
const MAX_PANEL = 480
const GAP = 4

/**
 * One PNG an agent can look at: the area around the difference, drawn the
 * first time (left), the second time (middle), and the pixels that differ in
 * red over a dimmed copy (right). Small areas are enlarged with hard pixels,
 * so a one-pixel seam is still visible.
 */
export function evidenceImage(a: Buffer, b: Buffer, size: Size, diff: FrameDifference): string {
	const { width, height } = size
	// Back to probe pixels: the box is reported in the sequence's.
	const s = diff.scale || 1
	let x0 = Math.floor(diff.box.x / s) - PAD
	let y0 = Math.floor(diff.box.y / s) - PAD
	let x1 = Math.ceil((diff.box.x + diff.box.width) / s) + PAD
	let y1 = Math.ceil((diff.box.y + diff.box.height) / s) + PAD
	const grow = (lo: number, hi: number, limit: number): [number, number] => {
		if (hi - lo >= MIN_CROP) return [Math.max(0, lo), Math.min(limit, hi)]
		const mid = (lo + hi) / 2
		return [Math.max(0, Math.floor(mid - MIN_CROP / 2)), Math.min(limit, Math.ceil(mid + MIN_CROP / 2))]
	}
	;[x0, x1] = grow(x0, x1, width)
	;[y0, y1] = grow(y0, y1, height)
	const cw = Math.max(1, x1 - x0)
	const ch = Math.max(1, y1 - y0)
	const zoom = Math.max(1, Math.min(8, Math.floor(MAX_PANEL / Math.max(cw, ch))))
	const pw = cw * zoom
	const ph = ch * zoom
	const outW = pw * 3 + GAP * 2
	const rgba = Buffer.alloc(outW * ph * 4, 0)
	for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255

	// Premultiplied BGRA over a mid grey, so transparent areas read as background.
	const BG = 96
	const shown = (src: Buffer, o: number): [number, number, number] => {
		const inv = (255 - src[o + 3]) / 255
		return [src[o + 2] + BG * inv, src[o + 1] + BG * inv, src[o] + BG * inv]
	}
	const put = (px: number, py: number, rgb: [number, number, number]) => {
		const o = (py * outW + px) * 4
		rgba[o] = Math.min(255, Math.round(rgb[0]))
		rgba[o + 1] = Math.min(255, Math.round(rgb[1]))
		rgba[o + 2] = Math.min(255, Math.round(rgb[2]))
	}
	for (let y = 0; y < ph; y++) {
		const sy = y0 + Math.floor(y / zoom)
		for (let x = 0; x < pw; x++) {
			const sx = x0 + Math.floor(x / zoom)
			const o = (sy * width + sx) * 4
			const first = shown(a, o)
			put(x, y, first)
			put(pw + GAP + x, y, shown(b, o))
			const d = Math.max(
				Math.abs(a[o] - b[o]), Math.abs(a[o + 1] - b[o + 1]),
				Math.abs(a[o + 2] - b[o + 2]), Math.abs(a[o + 3] - b[o + 3])
			)
			const grey = (first[0] + first[1] + first[2]) / 3 * 0.35
			// Any difference shows; a bigger one is brighter.
			put(2 * (pw + GAP) + x, y, d ? [160 + 95 * (d / 255), 0, 0] : [grey, grey, grey])
		}
	}
	return encodePng(rgba, outW, ph).toString('base64')
}

// ===== PNG =====

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table[n] = c >>> 0
	}
	return table
})()

function crc32(buf: Buffer): number {
	let c = 0xffffffff
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length)
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(body))
	return Buffer.concat([length, body, crc])
}

/** RGBA, 8 bits a channel, no filtering: small images, so simple wins. */
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
	const header = Buffer.alloc(13)
	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header[8] = 8 // bit depth
	header[9] = 6 // RGBA
	const raw = Buffer.alloc((width * 4 + 1) * height)
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	])
}

/**
 * Two draws that differ by at most 2/255 in a few dozen pixels are the GPU
 * re-rasterising an anti-aliased edge (a rounded corner or a soft shadow
 * beside something that repainted), not a page whose picture depends on an
 * earlier seek: that moves or changes things by far more. Invisible, so it
 * passes, where a sub-pixel position near rest (deltas of tens) still fails.
 */
export const NOISE_MAX_DELTA = 2
export const NOISE_MAX_PIXELS = 64

export function isRasterNoise(diff: Pick<FrameDifference, 'maxDelta' | 'pixels'>): boolean {
	return diff.pixels > 0 && diff.maxDelta <= NOISE_MAX_DELTA && diff.pixels <= NOISE_MAX_PIXELS
}
