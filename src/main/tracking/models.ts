import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { InferenceSession } from 'onnxruntime-node'

/**
 * The vision models, found and loaded once.
 *
 * They are fetched into vendor/models by scripts/fetch-models.mjs and shipped
 * as `models/` beside the app's resources, the way FFmpeg is. onnxruntime is
 * imported lazily: it is a native module, and nothing should pay for loading it
 * until a track is actually asked for.
 */

export type ModelName = 'yunet' | 'sface' | 'vittrack'

export function getModelsDir(): string {
	const override = process.env.FRAMEFLOW_MODELS_DIR
	if (override && existsSync(override)) return override
	if (process.resourcesPath) {
		const packaged = join(process.resourcesPath, 'models')
		if (existsSync(packaged)) return packaged
	}
	let dir = process.cwd()
	for (let i = 0; i < 8; i++) {
		const candidate = join(dir, 'vendor', 'models')
		if (existsSync(candidate)) return candidate
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	throw new Error('Tracking models not found. Run `node scripts/fetch-models.mjs` (npm install does this automatically).')
}

const sessions = new Map<ModelName, Promise<InferenceSession>>()

export async function ort() {
	return await import('onnxruntime-node')
}

export function modelSession(name: ModelName): Promise<InferenceSession> {
	let session = sessions.get(name)
	if (!session) {
		session = (async () => {
			const { InferenceSession } = await ort()
			// Level 3 = errors only: the models carry harmless export warnings.
			return InferenceSession.create(join(getModelsDir(), `${name}.onnx`), { logSeverityLevel: 3 })
		})()
		sessions.set(name, session)
		session.catch(() => sessions.delete(name))
	}
	return session
}
