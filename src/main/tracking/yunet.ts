import { windowToTensor, type Frame } from './image'
import { modelSession, ort } from './models'

/**
 * YuNet face detector (OpenCV Zoo, MIT). Finds every face in a frame with its
 * five landmarks (eyes, nose, mouth corners), which the face matcher aligns by.
 *
 * A port of OpenCV's FaceDetectorYN pre- and post-processing. The ONNX graph is
 * fixed at 640 × 640, so the frame is scaled to fit and padded black; boxes
 * come back in the FRAME's own pixels.
 */

export interface Face {
	x: number
	y: number
	w: number
	h: number
	/** Right eye, left eye, nose tip, right mouth corner, left mouth corner: x,y pairs in frame pixels. */
	landmarks: number[]
	score: number
}

const SIZE = 640
const STRIDES = [8, 16, 32]

const iou = (a: Face, b: Face): number => {
	const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y)
	const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h)
	const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
	return inter / (a.w * a.h + b.w * b.h - inter || 1)
}

/** Keeps the best-scoring face of every overlapping cluster. */
export function suppress(faces: Face[], overlap: number): Face[] {
	const kept: Face[] = []
	for (const face of [...faces].sort((a, b) => b.score - a.score)) {
		if (kept.every((k) => iou(k, face) <= overlap)) kept.push(face)
	}
	return kept
}

export async function detectFaces(frame: Frame, options: { minScore?: number; overlap?: number } = {}): Promise<Face[]> {
	const minScore = options.minScore ?? 0.6
	const session = await modelSession('yunet')
	const { Tensor } = await ort()
	const fit = SIZE / Math.max(frame.width, frame.height)
	const w = Math.round(frame.width * fit), h = Math.round(frame.height * fit)
	const input = windowToTensor(frame, { x: 0, y: 0, w: frame.width, h: frame.height }, w, h, {}, SIZE, SIZE)
	const out = await session.run({ input: new Tensor('float32', input, [1, 3, SIZE, SIZE]) })
	const faces: Face[] = []
	for (const stride of STRIDES) {
		const cols = SIZE / stride, rows = SIZE / stride
		const cls = out[`cls_${stride}`].data as Float32Array
		const obj = out[`obj_${stride}`].data as Float32Array
		const box = out[`bbox_${stride}`].data as Float32Array
		const kps = out[`kps_${stride}`].data as Float32Array
		for (let r = 0; r < rows; r++) {
			for (let c = 0; c < cols; c++) {
				const i = r * cols + c
				const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])))
				if (score < minScore) continue
				const cx = (c + box[i * 4]) * stride, cy = (r + box[i * 4 + 1]) * stride
				const bw = Math.exp(box[i * 4 + 2]) * stride, bh = Math.exp(box[i * 4 + 3]) * stride
				const landmarks: number[] = []
				for (let n = 0; n < 5; n++) {
					landmarks.push(((kps[i * 10 + 2 * n] + c) * stride) / fit, ((kps[i * 10 + 2 * n + 1] + r) * stride) / fit)
				}
				faces.push({ x: (cx - bw / 2) / fit, y: (cy - bh / 2) / fit, w: bw / fit, h: bh / fit, landmarks, score })
			}
		}
	}
	return suppress(faces, options.overlap ?? 0.3)
}
