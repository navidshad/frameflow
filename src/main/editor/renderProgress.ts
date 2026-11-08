import type { RenderStepInfo } from '@shared/types'

/**
 * What an export is doing, in steps, and how long it has left.
 *
 * The bar used to be a fixed split (the first 15% for motion layers, then the
 * regions to 96%), which said nothing about time: on a 4K project one percent
 * of the motion stage took minutes while the same percent of another stage took
 * seconds. Here every step carries an estimate of its own duration, the bar is
 * the share of the estimated total that is done, and the time left is measured
 * once a step is under way and estimated before it.
 *
 * Pure (the clock is a parameter), so it is tested without a render.
 */

export interface StepPlan {
	id: string
	label: string
	/** Estimated seconds the step takes. 0 for one that is already done (cached). */
	estSec: number
}

interface StepState {
	plan: StepPlan
	state: RenderStepInfo['state']
	fraction: number
	startedAt?: number
	detail?: string
}

export interface RenderSnapshot {
	steps: RenderStepInfo[]
	/** 0-100, the share of the estimated total that is done. */
	percent: number
	/** Seconds left, or null before there is anything to base it on. */
	etaSec: number | null
	elapsedSec: number
}

/** A step this short still counts for something on the bar. */
const MIN_WEIGHT_SEC = 0.5
/** Measure a step's pace only once it has run this long and got this far; before that, the estimate. */
const MEASURE_AFTER_SEC = 6
const MEASURE_AFTER_FRACTION = 0.03

export class RenderTracker {
	private readonly steps: StepState[]
	private readonly startedAt: number

	constructor(plans: StepPlan[], private readonly now: () => number = Date.now) {
		this.steps = plans.map((plan) => ({ plan, state: 'pending' as const, fraction: 0 }))
		this.startedAt = now()
	}

	private find(id: string): StepState | undefined {
		return this.steps.find((s) => s.plan.id === id)
	}

	/** Start a step. Any earlier step left open is finished: steps run in order. */
	begin(id: string, detail?: string): void {
		const step = this.find(id)
		if (!step) return
		for (const earlier of this.steps) {
			if (earlier === step) break
			if (earlier.state !== 'done') { earlier.state = 'done'; earlier.fraction = 1 }
		}
		if (step.state === 'pending') { step.state = 'active'; step.startedAt = this.now() }
		if (detail !== undefined) step.detail = detail
	}

	progress(id: string, fraction: number, detail?: string): void {
		const step = this.find(id)
		if (!step) return
		if (step.state === 'pending') this.begin(id)
		if (step.state === 'done') return
		step.fraction = Math.min(1, Math.max(step.fraction, fraction)) // never backwards
		if (detail !== undefined) step.detail = detail
	}

	complete(id: string, detail?: string): void {
		const step = this.find(id)
		if (!step) return
		if (step.state === 'pending') this.begin(id)
		step.state = 'done'
		step.fraction = 1
		if (detail !== undefined) step.detail = detail
	}

	/** Every step done: the render landed. */
	finishAll(): void {
		for (const step of this.steps) { step.state = 'done'; step.fraction = 1 }
	}

	snapshot(): RenderSnapshot {
		const now = this.now()
		const weight = (s: StepState) => Math.max(s.plan.estSec, MIN_WEIGHT_SEC)
		const total = this.steps.reduce((sum, s) => sum + weight(s), 0) || 1
		const doneWeight = this.steps.reduce((sum, s) => sum + weight(s) * s.fraction, 0)

		let eta = 0
		for (const s of this.steps) {
			if (s.state === 'done') continue
			const remaining = 1 - s.fraction
			const elapsed = s.startedAt === undefined ? 0 : (now - s.startedAt) / 1000
			const measured = s.state === 'active' && elapsed >= MEASURE_AFTER_SEC && s.fraction >= MEASURE_AFTER_FRACTION
			eta += measured ? (elapsed * remaining) / s.fraction : s.plan.estSec * remaining
		}

		return {
			steps: this.steps.map((s) => ({ id: s.plan.id, label: s.plan.label, state: s.state, detail: s.detail })),
			percent: Math.min(100, (doneWeight / total) * 100),
			etaSec: Math.round(eta),
			elapsedSec: Math.round((now - this.startedAt) / 1000)
		}
	}
}

// ===== Estimates =====
// Measured on an M1 Pro (see the notes beside each); they set the weight of a
// step before it runs and are replaced by the step's own pace once it is going.

const UHD_PIXELS = 3840 * 2160

/**
 * Drawing motion layers: a frame is about 11 ms plus 15 ns a pixel (17 ms at
 * 480p, 137 at 4K), a fifth less with the capture overlapped with the write,
 * and 4K draws two clips at once for a gain of about a fifth where small
 * frames draw four for a gain of about a third.
 */
export const estimateMotionSec = (frames: number, pixels: number): number =>
	(frames * (11 + 1.5e-5 * pixels) * 0.8) / (pixels > 1920 * 1080 ? 1.2 : 3) / 1000

/** Regions, three at a time on a Mac: about 0.2 s per timeline second at 4K, less at smaller sizes. */
export const estimateRegionsSec = (timelineSec: number, pixels: number): number =>
	timelineSec * (0.08 + 0.12 * Math.min(1, pixels / UHD_PIXELS))

/** Stream-copy join of the regions, and the sound encoded once. */
export const estimateJoinSec = (timelineSec: number): number => 2 + timelineSec * 0.005

/** Burning titles and captions re-encodes the file: 2.9 s per 10 s of 4K at x264 veryfast. */
export const estimateBurnSec = (timelineSec: number, pixels: number): number =>
	timelineSec * (0.05 + 0.24 * Math.min(1, pixels / UHD_PIXELS))

/** A pass over the sound only. */
export const estimateLoudnessSec = (timelineSec: number): number => 2 + timelineSec * 0.03

/** A second transcode of the finished picture. */
export const estimateDeliverySec = (timelineSec: number): number => timelineSec * 0.15
