import { similarity, warpToTensor, type Frame } from './image'
import { modelSession, ort } from './models'

/**
 * SFace (OpenCV Zoo, Apache-2.0): turns a face into 128 numbers that are close
 * for the same person and far apart for different people. Used only to say
 * "these two short tracks are the same person", never to say who anyone is.
 *
 * A port of OpenCV's FaceRecognizerSF: the face is rotated and scaled so its
 * five landmarks sit where the model expects them (112 × 112), then embedded.
 */

const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]]

/** A unit-length embedding of the face whose landmarks are given (x,y pairs, frame pixels). */
export async function embedFace(frame: Frame, landmarks: readonly number[]): Promise<Float32Array> {
	const session = await modelSession('sface')
	const { Tensor } = await ort()
	const src = [0, 1, 2, 3, 4].map((n) => [landmarks[n * 2], landmarks[n * 2 + 1]])
	const aligned = warpToTensor(frame, similarity(src, TEMPLATE), 112, 112, { rgb: true })
	const out = await session.run({ data: new Tensor('float32', aligned, [1, 3, 112, 112]) })
	const v = Float32Array.from(out.fc1.data as Float32Array)
	let norm = 0
	for (const x of v) norm += x * x
	norm = Math.sqrt(norm) || 1
	for (let i = 0; i < v.length; i++) v[i] /= norm
	return v
}
