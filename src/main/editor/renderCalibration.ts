import fs from 'fs'
import path from 'path'
import type { StepActual } from './renderProgress'

/**
 * What this machine has measured about its own exports.
 *
 * The estimates in renderProgress.ts were measured on one Mac with small test
 * projects. On a 4K project of two hundred short cuts from a cloud drive the
 * segment step took about nine times what they said, and the time left was
 * wrong by the same factor. A table written on one machine cannot be right on
 * another, so each step keeps a factor (real time over first-guess time), learned
 * from the exports that really ran, and the next estimate is scaled by it.
 *
 * Pure apart from the two file functions, which take their path, so it is
 * tested without Electron.
 */

export type Calibration = Record<string, { factor: number; runs: number }>

/** Beyond these a single odd export (a paused laptop, a cloud file arriving) cannot swing the estimates. */
const MIN_FACTOR = 0.25
const MAX_FACTOR = 12
/** How much a new export counts against what was learned before. */
const NEW_WEIGHT = 0.5

const clamp = (n: number) => Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, n))

/** The estimate for a step, scaled by what has been measured for it. `calibrated` says whether anything was. */
export function calibrate(calibration: Calibration, id: string, estSec: number): { estSec: number; calibrated: boolean } {
	const entry = calibration[id]
	return entry ? { estSec: estSec * entry.factor, calibrated: true } : { estSec, calibrated: false }
}

/** Fold what an export really took into the factors. The first run sets a step's factor; later ones move it halfway. */
export function recordActuals(calibration: Calibration, actuals: StepActual[]): Calibration {
	const next: Calibration = { ...calibration }
	for (const a of actuals) {
		const ratio = clamp(a.actualSec / a.rawEstSec)
		const prev = next[a.id]
		next[a.id] = prev
			? { factor: clamp(prev.factor * (1 - NEW_WEIGHT) + ratio * NEW_WEIGHT), runs: prev.runs + 1 }
			: { factor: ratio, runs: 1 }
	}
	return next
}

export function loadCalibration(file: string): Calibration {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
		const out: Calibration = {}
		for (const [id, v] of Object.entries(parsed ?? {})) {
			const f = (v as any)?.factor
			if (typeof f === 'number' && Number.isFinite(f) && f > 0) out[id] = { factor: clamp(f), runs: Number((v as any).runs) || 1 }
		}
		return out
	} catch {
		return {} // no file yet, or one that is not ours: start from the first-guess table
	}
}

export function saveCalibration(file: string, calibration: Calibration): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, JSON.stringify(calibration, null, 2))
	} catch (error) {
		console.error('[render] Could not save the time estimates:', error)
	}
}
